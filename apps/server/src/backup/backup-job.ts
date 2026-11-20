import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";
import {
  backupManifestSchema,
  type AdminBackupStartParams,
  type BackupManifest,
  type BackupRun,
  type BackupRunStats,
  type BackupS3Target,
} from "@beaconsgg/protocol-types";
import type { PoolClient } from "pg";
import { to as copyTo } from "pg-copy-streams";
import { blobKey, MEDIA_CACHE_CONTROL, type MediaBlobStore } from "../media/media-blob";
import { PROCESS_STARTED_AT } from "../server-identity";
import { SETTING_SPECS } from "../settings/registry";
import type { SettingsService } from "../settings/settings.service";
import { encodeValue } from "../stores/settings-store";
import type { BackupBucket } from "./backup-target";
import {
  discoverTables,
  readSchemaVersion,
  withRunClient,
  type BackupTableShape,
} from "./backup-db";
import {
  copyVerifiedFiles,
  fileSkipped,
  type FileDeps,
  type MediaFault,
  type MediaRow,
} from "./backup-files";
import type { BackupRunPatch } from "../stores/backup-run-store";
import type { DbConnections } from "../stores/store.factory";

/**
 * How old a lock must be before the snapshot. Setting the lock does not wait for a request already
 * in flight, so this long is what lets those writes land without tracking them.
 */
export const LOCK_SETTLE_MS = 15_000;

/**
 * The manifest format this server writes and reads. The format is the server's own version, not part
 * of the wire: a restore refuses any other format, and a console reads each manifest's `format`.
 */
export const MANIFEST_FORMAT = 1;

/** The schema's limits on what a run may report. */
const MAX_WARNINGS = 100;
const MAX_WARNING_LENGTH = 500;
export const MAX_ERROR_LENGTH = 2000;

/** How often run progress is written. The terminal write always lands the final counts. */
const PROGRESS_FLUSH_MS = 5000;

/**
 * Attempts at a run's closing write. A row left `running` would block every later start until a
 * restart, or until a start notices no job behind it, so this is worth a few seconds.
 */
const FINAL_WRITE_ATTEMPTS = 5;
const FINAL_WRITE_RETRY_MS = 1000;

/** The strings a stored message must never contain. */
export function targetSecrets(target: BackupS3Target): string[] {
  return [target.accessKeyId, target.secretAccessKey];
}

/** Keep a stored message to what the run row may hold, with any credential scrubbed out of it. */
export function safeRunError(err: unknown, secrets: readonly string[]): string {
  const raw = err instanceof Error && err.message !== "" ? err.message : String(err);
  const scrubbed = secrets.reduce(
    (message, secret) => message.split(secret).join("[redacted]"),
    raw,
  );
  return scrubbed.slice(0, MAX_ERROR_LENGTH);
}

/** The durable record of a run in progress: its counters and warnings, written every few seconds. */
export class RunProgress {
  readonly stats: BackupRunStats;
  private readonly warnings: string[] = [];
  private dropped = 0;
  private lastFlush = 0;
  /** {@link warned} as of the last write that carried the list, so an unchanged list is not resent. */
  private savedWarned = 0;
  private writing: Promise<void> = Promise.resolve();

  constructor(
    initial: BackupRunStats,
    private readonly save: (patch: BackupRunPatch) => Promise<void>,
    private readonly onSaveError: (err: unknown) => void,
    private readonly now: () => number,
    private readonly pause: (ms: number) => Promise<void>,
  ) {
    this.stats = { ...initial };
  }

  /** Add a warning, capped so one server with thousands of missing files cannot overflow the row. */
  warn(message: string): void {
    if (this.warnings.length < MAX_WARNINGS - 1) {
      this.warnings.push(message.slice(0, MAX_WARNING_LENGTH));
    } else {
      this.dropped += 1;
    }
  }

  /** Warnings so far, the dropped ones included: it only ever grows, so it also tells a change. */
  private get warned(): number {
    return this.warnings.length + this.dropped;
  }

  private warningList(): string[] {
    return this.dropped > 0
      ? [...this.warnings, `...and ${this.dropped} more warnings`]
      : [...this.warnings];
  }

  /** The counters, and the warnings when the row is behind on them. */
  private current(): BackupRunPatch {
    return {
      stats: { ...this.stats },
      ...(this.warned !== this.savedWarned ? { warnings: this.warningList() } : {}),
    };
  }

  /** One write; the list only counts as saved once it has landed. */
  private async write(patch: BackupRunPatch, warned: number): Promise<void> {
    await this.save(patch);
    if (patch.warnings !== undefined) this.savedWarned = warned;
  }

  /**
   * Queue a progress write, unless one went out within the last few seconds. Never awaited on the
   * hot path: while a run holds its snapshot, a pool of one connection has none spare to write this
   * with, so the write has to be able to wait for the snapshot rather than the other way round.
   */
  tick(): void {
    if (this.now() - this.lastFlush < PROGRESS_FLUSH_MS) return;
    this.lastFlush = this.now();
    this.writing = this.writing
      .then(() => this.write(this.current(), this.warned))
      .catch(this.onSaveError);
  }

  /** Resolves once no progress write is queued, so a run can write the row itself. */
  async settled(): Promise<void> {
    await this.writing;
  }

  /** The closing patch: everything so far plus `patch`, for a run that writes it in a transaction. */
  closing(patch: BackupRunPatch): BackupRunPatch {
    return { stats: { ...this.stats }, warnings: this.warningList(), ...patch };
  }

  /**
   * The closing write: everything so far plus `patch`, retried, and it has landed or been reported
   * when this resolves. Queued progress goes first, so an older write cannot land after this one.
   */
  async finish(patch: BackupRunPatch): Promise<void> {
    await this.writing;
    const closing = { ...this.current(), ...patch };
    for (let attempt = 1; ; attempt += 1) {
      try {
        await this.write(closing, this.warned);
        return;
      } catch (err) {
        if (attempt >= FINAL_WRITE_ATTEMPTS) {
          this.onSaveError(err);
          return;
        }
        await this.pause(FINAL_WRITE_RETRY_MS * attempt);
      }
    }
  }
}

/** What a backup needs from the rest of the server, narrow enough to fake in the suite. */
export interface BackupJobDeps extends FileDeps {
  connections: DbConnections;
  blobs: Pick<MediaBlobStore, "read">;
  settings: Pick<SettingsService, "state" | "all">;
  /** The server's identity: `recoveryPhrase` resolves undefined for an ephemeral one. */
  identity: { account: { did: string }; recoveryPhrase(): Promise<string | undefined> };
  config: { host: string; version: string };
  /** The environment the server booted with, for which settings an operator actually exported. */
  env: NodeJS.ProcessEnv;
  now: () => number;
}

function lockTimestamp(state: { updatedAt?: string }): string {
  return state.updatedAt ?? PROCESS_STARTED_AT;
}

/**
 * Wait out a lock's settling time; returns as soon as the server is unlocked (undefined) or the lock
 * is old enough (its timestamp, so the end of the run can tell whether it held throughout).
 */
export async function settleLock(
  deps: {
    settings: Pick<SettingsService, "state">;
    now: () => number;
    sleep: FileDeps["sleep"];
  },
  signal: AbortSignal,
): Promise<string | undefined> {
  for (;;) {
    const state = deps.settings.state("writeLocked");
    if (!state.value) return undefined;
    const lockedAt = lockTimestamp(state);
    const waitMs = LOCK_SETTLE_MS - (deps.now() - Date.parse(lockedAt));
    if (waitMs <= 0) return lockedAt;
    // Re-checked after the sleep, so a lock lifted and set again during the wait starts over.
    await deps.sleep(waitMs, signal);
  }
}

/** Whether the lock taken at `lockedAt` is still the one in force. */
function lockHeld(deps: BackupJobDeps, lockedAt: string | undefined): boolean {
  if (lockedAt === undefined) return false;
  const state = deps.settings.state("writeLocked");
  return state.value && lockTimestamp(state) === lockedAt;
}

/**
 * Settings the environment supplies and an operator actually exported, as rows of the backup's copy
 * of `settings` (they have no row of their own, so the new server would fall back to its own
 * defaults). A setting nobody exported is left to the new server's default: "revert to defaults"
 * cannot be lost on it, and pinning 40 defaults as admin overrides would stop a later release or a
 * new host's environment from reaching them. The value written is what the environment supplied,
 * the same input `reconcileRuntimeSettings` starts from, so prerequisites re-apply on the new server.
 */
function envOnlySettingRows(
  deps: BackupJobDeps,
  requestedBy: string,
  at: string,
  progress: RunProgress,
): { key: string; value: string; updatedBy: string; updatedAt: string }[] {
  const rows: { key: string; value: string; updatedBy: string; updatedAt: string }[] = [];
  for (const state of deps.settings.all()) {
    if (state.provenance !== "env" || state.envValue === undefined) continue;
    const spec = SETTING_SPECS[state.key];
    if ((deps.env[spec.env] ?? "").trim() === "") continue;
    if (!spec.schema.safeParse(state.envValue).success) {
      // The new server would refuse this row at boot and fall back to its environment anyway.
      progress.warn(`setting ${state.key} from ${spec.env} is not a valid row, so it is left out`);
      continue;
    }
    rows.push({
      key: state.key,
      value: encodeValue(state.envValue),
      updatedBy: requestedBy,
      updatedAt: at,
    });
  }
  return rows;
}

/** The `settings` columns an env-only row carries. */
const ENV_ONLY_COLUMNS = ["key", "value", "updated_by", "updated_at"];

/** The `COPY` statement for one table: the table's rows, and for `settings` the env-only ones too. */
function copyStatement(
  db: Pick<PoolClient, "escapeIdentifier" | "escapeLiteral">,
  table: BackupTableShape,
  extraSettings: ReturnType<typeof envOnlySettingRows>,
): string {
  const columns = table.columns.map((c) => db.escapeIdentifier(c)).join(", ");
  const rows = `SELECT ${columns} FROM ${db.escapeIdentifier(table.name)}`;
  if (table.name !== "settings" || extraSettings.length === 0) {
    return `COPY (${rows}) TO STDOUT`;
  }
  const values = extraSettings
    .map(
      (s) =>
        `(${[s.key, s.value, s.updatedBy, s.updatedAt].map((v) => db.escapeLiteral(v)).join(", ")})`,
    )
    .join(", ");
  // By the discovered columns, with NULL for any this code does not fill, so a column a later
  // migration adds to `settings` cannot break every backup.
  const filled = table.columns
    .map((c) => (ENV_ONLY_COLUMNS.includes(c) ? `env_only.${db.escapeIdentifier(c)}` : "NULL"))
    .join(", ");
  // Literals, because COPY takes no bind parameters. The anti-join is for a setting an admin wrote
  // between reading its provenance and this snapshot: its row wins, and the file stays free of
  // duplicate keys a restore's primary key would refuse.
  return (
    `COPY (${rows} UNION ALL SELECT ${filled} FROM (VALUES ${values}) ` +
    `AS env_only(${ENV_ONLY_COLUMNS.join(", ")}) ` +
    "WHERE NOT EXISTS (SELECT 1 FROM settings s WHERE s.key = env_only.key)) TO STDOUT"
  );
}

/** A pass-through that counts the bytes going by. */
function byteCounter(count: (n: number) => void): Transform {
  return new Transform({
    transform(chunk: Buffer, _enc, done): void {
      count(chunk.length);
      done(null, chunk);
    },
  });
}

/**
 * Stream one table's `COPY` output, gzipped, to the destination; returns its row count and the
 * uploaded file's size. Nothing is buffered beyond the upload's own parts.
 */
async function copyTable(
  client: PoolClient,
  bucket: BackupBucket,
  path: string,
  statement: string,
  signal: AbortSignal,
): Promise<{ rows: number; bytes: number }> {
  const source = client.query(copyTo(statement));
  let bytes = 0;
  const counted = byteCounter((n) => (bytes += n));
  // A failed upload stops reading, which would leave the pipeline waiting forever; aborting it
  // tears the streams down so the run fails and the connection is discarded.
  const stopPump = new AbortController();
  // Level 1: this runs inside the snapshot transaction on a small CPU, and those matter more than
  // the file's size.
  const pumped = pipeline(source, createGzip({ level: 1 }), counted, {
    signal: AbortSignal.any([signal, stopPump.signal]),
  });
  const uploaded = bucket
    .putStream(path, counted, { contentType: "application/gzip" })
    .catch((err: unknown) => {
      stopPump.abort(err);
      throw err;
    });
  await Promise.all([pumped, uploaded]);
  return { rows: source.rowCount, bytes };
}

/** What the database phase hands to the rest of the run. */
interface SnapshotResult {
  schemaVersion: number;
  tables: BackupManifest["tables"];
  media: MediaRow[];
}

/**
 * Open one read-only snapshot, stream every table to `db/<folder>/`, and read the `media` rows from
 * the same snapshot, then end the transaction. Files are copied after this returns, so a long photo
 * copy never holds a transaction open.
 */
async function snapshotDatabase(
  deps: BackupJobDeps,
  bucket: BackupBucket,
  folder: string,
  requestedBy: string,
  createdAt: string,
  progress: RunProgress,
  signal: AbortSignal,
): Promise<SnapshotResult> {
  return withRunClient(deps.connections, signal, async (client, runSignal) => {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const shapes = await discoverTables(client);
    const schemaVersion = await readSchemaVersion(client);
    const extraSettings = envOnlySettingRows(deps, requestedBy, createdAt, progress);
    progress.stats.tablesTotal = shapes.length;
    progress.tick();

    const tables: BackupManifest["tables"] = [];
    for (const table of shapes) {
      runSignal.throwIfAborted();
      const file = `db/${folder}/${table.name}.copy.gz`;
      const statement = copyStatement(client, table, extraSettings);
      const { rows, bytes } = await copyTable(client, bucket, file, statement, runSignal);
      tables.push({ name: table.name, columns: table.columns, rows, bytes, file });
      progress.stats.tablesDone += 1;
      progress.stats.rows += rows;
      progress.tick();
    }

    const media = await client.query<{ hash: string; size: string; type: string }>(
      "SELECT hash, size, type FROM media ORDER BY hash",
    );
    await client.query("COMMIT");
    return {
      schemaVersion,
      tables,
      media: media.rows.map((r) => ({ hash: r.hash, size: Number(r.size), type: r.type })),
    };
  });
}

const BACKUP_FAULT_TEXT: Record<MediaFault, string> = {
  missing: "file is missing from this server",
  corrupt: "file does not match its hash",
};

/** Copy the files the snapshot's rows name, and report the hashes that could not be copied. */
async function copyMedia(
  deps: BackupJobDeps,
  bucket: BackupBucket,
  rows: readonly MediaRow[],
  progress: RunProgress,
  signal: AbortSignal,
): Promise<string[]> {
  progress.stats.mediaTotal = rows.length;
  progress.tick();

  // Listed once, up front: a top-up run must not ask about, or hash, the whole library file by file.
  const existing = await bucket.objectSizes("media/");
  const pending = rows.filter((row) => {
    // A file with the wrong size is copied over: a partial or foreign object is not this file.
    if (existing.get(`media/${blobKey(row.hash)}`) !== row.size) return true;
    fileSkipped(progress, row);
    return false;
  });

  return copyVerifiedFiles(
    deps,
    pending,
    {
      open: (hash, s) => deps.blobs.read(hash, s),
      store: (row, bytes) =>
        bucket.put(`media/${blobKey(row.hash)}`, bytes, {
          contentType: row.type,
          cacheControl: MEDIA_CACHE_CONTROL,
        }),
      faultText: BACKUP_FAULT_TEXT,
      progress,
    },
    signal,
  );
}

/** The body of a backup; throws to fail the run. Returns whether the server was locked for it. */
export async function runBackup(
  deps: BackupJobDeps,
  bucket: BackupBucket,
  run: BackupRun,
  params: AdminBackupStartParams,
  progress: RunProgress,
  signal: AbortSignal,
): Promise<{ locked: boolean }> {
  const secrets = targetSecrets(params.target);
  /** Best effort: failing to clear old files is reported, but the backup itself is complete. */
  const clean = async (label: string, action: () => Promise<void>): Promise<void> => {
    try {
      await action();
    } catch (err) {
      progress.warn(`could not remove ${label}: ${safeRunError(err, secrets)}`);
    }
  };

  // Read now, so a run cannot spend hours on photos and then fail on the key, and only when asked
  // for: a run that was told to leave the secret out has no reason to touch it.
  const phrase = params.includeIdentity ? await deps.identity.recoveryPhrase() : undefined;
  if (params.includeIdentity && phrase === undefined) {
    progress.warn(
      "this server has an ephemeral identity (no recovery phrase), so this backup cannot restore as the same server",
    );
  }
  const writeIdentity = phrase !== undefined;

  // The manifest's own limits, checked before the run moves anything rather than after it has.
  const facts = backupManifestSchema.pick({ host: true, did: true, serverVersion: true }).parse({
    host: deps.config.host,
    did: deps.identity.account.did,
    serverVersion: deps.config.version,
  });

  const lock = await settleLock(deps, signal);

  const createdAt = new Date(deps.now()).toISOString();
  // The folder name has to pass the manifest's path rule, which has no `:` in it.
  const folder = createdAt.replace(/:/g, "-");
  const snapshot = await snapshotDatabase(
    deps,
    bucket,
    folder,
    run.requestedBy,
    createdAt,
    progress,
    signal,
  );
  // Judged after the snapshot, so `locked` cannot claim a lock lifted around the moment it was taken.
  const lockedAtSnapshot = lockHeld(deps, lock);

  const missing = await copyMedia(deps, bucket, snapshot.media, progress, signal);

  if (writeIdentity) {
    // The whole file is the phrase, the `file` key provider's format (it trims a trailing newline).
    await bucket.put("identity.key", `${phrase}\n`, { contentType: "text/plain" });
  }
  if (missing.length > 0) {
    await bucket.put("media-missing.txt", `${missing.join("\n")}\n`, { contentType: "text/plain" });
  }

  // Still locked now, or the copy is not the final state and a move must not treat it as one.
  const locked = lockedAtSnapshot && lockHeld(deps, lock);
  if (lockedAtSnapshot && !locked) {
    progress.warn("the server was unlocked during this backup, so it is recorded as not locked");
  }

  const manifest = backupManifestSchema.parse({
    format: MANIFEST_FORMAT,
    createdAt,
    ...facts,
    schemaVersion: snapshot.schemaVersion,
    locked,
    identity: writeIdentity,
    tables: snapshot.tables,
    media: {
      count: snapshot.media.length,
      // All rows, like `count`: this is what the data weighs on the server restored to.
      bytes: snapshot.media.reduce((sum, row) => sum + row.size, 0),
      missing: missing.length,
    },
  });
  // Last of all: until this lands, the previous manifest still names the previous good backup.
  await bucket.put("manifest.json", `${JSON.stringify(manifest, null, 2)}\n`, {
    contentType: "application/json",
  });

  // Removals wait for the manifest for the same reason: an older `identity.key` deleted before a
  // run that later dies would leave the previous manifest claiming a file that is gone.
  if (!writeIdentity) {
    await clean("the older identity.key", () => bucket.remove("identity.key"));
  }
  if (missing.length === 0) {
    await clean("the older media-missing.txt", () => bucket.remove("media-missing.txt"));
  }
  await clean("earlier database folders", async () => {
    for (const name of await bucket.folders("db/")) {
      if (name !== folder) await bucket.removeTree(`db/${name}/`);
    }
  });

  return { locked };
}
