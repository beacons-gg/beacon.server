import type { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";
import { createGunzip } from "node:zlib";
import { accountFromMnemonic } from "@beaconsgg/identity";
import {
  backupManifestReadSchema,
  type BackupManifest,
  type BackupRun,
} from "@beaconsgg/protocol-types";
import type { PoolClient } from "pg";
import { from as copyFrom } from "pg-copy-streams";
import { HOST_RE } from "../config";
import { encryptMnemonic, MIN_PASSPHRASE_LEN } from "../identity/key-provider";
import { blobKey, type MediaBlobStore } from "../media/media-blob";
import { runMigrations } from "../migrations/runner";
import type { SettingsService } from "../settings/settings.service";
import type { BackupRunStore } from "../stores/backup-run-store";
import { updateBackupRun } from "../stores/backup-run.pg.store";
import { readRestoredIdentity, writeRestoredIdentity } from "../stores/restored-identity";
import { putSetting } from "../stores/settings.pg.store";
import { PgInTransactionMigrationExecutor } from "../stores/pg.migrations";
import type { DbConnections } from "../stores/store.factory";
import {
  BACKUP_EXCLUDED_TABLES,
  discoverTables,
  readSchemaVersion,
  withRunClient,
  type BackupTableShape,
} from "./backup-db";
import {
  consumeListing,
  copyVerifiedFiles,
  fileMissing,
  fileSkipped,
  retrying,
  withStallLimit,
  type FileDeps,
  type MediaFault,
  type MediaRow,
} from "./backup-files";
import { MANIFEST_FORMAT, safeRunError, settleLock, type RunProgress } from "./backup-job";
import type { BackupBucket } from "./backup-target";

/** A manifest bigger than this is not one this server wrote. */
const MAX_MANIFEST_BYTES = 8 * 1024 * 1024;

/** An `identity.key` is one recovery phrase; anything bigger is not one. */
const MAX_KEY_BYTES = 4 * 1024;

/** The tables that mean a server is already in use. */
const PLAYER_DATA_TABLES = ["rooms", "profiles", "media", "mailbox", "place_sources"];

/** A content hash: SHA-256 as unpadded base64url, the only thing a backup row may name as a file. */
const HASH_RE = /^[A-Za-z0-9_-]{43}$/;

/** A backup that cannot be read: the operator's input, so a 400. */
export class RestoreManifestError extends Error {}

/** A backup this server will not restore, for the reason given: the operator's input, so a 400. */
export class RestoreRefusedError extends Error {}

/** Read and parse `manifest.json`. The read schema, so a later format is refused rather than a 400. */
export async function readRestoreManifest(
  bucket: BackupBucket,
  secrets: readonly string[],
): Promise<BackupManifest> {
  let text: string | undefined;
  try {
    text = await bucket.readText("manifest.json", MAX_MANIFEST_BYTES);
  } catch (err) {
    throw new RestoreManifestError(`could not read manifest.json: ${safeRunError(err, secrets)}`);
  }
  if (text === undefined) {
    throw new RestoreManifestError("there is no manifest.json at this prefix");
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new RestoreManifestError("manifest.json is not JSON");
  }
  const parsed = backupManifestReadSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new RestoreManifestError(
      `manifest.json is not a valid manifest: ${issue?.path.join(".") ?? ""}: ${issue?.message ?? ""}`,
    );
  }
  return parsed.data;
}

/** The hoster's limits a restore is held to, and the passphrase it seals a key with. */
interface RestoreConfig {
  keyPassphrase?: string | undefined;
  mediaLimitBytes?: number | undefined;
  restoreDatabaseLimitBytes?: number | undefined;
}

/** What deciding whether a backup may restore here needs. */
export interface RestoreRefusalDeps {
  connections: DbConnections;
  settings: Pick<SettingsService, "state">;
  identity: { account: { did: string } };
  config: RestoreConfig;
  runs: Pick<BackupRunStore, "hasDone">;
  /** A place import writes as it goes, so a restore must not start underneath one. */
  placeRunActive: () => boolean;
}

/** Why this server would not restore `manifest`, in one sentence; undefined when it would. */
export async function restoreRefusal(
  deps: RestoreRefusalDeps,
  manifest: BackupManifest,
  signal: AbortSignal,
): Promise<string | undefined> {
  if (manifest.format !== MANIFEST_FORMAT) {
    return `This backup is format ${manifest.format}, and this server reads format ${MANIFEST_FORMAT}: upgrade the server first.`;
  }
  // Every id the server mints from here on carries this, and it is the backup's say-so.
  if (!HOST_RE.test(manifest.host)) {
    return `This backup's server name, ${manifest.host}, is not one a server can use.`;
  }
  if (manifest.did !== deps.identity.account.did) {
    const differs = `This backup is of the server ${manifest.did}, and this server is ${deps.identity.account.did}: `;
    if (!manifest.identity) {
      return `${differs}this backup has no identity.key, so take it again with its key included, or start this server with the original server's key.`;
    }
    if ((deps.config.keyPassphrase ?? "").length < MIN_PASSPHRASE_LEN) {
      return `${differs}set BEACON_KEY_PASSPHRASE so this server can keep the backup's key, or start it with the backup's identity.key, using BEACON_KEY_PROVIDER=file and BEACON_KEY_FILE.`;
    }
  }
  const databaseLimit = deps.config.restoreDatabaseLimitBytes;
  const databaseBytes = manifest.tables.reduce((sum, table) => sum + table.bytes, 0);
  if (databaseLimit !== undefined && databaseBytes > databaseLimit) {
    return `This backup's database is ${databaseBytes} bytes compressed, and this server may load ${databaseLimit}: contact whoever hosts it.`;
  }
  const limit = deps.config.mediaLimitBytes;
  if (limit !== undefined && manifest.media.bytes > limit) {
    return `This backup holds ${manifest.media.bytes} bytes of media and this server's limit is ${limit}: a move needs that much room.`;
  }
  if (deps.placeRunActive()) {
    return "A place import is queued or running on this server: wait for it to finish or cancel it first.";
  }
  const facts = await withRunClient(deps.connections, signal, async (client) => ({
    schemaVersion: await readSchemaVersion(client),
    hasPlayerData: await holdsPlayerData(client),
  }));
  if (manifest.schemaVersion > facts.schemaVersion) {
    return `This backup is at schema ${manifest.schemaVersion} and this server is at ${facts.schemaVersion}: upgrade the server first.`;
  }
  if (facts.hasPlayerData) {
    // Outside the client above: a pool of one connection has none spare while that one is held.
    const restoredHere = await deps.runs.hasDone("restore");
    if (!restoredHere || !deps.settings.state("writeLocked").value) {
      return "This server holds player data, so a restore would replace it: use an empty server, or lock one this job already restored.";
    }
  }
  return undefined;
}

async function holdsPlayerData(client: PoolClient): Promise<boolean> {
  const checks = PLAYER_DATA_TABLES.map((t) => `EXISTS (SELECT 1 FROM ${t})`).join(" OR ");
  const res = await client.query<{ held: boolean }>(`SELECT (${checks}) AS held`);
  return res.rows[0]?.held ?? false;
}

/** What a restore needs from the rest of the server. */
export interface RestoreJobDeps extends FileDeps {
  connections: DbConnections;
  blobs: Pick<MediaBlobStore, "put" | "list" | "delete">;
  settings: Pick<SettingsService, "state" | "set">;
  identity: { account: { did: string } };
  /** `host` is the name this server runs as now: restored before, or its `BEACON_HOST`. */
  config: RestoreConfig & { host: string };
  placeRunActive: () => boolean;
  now: () => number;
  /** Where the migrations live; a test points this at a set with a later one. */
  migrationsDir?: string;
}

/** Undo COPY's text-format escapes for one field. */
function unescapeCopyField(field: string): string {
  return field.replace(/\\([\\bfnrtv])/g, (_, c: string) => {
    const known: Record<string, string> = {
      "\\": "\\",
      b: "\b",
      f: "\f",
      n: "\n",
      r: "\r",
      t: "\t",
      v: "\v",
    };
    return known[c] ?? c;
  });
}

/** The manifest's entry for one table, or a failure naming it. */
function manifestTable(manifest: BackupManifest, name: string): BackupManifest["tables"][number] {
  const table = manifest.tables.find((t) => t.name === name);
  if (!table) throw new Error(`the manifest has no ${name} table`);
  return table;
}

/** A backup file as a stream, failing the run when it is gone. */
async function openBackupFile(bucket: BackupBucket, path: string): Promise<Readable> {
  const body = await bucket.read(path);
  if (body === undefined) throw new Error(`${path} is missing from this backup`);
  return body;
}

/** A backup's `media` rows: those a file can be checked against, and the hashes of those it cannot. */
interface BackupMedia {
  rows: MediaRow[];
  bad: string[];
}

/** The `media` rows from the backup's own copy file, by the manifest's column list. */
async function readMediaRows(
  bucket: BackupBucket,
  manifest: BackupManifest,
  databaseLimit: number | undefined,
  signal: AbortSignal,
): Promise<BackupMedia> {
  const table = manifestTable(manifest, "media");
  const at = (column: string): number => {
    const index = table.columns.indexOf(column);
    if (index < 0) throw new Error(`the manifest's media table has no ${column} column`);
    return index;
  };
  const [hashAt, sizeAt, typeAt] = [at("hash"), at("size"), at("type")];

  const rows: MediaRow[] = [];
  const bad: string[] = [];
  let rest = "";
  const addLine = (line: string): void => {
    if (line === "") return;
    const fields = line.split("\t");
    const hash = unescapeCopyField(fields[hashAt] ?? "");
    const size = Number(fields[sizeAt]);
    // A backup is outside this server's control, and a row names a path and sizes a buffer.
    if (HASH_RE.test(hash) && /^\d+$/.test(fields[sizeAt] ?? "") && Number.isSafeInteger(size)) {
      // Copied, not sliced: a slice of a line keeps the whole decompressed chunk alive with it, and
      // a library's worth of these would hold the file in memory until the run ends.
      const flat = Buffer.from(hash, "latin1").toString("latin1");
      rows.push({ hash: flat, size, type: unescapeCopyField(fields[typeAt] ?? "") });
    } else {
      bad.push(hash);
    }
  };
  // The same ceiling as the load, here first: this pass holds what it reads in memory.
  const meter = new DatabaseBudget(databaseLimit).meter();
  meter.setEncoding("utf8");
  await pipeline(
    await openBackupFile(bucket, table.file),
    createGunzip(),
    meter,
    async (lines: AsyncIterable<string>): Promise<void> => {
      for await (const chunk of lines) {
        const parts = (rest + chunk).split("\n");
        rest = parts.pop() ?? "";
        parts.forEach(addLine);
      }
      addLine(rest);
    },
    { signal },
  );
  return { rows, bad };
}

const RESTORE_FAULT_TEXT: Record<MediaFault, string> = {
  missing: "file is missing from this backup",
  corrupt: "file does not match its hash",
};

/**
 * Copy into this server's blob backend every file the backup's rows name, so photos removed by
 * moderation do not come back. Straight to `put`, never `MediaService`: its quotas and checks could
 * refuse an old photo, and an import would change the owner.
 */
async function copyFiles(
  deps: RestoreJobDeps,
  bucket: BackupBucket,
  { rows, bad }: BackupMedia,
  progress: RunProgress,
  signal: AbortSignal,
): Promise<void> {
  progress.stats.mediaTotal = rows.length + bad.length;
  progress.tick();

  for (const hash of bad) fileMissing(progress, hash, "its row in the backup is not valid");

  // Listed once and matched off, so a second pass, which runs while the server is locked, asks the
  // backend about nothing it already holds. A retried listing only finds fewer rows left to match.
  const pending = new Map(rows.map((row) => [row.hash, row]));
  await retrying(deps, "this server's media could not be listed", signal, () =>
    consumeListing(
      deps,
      (s) => deps.blobs.list(s),
      ({ hash, size }) => {
        const row = pending.get(hash);
        if (row?.size !== size) return;
        pending.delete(hash);
        fileSkipped(progress, row);
      },
      signal,
    ),
  );

  await copyVerifiedFiles(
    deps,
    [...pending.values()],
    {
      open: (hash, s) => bucket.read(`media/${blobKey(hash)}`, s),
      store: (row, bytes) =>
        retrying(deps, `media ${row.hash} could not be stored`, signal, () =>
          withStallLimit(
            deps,
            signal,
            (s) => deps.blobs.put(row.hash, bytes, row.type, s),
            row.size,
          ),
        ),
      faultText: RESTORE_FAULT_TEXT,
      progress,
    },
    signal,
  );
}

/** Every manifest table and column must exist here: the manifest is input, and names reach SQL. */
function checkManifestShape(manifest: BackupManifest, shapes: readonly BackupTableShape[]): void {
  const known = new Map(shapes.map((shape) => [shape.name, new Set(shape.columns)]));
  for (const table of manifest.tables) {
    const columns = known.get(table.name);
    if (!columns) throw new Error(`the backup's table ${table.name} is not in this database`);
    const unknown = table.columns.find((column) => !columns.has(column));
    if (unknown !== undefined) {
      throw new Error(`the backup's column ${table.name}.${unknown} is not in this database`);
    }
  }
}

/** Counts what a restore loads across all its tables, and stops it past the hoster's limit. */
class DatabaseBudget {
  private used = 0;
  constructor(private readonly limit: number | undefined) {}

  meter(): Transform {
    return new Transform({
      transform: (chunk: Buffer, _encoding, done) => {
        this.used += chunk.length;
        if (this.limit !== undefined && this.used > this.limit) {
          done(
            new RestoreRefusedError(
              `This backup's data is over the ${this.limit} bytes this server may load.`,
            ),
          );
        } else {
          done(null, chunk);
        }
      },
    });
  }
}

/** Load one table's file with `COPY` into the manifest's column list. Row data only, never SQL. */
async function loadTable(
  client: PoolClient,
  bucket: BackupBucket,
  table: BackupManifest["tables"][number],
  budget: DatabaseBudget,
  signal: AbortSignal,
): Promise<void> {
  const columns = table.columns.map((c) => client.escapeIdentifier(c)).join(", ");
  const sink = client.query(
    copyFrom(`COPY ${client.escapeIdentifier(table.name)} (${columns}) FROM STDIN`),
  );
  await pipeline(await openBackupFile(bucket, table.file), createGunzip(), budget.meter(), sink, {
    signal,
  });
  // Postgres's own count of what this `COPY` loaded, so the first short table ends the run.
  if (sink.rowCount !== table.rows) {
    throw new Error(
      `table ${table.name}: the manifest says ${table.rows} rows, loaded ${sink.rowCount}`,
    );
  }
}

/** `COPY` does not advance sequences, so every serial column's is set from its data. */
async function resetSequences(client: PoolClient): Promise<void> {
  const res = await client.query<{ table_name: string; column_name: string; seq: string }>(
    // Materialized so the schema filter runs first. In one WHERE the planner may call the function
    // on system views as well, and it throws on a name it cannot resolve.
    "WITH own AS MATERIALIZED (SELECT table_name, column_name FROM information_schema.columns " +
      "WHERE table_schema = current_schema()), " +
      "serial AS MATERIALIZED (SELECT table_name, column_name, " +
      "pg_get_serial_sequence(quote_ident(table_name), column_name) AS seq FROM own) " +
      "SELECT table_name, column_name, seq FROM serial WHERE seq IS NOT NULL",
  );
  for (const row of res.rows) {
    if (BACKUP_EXCLUDED_TABLES.has(row.table_name)) continue;
    const column = client.escapeIdentifier(row.column_name);
    await client.query(
      `SELECT setval($1::regclass, COALESCE(MAX(${column}), 1), MAX(${column}) IS NOT NULL) ` +
        `FROM ${client.escapeIdentifier(row.table_name)}`,
      [row.seq],
    );
  }
}

/**
 * Drop the settings tied to the old machine. A copied CDN URL would send every photo to the old
 * bucket and break when it is shut down. `mediaEnabled=false` only goes when there are photos to
 * serve; `writeLocked` stays as the backup had it, unless the server is becoming another one.
 */
async function dropMachineSettings(client: PoolClient): Promise<void> {
  await client.query("DELETE FROM settings WHERE key IN ('publicUrl', 'mediaCdnUrl')");
  await client.query(
    "DELETE FROM settings WHERE key = 'mediaEnabled' AND value = 'false' " +
      "AND EXISTS (SELECT 1 FROM media)",
  );
}

/**
 * Drop the `media` rows no server could have written. A backup is a file anyone can edit, and the
 * space limits add these sizes up, so one negative size would hand a server unlimited room. Judged
 * on what `COPY` actually stored, which a field's raw text can disguise with an escape.
 */
async function dropInvalidMediaRows(client: PoolClient): Promise<void> {
  await client.query(
    `DELETE FROM media WHERE hash !~ '${HASH_RE.source}' OR size < 0 OR size > ${Number.MAX_SAFE_INTEGER}`,
  );
}

/**
 * Take the schema down to the backup's version: keep the job log aside in a temp table, drop every
 * table, and migrate up to `version`. All inside the load's transaction, so a failure here or later
 * rolls the whole thing back and the retry starts from where this one did.
 */
async function rewindSchema(
  client: PoolClient,
  deps: RestoreJobDeps,
  version: number,
): Promise<void> {
  await client.query(
    "CREATE TEMP TABLE backup_runs_keep ON COMMIT DROP AS SELECT * FROM backup_runs",
  );
  const tables = [
    ...(await discoverTables(client)).map((shape) => shape.name),
    ...BACKUP_EXCLUDED_TABLES,
  ];
  await client.query(
    `DROP TABLE ${tables.map((name) => client.escapeIdentifier(name)).join(", ")} CASCADE`,
  );
  await runMigrations(new PgInTransactionMigrationExecutor(client), deps.migrationsDir, {
    stopAt: version,
  });
}

/** Replace the database with the backup, in one transaction, and record the run `done` in it. */
async function loadDatabase(
  deps: RestoreJobDeps,
  bucket: BackupBucket,
  run: BackupRun,
  manifest: BackupManifest,
  sealedKey: string | undefined,
  progress: RunProgress,
  signal: AbortSignal,
): Promise<string[]> {
  return withRunClient(deps.connections, signal, async (client, runSignal) => {
    await client.query("BEGIN");
    // LOCAL, because this client goes back to the pool: hosted roles default to minutes, which a
    // large table would outrun, but that is only safe to lift for this transaction.
    await client.query("SET LOCAL statement_timeout = 0");
    await client.query("SET LOCAL idle_in_transaction_session_timeout = 0");

    // Read before anything changes: what this server held, so a re-restore can drop what is gone.
    await client.query("CREATE TEMP TABLE media_before ON COMMIT DROP AS SELECT hash FROM media");
    // The nonces still inside the signing window stay. The backup's log replaces this one, and
    // losing them would forget this very start and reopen replay until they would have expired.
    await client.query(
      "CREATE TEMP TABLE capability_nonces_keep ON COMMIT DROP AS " +
        "SELECT * FROM capability_nonces " +
        `WHERE expires_at > ${client.escapeLiteral(new Date(deps.now()).toISOString())}`,
    );

    // Before a rewind can drop it: a server already running on a restored key has to keep it.
    const previous = await readRestoredIdentity(client);
    const older = manifest.schemaVersion < (await readSchemaVersion(client));
    if (older) await rewindSchema(client, deps, manifest.schemaVersion);

    const shapes = await discoverTables(client);
    checkManifestShape(manifest, shapes);
    await client.query(
      `TRUNCATE ${shapes.map((shape) => client.escapeIdentifier(shape.name)).join(", ")}`,
    );

    progress.stats.tablesTotal = manifest.tables.length;
    const budget = new DatabaseBudget(deps.config.restoreDatabaseLimitBytes);
    for (const table of manifest.tables) {
      runSignal.throwIfAborted();
      await loadTable(client, bucket, table, budget, runSignal);
      progress.stats.tablesDone += 1;
      progress.stats.rows += table.rows;
    }

    await resetSequences(client);
    await dropInvalidMediaRows(client);
    await dropMachineSettings(client);
    if (older) {
      await runMigrations(new PgInTransactionMigrationExecutor(client), deps.migrationsDir);
      // After the forward run, so each table is back at the shape its rows were kept from.
      await client.query("INSERT INTO backup_runs SELECT * FROM backup_runs_keep");
    }
    const restoredAt = new Date(deps.now()).toISOString();
    await writeRestoredIdentity(
      client,
      { host: manifest.host, keyEnvelope: sealedKey ?? previous?.keyEnvelope ?? null },
      restoredAt,
    );
    // Becoming another server: whatever lock the backup had, it comes up locked, so the admin opens
    // it once its domain points here and the old one is closed, and rollback stays open until then.
    if (manifest.host !== deps.config.host || sealedKey !== undefined) {
      await putSetting(client, {
        key: "writeLocked",
        value: true,
        updatedBy: run.requestedBy,
        updatedAt: restoredAt,
      });
    }
    await client.query(
      "INSERT INTO capability_nonces SELECT * FROM capability_nonces_keep ON CONFLICT DO NOTHING",
    );

    // In this transaction, so restored data can never exist without its `done` run: a retry after
    // a crash at this point would otherwise find player data and refuse.
    await updateBackupRun(
      client,
      run.id,
      progress.closing({ status: "done", finishedAt: new Date(deps.now()).toISOString() }),
    );
    const stale = await client.query<{ hash: string }>(
      "SELECT hash FROM media_before EXCEPT SELECT hash FROM media",
    );
    await client.query("COMMIT");
    return stale.rows.map((row) => row.hash);
  });
}

/**
 * Remove the files of photos this restore's rows no longer name, so one moderated between two
 * restores does not survive the second. Best effort: the data is already in and the run `done`.
 */
async function removeStaleFiles(
  deps: RestoreJobDeps,
  stale: readonly string[],
  progress: RunProgress,
  signal: AbortSignal,
): Promise<void> {
  if (stale.length === 0) return;
  let failed = 0;
  for (const hash of stale) {
    if (signal.aborted) break;
    await withStallLimit(deps, signal, () => deps.blobs.delete(hash)).catch(() => {
      failed += 1;
    });
  }
  if (failed > 0) {
    progress.warn(`could not remove ${failed} file(s) this backup no longer names`);
    await progress.finish({});
  }
}

/**
 * The backup's key sealed for this server, when this server is becoming the backup's; undefined when
 * it already is. Checked against the manifest here, since a wrong key would be found only at boot,
 * with the data already replaced, and the server would then come up as someone else.
 */
async function sealBackupKey(
  deps: RestoreJobDeps,
  bucket: BackupBucket,
  manifest: BackupManifest,
): Promise<string | undefined> {
  if (manifest.did === deps.identity.account.did) return undefined;
  const phrase = (await bucket.readText("identity.key", MAX_KEY_BYTES))?.trim();
  if (!phrase) throw new RestoreRefusedError("This backup's identity.key is missing or empty.");
  let did: string;
  try {
    did = accountFromMnemonic(phrase).did;
  } catch {
    throw new RestoreRefusedError("This backup's identity.key is not a recovery phrase.");
  }
  if (did !== manifest.did) {
    throw new RestoreRefusedError(
      "This backup's identity.key is not the key of the server that made it.",
    );
  }
  return encryptMnemonic(phrase, deps.config.keyPassphrase ?? "");
}

/**
 * The body of a restore; throws to fail the run. Files first, while the old database still serves,
 * so the outage is only the load.
 */
export async function runRestore(
  deps: RestoreJobDeps,
  bucket: BackupBucket,
  run: BackupRun,
  manifest: BackupManifest,
  progress: RunProgress,
  signal: AbortSignal,
): Promise<void> {
  // Before the lock and before any copy: the manifest's own figure is only what the backup claims.
  const media = await readMediaRows(
    bucket,
    manifest,
    deps.config.restoreDatabaseLimitBytes,
    signal,
  );
  const limit = deps.config.mediaLimitBytes;
  const bytes = media.rows.reduce((sum, row) => sum + row.size, 0);
  if (limit !== undefined && bytes > limit) {
    throw new RestoreRefusedError(
      `This backup's files come to ${bytes} bytes and this server's limit is ${limit}: a move needs that much room.`,
    );
  }
  const sealedKey = await sealBackupKey(deps, bucket, manifest);

  // Through the settings service, so the lock is durable: a crash anywhere below stays locked.
  await deps.settings.set("writeLocked", true, run.requestedBy);

  await copyFiles(deps, bucket, media, progress, signal);

  // A fresh lock needs its moment, as a backup's does: writes in flight must land before the load.
  // An admin can lift it meanwhile (the settings ops answer while locked), and the load would then
  // replace data under a live server, so that ends the run here, before anything is destroyed.
  if ((await settleLock(deps, signal)) === undefined) {
    throw new Error("the lock was lifted during the restore, so the database was not replaced");
  }
  // Inspect's check ran before the lock, and a place import could start in that gap.
  if (deps.placeRunActive()) {
    throw new Error("a place import started before the lock took hold: cancel it and retry");
  }
  // Nothing may write the row from here but the transaction, which also holds its table.
  await progress.settled();
  const stale = await loadDatabase(deps, bucket, run, manifest, sealedKey, progress, signal);
  await removeStaleFiles(deps, stale, progress, signal);
}
