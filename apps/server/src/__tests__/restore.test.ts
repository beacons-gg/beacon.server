import { randomBytes } from "node:crypto";
import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import {
  accountFromMnemonic,
  createRecoveryPhrase,
  createWallet,
  sha256Base64url,
  signOpWithWallet,
} from "@beaconsgg/identity";
import {
  adminRestoreInspectionSchema,
  backupRunSchema,
  type BackupManifest,
  type BackupRun,
  type BackupS3Target,
} from "@beaconsgg/protocol-types";
import { HttpException, Logger } from "@nestjs/common";
import { Pool, type PoolClient } from "pg";
import { ulid } from "ulid";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { forEachFile } from "../backup/backup-files";
import { BackupController } from "../backup/backup.controller";
import { decryptMnemonic } from "../identity/key-provider";
import { BackupService } from "../backup/backup.service";
import { RestoreRefusedError } from "../backup/restore-job";
import { AdminGate } from "../common/admin-gate";
import { NonceService } from "../common/nonce.service";
import { S3MediaBlobStore, type MediaBlobStore } from "../media/media-blob";
import { runMigrations } from "../migrations/runner";
import { runtimeSettingsFrom } from "../settings/registry";
import { SettingsService } from "../settings/settings.service";
import { PgBackupRunStore } from "../stores/backup-run.pg.store";
import { PgNonceStore } from "../stores/nonce.pg.store";
import { migrate, PgMigrationExecutor } from "../stores/pg.migrations";
import { PgStore } from "../stores/pg.store";
import { PgSettingsStore } from "../stores/settings.pg.store";
import { FakeS3 } from "./fake-s3";
import { memoryNonces } from "./memory-stores";
import { testDatabaseUrl } from "./pg-twin";
import { testConfig } from "./test-config";
import { makeClock, makeJarRoom, memoryBlobStore, testSignedRequestGate } from "./test-helpers";

// Every test here runs whole migrations, backups and restores against Postgres. Under coverage on a
// shared CI runner they take several seconds each, past vitest's 5 s test and 10 s hook defaults.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });

/**
 * Restore, as a round trip: a real backup from one server's schema restored into another's, on real
 * Postgres through the real AWS SDK against {@link FakeS3}.
 */

const SUFFIX = `${process.pid}_${randomBytes(4).toString("hex")}`;
const SOURCE = `restore_src_${SUFFIX}`;
const DEST = `restore_dst_${SUFFIX}`;
const LATER = `restore_later_${SUFFIX}`;
const ACCESS_KEY = "RESTOREACCESSKEY1234";
const SECRET_KEY = "restore-secret-access-key-value";
const HOST = "restore.test";
const PASSPHRASE = "a passphrase long enough";
const wallet = createWallet();
const ADMIN = wallet.account.did;

function schemaPool(schema: string): Pool {
  const url = new URL(testDatabaseUrl());
  url.searchParams.set("options", `-c search_path=${schema}`);
  return new Pool({ connectionString: url.href, max: 4 });
}

async function emptied(pool: Pool): Promise<void> {
  const tables = await pool.query<{ table_name: string }>(
    "SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema() AND table_type = 'BASE TABLE' AND table_name <> 'schema_migrations'",
  );
  await pool.query(`TRUNCATE ${tables.rows.map((r) => r.table_name).join(", ")}`);
}

describe("restore", () => {
  let admin: Pool;
  let source: Pool;
  let dest: Pool;
  let s3: FakeS3;
  let endpoint: string;
  let target: BackupS3Target;
  let clock: ReturnType<typeof makeClock>;
  let sourceBlobs: ReturnType<typeof memoryBlobStore>;
  let destBlobs: ReturnType<typeof memoryBlobStore>;
  let restarted: number;
  let statusAtRestart: Promise<string | undefined>;
  const services: BackupService[] = [];

  beforeAll(async () => {
    admin = new Pool({ connectionString: testDatabaseUrl(), max: 1 });
    await admin.query(`CREATE SCHEMA ${SOURCE}`);
    await admin.query(`CREATE SCHEMA ${DEST}`);
    source = schemaPool(SOURCE);
    dest = schemaPool(DEST);
    await migrate(source);
    await migrate(dest);
    s3 = new FakeS3();
    endpoint = await s3.start();
  });

  afterAll(async () => {
    await source.end();
    await dest.end();
    await admin.query(`DROP SCHEMA ${SOURCE} CASCADE`);
    await admin.query(`DROP SCHEMA ${DEST} CASCADE`);
    await admin.end();
    await s3.close();
  });

  beforeEach(async () => {
    s3.reset();
    await emptied(source);
    await emptied(dest);
    clock = makeClock("2026-11-08T12:00:00.000Z");
    sourceBlobs = memoryBlobStore();
    destBlobs = memoryBlobStore();
    restarted = 0;
    target = {
      endpoint,
      region: "us-east-1",
      bucket: "backups",
      prefix: "move/one",
      accessKeyId: ACCESS_KEY,
      secretAccessKey: SECRET_KEY,
      forcePathStyle: true,
    };
  });

  afterEach(async () => {
    await Promise.all(services.splice(0).map((s) => s.onModuleDestroy()));
    vi.restoreAllMocks();
  });

  const keyOf = (path: string): string => `move/one/${path}`;

  async function settingsOn(pool: Pool): Promise<SettingsService> {
    const svc = new SettingsService(
      new PgSettingsStore(pool),
      runtimeSettingsFrom(testConfig()),
      clock.now,
    );
    await svc.load();
    return svc;
  }

  interface ServerOptions {
    host?: string;
    did?: string;
    limit?: number;
    blobs?: MediaBlobStore;
    migrationsDir?: string;
    placeRunActive?: boolean | (() => boolean);
    socketTimeoutMs?: number;
    settings?: SettingsService;
    mediaStallMs?: number;
    connections?: { connect(): Promise<PoolClient> };
    keyPassphrase?: string;
    databaseLimit?: number;
  }

  async function server(pool: Pool, over: ServerOptions = {}): Promise<BackupService> {
    const svc = new BackupService(new PgBackupRunStore(pool), {
      connections: over.connections ?? pool,
      blobs: over.blobs ?? (pool === source ? sourceBlobs.blob : destBlobs.blob),
      settings: over.settings ?? (await settingsOn(pool)),
      identity: {
        account: { did: over.did ?? ADMIN },
        recoveryPhrase: () => Promise.resolve(undefined),
      },
      config: {
        host: over.host ?? HOST,
        version: "1.2.3",
        ...(over.limit !== undefined ? { mediaLimitBytes: over.limit } : {}),
        ...(over.keyPassphrase !== undefined ? { keyPassphrase: over.keyPassphrase } : {}),
        ...(over.databaseLimit !== undefined
          ? { restoreDatabaseLimitBytes: over.databaseLimit }
          : {}),
      },
      env: {},
      now: clock.now,
      sleep: (ms) => {
        clock.advanceSeconds(ms / 1000);
        return Promise.resolve();
      },
      placeRunActive: () =>
        typeof over.placeRunActive === "function"
          ? over.placeRunActive()
          : (over.placeRunActive ?? false),
      ...(over.mediaStallMs !== undefined ? { mediaStallMs: over.mediaStallMs } : {}),
      restart: () => {
        restarted += 1;
        // What the console will see: the row has to be `done` by the time the process goes.
        statusAtRestart = new PgBackupRunStore(pool).recent(1).then((r) => r[0]?.status);
      },
      bucket: {
        allowPrivateEndpoints: true,
        ...(over.socketTimeoutMs !== undefined ? { socketTimeoutMs: over.socketTimeoutMs } : {}),
      },
      ...(over.migrationsDir !== undefined ? { migrationsDir: over.migrationsDir } : {}),
    });
    services.push(svc);
    return svc;
  }

  async function settled(svc: BackupService, run: BackupRun): Promise<BackupRun> {
    await svc.idle();
    const finished = await svc.getRun(run.id);
    if (!finished) throw new Error("run missing");
    backupRunSchema.parse(finished);
    return finished;
  }

  async function takeBackup(
    locked = false,
    includeFiles?: () => Promise<void>,
  ): Promise<BackupManifest> {
    await includeFiles?.();
    const svc = await server(source);
    if (locked) {
      await (await settingsOn(source)).set("writeLocked", true, ADMIN);
    }
    const lockAware = locked ? await server(source) : svc;
    clock.advanceSeconds(30);
    const run = await lockAware.start({ target, includeIdentity: false }, ADMIN);
    const done = await settled(lockAware, run);
    expect(done.status).toBe("done");
    return manifestOf();
  }

  function manifestOf(): BackupManifest {
    const object = s3.objects.get(keyOf("manifest.json"));
    if (!object) throw new Error("no manifest");
    return JSON.parse(object.body.toString("utf8")) as BackupManifest;
  }

  function rewriteManifest(change: (m: BackupManifest) => BackupManifest): void {
    const m = change(manifestOf());
    s3.objects.set(keyOf("manifest.json"), {
      body: Buffer.from(JSON.stringify(m)),
      contentType: "application/json",
      cacheControl: undefined,
    });
  }

  async function restoreInto(svc: BackupService): Promise<BackupRun> {
    return settled(svc, await svc.startRestore({ target }, ADMIN));
  }

  async function plantFile(pool: Pool, bytes: Buffer, type = "image/webp"): Promise<string> {
    const hash = sha256Base64url(bytes);
    await pool.query(
      "INSERT INTO media (hash, type, size, owner, uploaded_at, last_access_at) VALUES ($1, $2, $3, $4, '2026-11-08T00:00:00.000Z', NULL)",
      [hash, type, bytes.length, ADMIN],
    );
    await sourceBlobs.blob.put(hash, bytes, type);
    return hash;
  }

  const fileKey = (hash: string): string => keyOf(`media/${hash.slice(0, 2)}/${hash}`);

  async function destRows(table: string): Promise<number> {
    const res = await dest.query<{ n: string }>(`SELECT COUNT(*) AS n FROM ${table}`);
    return Number(res.rows[0]?.n);
  }

  async function settingsRows(pool: Pool): Promise<Map<string, string>> {
    const res = await pool.query<{ key: string; value: string }>("SELECT key, value FROM settings");
    return new Map(res.rows.map((r) => [r.key, r.value]));
  }

  const seedRow = async (pool: Pool, id: string): Promise<void> => {
    await new PgStore(pool, 1000).commit([{ kind: "putRoom", room: makeJarRoom(id) }]);
  };

  const logRow = (id: string, over: Partial<BackupRun> = {}): BackupRun => ({
    id,
    kind: "backup",
    status: "done",
    requestedBy: ADMIN,
    target: { region: "r", bucket: "b", prefix: "p" },
    createdAt: "2026-10-01T00:00:00.000Z",
    ...over,
  });

  describe("becoming the backup's server", () => {
    const phrase = createRecoveryPhrase();
    const key = accountFromMnemonic(phrase);

    const restored = async (): Promise<{ host: string; key_envelope: string | null } | undefined> =>
      (
        await dest.query<{ host: string; key_envelope: string | null }>(
          "SELECT host, key_envelope FROM restored_identity",
        )
      ).rows[0];

    /** A backup claiming to be the server `key`, carrying `written` as its `identity.key`. */
    function backupOfKey(written: string): void {
      rewriteManifest((m) => ({ ...m, did: key.did, identity: true }));
      s3.objects.set(keyOf("identity.key"), {
        body: Buffer.from(`${written}\n`),
        contentType: "text/plain",
        cacheControl: undefined,
      });
    }

    it("takes the backup's name and key, sealed, on a server of another name", async () => {
      await seedRow(source, "room-1@restore.test");
      await takeBackup();
      backupOfKey(phrase);

      const svc = await server(dest, { host: "slug.beacons.test", keyPassphrase: PASSPHRASE });
      expect((await svc.inspectRestore(target)).refusal).toBeUndefined();
      const run = await restoreInto(svc);

      expect(run.status).toBe("done");
      expect(await destRows("rooms")).toBe(1);
      const row = await restored();
      expect(row?.host).toBe(HOST);
      expect(row?.key_envelope).not.toContain(phrase);
      expect(decryptMnemonic(row?.key_envelope ?? "", PASSPHRASE)).toBe(phrase);
      // Locked, though the backup was not: the admin opens it once the domain points here.
      expect((await settingsRows(dest)).get("writeLocked")).toBe("true");
    });

    it("needs no key when it already is the backup's server, and records only the name", async () => {
      await takeBackup();
      await restoreInto(await server(dest, { host: "slug.beacons.test" }));
      expect(await restored()).toEqual({ host: HOST, key_envelope: null });
      expect((await settingsRows(dest)).get("writeLocked")).toBe("true");
    });

    it("refuses a passphrase too short to seal the key with", async () => {
      await takeBackup();
      backupOfKey(phrase);
      const svc = await server(dest, { keyPassphrase: "short" });
      expect((await svc.inspectRestore(target)).refusal).toMatch(/set BEACON_KEY_PASSPHRASE/);
    });

    it("keeps a restored key through a second restore of the same server", async () => {
      await takeBackup();
      backupOfKey(phrase);
      await restoreInto(await server(dest, { keyPassphrase: PASSPHRASE }));
      const first = await restored();

      // Now running as that key, restoring a backup that left its key out.
      rewriteManifest((m) => ({ ...m, identity: false }));
      await (await settingsOn(dest)).set("writeLocked", true, ADMIN);
      clock.advanceSeconds(30);
      const run = await restoreInto(await server(dest, { did: key.did }));

      expect(run.status).toBe("done");
      expect((await restored())?.key_envelope).toBe(first?.key_envelope);
    });

    it.each([
      ["belongs to another server", createRecoveryPhrase(), /not the key of the server/],
      ["is not a recovery phrase", "not a phrase", /not a recovery phrase/],
    ])("fails before touching anything when identity.key %s", async (_label, written, message) => {
      await seedRow(source, "room-1@restore.test");
      await takeBackup();
      backupOfKey(written);

      const run = await restoreInto(await server(dest, { keyPassphrase: PASSPHRASE }));

      expect(run.status).toBe("failed");
      expect(run.error).toMatch(message);
      expect(run.error).not.toContain(written);
      expect(await restored()).toBeUndefined();
      // Before the lock too, so a server it could never have become is left as it was.
      expect((await settingsRows(dest)).has("writeLocked")).toBe(false);
      expect(await destRows("rooms")).toBe(0);
    });

    it("stops and rolls back when the data outgrows the manifest's claim", async () => {
      await seedRow(source, "room-1@restore.test");
      const manifest = await takeBackup();
      const roomFile = manifest.tables.find((t) => t.name === "rooms")?.file ?? "";
      const object = s3.objects.get(keyOf(roomFile));
      if (!object) throw new Error("no rooms file");
      // Compresses to almost nothing, so the manifest's figure and the limit check before it pass.
      object.body = gzipSync(
        Buffer.concat([gunzipSync(object.body), Buffer.alloc(1_000_000, "x")]),
      );
      const claimed = manifest.tables.reduce((sum, t) => sum + t.bytes, 0);

      const run = await restoreInto(await server(dest, { databaseLimit: claimed + 10_000 }));

      expect(run.status).toBe("failed");
      expect(run.error).toMatch(/this server may load/);
      expect(await destRows("rooms")).toBe(0);
      expect(await restored()).toBeUndefined();
    });
  });

  describe("a round trip", () => {
    it("carries a live backup over, and restarts only after the done row lands", async () => {
      await seedRow(source, "room-1@restore.test");
      await source.query("INSERT INTO nonces (nonce, result) VALUES ('n1', '{}')");
      const bytes = randomBytes(1024);
      const hash = await plantFile(source, bytes);
      const manifest = await takeBackup();
      expect(manifest.locked).toBe(false);

      await new PgBackupRunStore(dest).create(logRow("01ARZ3NDEKTSV4RRFFQ69G5FAV"));
      const svc = await server(dest);
      const run = await restoreInto(svc);

      expect(run.status).toBe("done");
      expect(run.kind).toBe("restore");
      expect(restarted).toBe(1);
      expect(await statusAtRestart).toBe("done");
      expect(run.stats).toMatchObject({ mediaDone: 1, mediaMissing: 0, mediaBytes: 1024 });
      expect(await destRows("rooms")).toBe(1);
      expect(destBlobs.blobs.get(hash)?.equals(bytes)).toBe(true);
      // The restored settings table decides the lock: this was a live backup.
      expect((await settingsRows(dest)).has("writeLocked")).toBe(false);
      // The job log survives untouched by the load.
      expect(await svc.getRun("01ARZ3NDEKTSV4RRFFQ69G5FAV")).toMatchObject({ status: "done" });
    });

    it("brings a locked backup back locked", async () => {
      await seedRow(source, "room-1@restore.test");
      const manifest = await takeBackup(true);
      expect(manifest.locked).toBe(true);

      await restoreInto(await server(dest));

      expect((await settingsRows(dest)).get("writeLocked")).toBe("true");
      expect(restarted).toBe(1);
    });

    it("takes the lock itself for the run", async () => {
      await takeBackup();
      const settings = await settingsOn(dest);
      const spy = vi.spyOn(settings, "set");
      const run = await restoreInto(await server(dest, { settings }));
      expect(run.status).toBe("done");
      expect(spy).toHaveBeenCalledWith("writeLocked", true, ADMIN);
    });

    it("resets every serial sequence from the data", async () => {
      for (const n of ["a", "b", "c"]) {
        await source.query("INSERT INTO nonces (nonce, result) VALUES ($1, '{}')", [n]);
      }
      const top = await source.query<{ seq: string }>("SELECT MAX(seq) AS seq FROM nonces");
      await takeBackup();

      await restoreInto(await server(dest));

      const next = await dest.query<{ v: string }>(
        "SELECT nextval(pg_get_serial_sequence('nonces', 'seq')) AS v",
      );
      expect(Number(next.rows[0]?.v)).toBe(Number(top.rows[0]?.seq) + 1);
    });

    it("drops settings tied to the old machine and keeps the rest", async () => {
      const set = (key: string, value: unknown): Promise<void> =>
        new PgSettingsStore(source).put({
          key,
          value,
          updatedBy: ADMIN,
          updatedAt: "2026-11-01T00:00:00.000Z",
        });
      await set("publicUrl", "https://old.example");
      await set("mediaCdnUrl", "https://cdn.old.example");
      await set("mediaEnabled", false);
      await set("name", "Kept");
      await plantFile(source, randomBytes(8));
      await takeBackup();

      await restoreInto(await server(dest));

      const rows = await settingsRows(dest);
      expect(rows.has("publicUrl")).toBe(false);
      expect(rows.has("mediaCdnUrl")).toBe(false);
      expect(rows.has("mediaEnabled")).toBe(false);
      expect(rows.get("name")).toBe('"Kept"');
    });

    it("keeps mediaEnabled=false when there are no photos to serve", async () => {
      await new PgSettingsStore(source).put({
        key: "mediaEnabled",
        value: false,
        updatedBy: ADMIN,
        updatedAt: "2026-11-01T00:00:00.000Z",
      });
      await takeBackup();
      await restoreInto(await server(dest));
      expect((await settingsRows(dest)).get("mediaEnabled")).toBe("false");
    });
  });

  describe("files", () => {
    it("skips a file already present at the right size", async () => {
      const bytes = randomBytes(128);
      const hash = await plantFile(source, bytes);
      await takeBackup();
      await destBlobs.blob.put(hash, bytes, "image/webp");
      const put = vi.spyOn(destBlobs.blob, "put");

      const run = await restoreInto(await server(dest));

      expect(put).not.toHaveBeenCalled();
      expect(run.stats).toMatchObject({ mediaDone: 1, mediaSkipped: 1 });
    });

    it("counts a file once when the listing fails part way and is retried", async () => {
      const bytes = randomBytes(64);
      const hash = await plantFile(source, bytes);
      await takeBackup();
      await destBlobs.blob.put(hash, bytes, "image/webp");
      const list = destBlobs.blob.list;
      let failures = 1;
      destBlobs.blob.list = async function* (signal?: AbortSignal) {
        yield* list(signal);
        if (failures > 0) {
          failures -= 1;
          throw new Error("listing interrupted");
        }
      };

      const run = await restoreInto(await server(dest));

      expect(run.status).toBe("done");
      expect(run.stats).toMatchObject({ mediaDone: 1, mediaSkipped: 1 });
    });

    it("counts a missing and a corrupt file as warnings, and finishes", async () => {
      const missing = await plantFile(source, randomBytes(64));
      const corrupt = await plantFile(source, randomBytes(64));
      const fine = await plantFile(source, randomBytes(64));
      await takeBackup();
      s3.objects.delete(fileKey(missing));
      const object = s3.objects.get(fileKey(corrupt));
      if (object) object.body = randomBytes(64);

      const run = await restoreInto(await server(dest));

      expect(run.status).toBe("done");
      expect(run.stats).toMatchObject({ mediaMissing: 2, mediaDone: 3 });
      expect(run.warnings?.join(" ")).toMatch(/missing from this backup/);
      expect(run.warnings?.join(" ")).toMatch(/does not match its hash/);
      expect(destBlobs.blobs.has(fine)).toBe(true);
      expect(destBlobs.blobs.has(corrupt)).toBe(false);
      expect(await destRows("media")).toBe(3);
    });

    it("refuses to act on a row naming something other than a content hash", async () => {
      await plantFile(source, randomBytes(16));
      await source.query(
        "INSERT INTO media (hash, type, size, owner, uploaded_at, last_access_at) VALUES ('../../escape', 'x/y', 4, $1, 'x', NULL)",
        [ADMIN],
      );
      await takeBackup();
      const put = vi.spyOn(destBlobs.blob, "put");

      const run = await restoreInto(await server(dest));

      expect(run.status).toBe("done");
      expect(run.stats).toMatchObject({ mediaMissing: 1, mediaDone: 2 });
      expect(run.warnings?.join(" ")).toMatch(/not valid/);
      expect(put.mock.calls.map((c) => c[0])).not.toContain("../../escape");
      const left = await dest.query("SELECT 1 FROM media WHERE hash = '../../escape'");
      expect(left.rowCount).toBe(0);
    });

    /** Rewrite the backup's `media` copy file, field by field. */
    function rewriteMediaFile(change: (fields: string[], columns: string[]) => string[]): void {
      const entry = manifestOf().tables.find((t) => t.name === "media");
      const object = s3.objects.get(keyOf(entry?.file ?? ""));
      if (!object || !entry) throw new Error("no media file");
      const lines = gunzipSync(object.body).toString("utf8").trim().split("\n");
      object.body = gzipSync(
        `${lines.map((l) => change(l.split("\t"), entry.columns).join("\t")).join("\n")}\n`,
      );
    }

    it("counts a row with a bad size as corrupt, and still copies the rest", async () => {
      await plantFile(source, randomBytes(16));
      const other = await plantFile(source, randomBytes(16));
      await takeBackup();
      rewriteMediaFile((fields, columns) => {
        if (fields[columns.indexOf("hash")] === other) return fields;
        const copy = [...fields];
        copy[columns.indexOf("size")] = "-5";
        return copy;
      });

      const run = await restoreInto(await server(dest));

      expect(run.stats).toMatchObject({ mediaMissing: 1, mediaDone: 2 });
      expect(destBlobs.blobs.has(other)).toBe(true);
      expect(run.status).toBe("done");
    });

    // COPY's text format reads `\055` as a minus sign, so the raw field looks like no size at all.
    it.each([
      ["a negative size", "-5000000000"],
      ["a negative size hidden in an escape", "\\0555000000000"],
    ])("does not count %s towards the server's space", async (_label, size) => {
      const real = randomBytes(800);
      const kept = await plantFile(source, real);
      const forged = await plantFile(source, randomBytes(16));
      await takeBackup();
      rewriteMediaFile((fields, columns) => {
        if (fields[columns.indexOf("hash")] !== forged) return fields;
        const copy = [...fields];
        copy[columns.indexOf("size")] = size;
        return copy;
      });

      const run = await restoreInto(await server(dest, { limit: 1000 }));

      expect(run.status).toBe("done");
      const stored = await dest.query<{ hash: string; size: string }>(
        "SELECT hash, size FROM media",
      );
      expect(stored.rows).toEqual([{ hash: kept, size: String(real.length) }]);
    });

    it("never sizes the worker pool at zero when there is work", async () => {
      const seen: string[] = [];
      await forEachFile(
        [
          { hash: "a", size: Number.NaN, type: "x" },
          { hash: "b", size: 10, type: "x" },
        ],
        new AbortController().signal,
        (row) => {
          seen.push(row.hash);
          return Promise.resolve();
        },
      );
      expect(seen.sort()).toEqual(["a", "b"]);
    });

    it("refuses by the rows' real sizes, before the lock and before any copy", async () => {
      const bytes = randomBytes(1000);
      await plantFile(source, bytes);
      await takeBackup();
      rewriteManifest((m) => ({ ...m, media: { ...m.media, bytes: 1 } }));
      const put = vi.spyOn(destBlobs.blob, "put");

      const run = await restoreInto(await server(dest, { limit: 500 }));

      expect(run.status).toBe("failed");
      expect(run.error).toMatch(/a move needs that much room/);
      expect(put).not.toHaveBeenCalled();
      expect((await settingsRows(dest)).has("writeLocked")).toBe(false);
    });

    it("fails the run when the backend stops answering a store, or a listing", async () => {
      await plantFile(source, randomBytes(16));
      await takeBackup();
      destBlobs.blob.put = () => new Promise(() => undefined);
      const hungPut = await restoreInto(await server(dest, { mediaStallMs: 20 }));
      expect(hungPut.status).toBe("failed");
      expect(hungPut.error).toMatch(/no response for/);

      await emptied(dest);
      clock.advanceSeconds(60);
      // eslint-disable-next-line require-yield
      destBlobs.blob.list = async function* () {
        await new Promise(() => undefined);
      };
      const hungList = await restoreInto(await server(dest, { mediaStallMs: 20 }));
      expect(hungList.status).toBe("failed");
      expect(hungList.error).toMatch(/could not be listed/);
    });

    it("removes the file of a photo moderated between two restores", async () => {
      const kept = await plantFile(source, randomBytes(32));
      const moderated = await plantFile(source, randomBytes(32));
      await takeBackup();
      expect((await restoreInto(await server(dest))).status).toBe("done");
      expect(destBlobs.blobs.has(moderated)).toBe(true);

      await source.query("DELETE FROM media WHERE hash = $1", [moderated]);
      clock.advanceSeconds(60);
      await takeBackup();
      await (await settingsOn(dest)).set("writeLocked", true, ADMIN);
      clock.advanceSeconds(60);

      expect((await restoreInto(await server(dest))).status).toBe("done");
      expect(destBlobs.blobs.has(moderated)).toBe(false);
      expect(destBlobs.blobs.has(kept)).toBe(true);
    });

    it("warns, and stays done, when an old file cannot be removed", async () => {
      await plantFile(source, randomBytes(32));
      const gone = await plantFile(source, randomBytes(32));
      await takeBackup();
      await restoreInto(await server(dest));
      await source.query("DELETE FROM media WHERE hash = $1", [gone]);
      clock.advanceSeconds(60);
      await takeBackup();
      await (await settingsOn(dest)).set("writeLocked", true, ADMIN);
      clock.advanceSeconds(60);
      destBlobs.blob.delete = () => Promise.reject(new Error("backend down"));

      const run = await restoreInto(await server(dest));

      expect(run.status).toBe("done");
      expect(run.warnings?.join(" ")).toMatch(/could not remove 1 file/);
      expect(restarted).toBe(2);
    });

    it("retries a store failure, and fails the run past the retries, staying locked", async () => {
      await plantFile(source, randomBytes(16));
      await takeBackup();
      const put = destBlobs.blob.put;
      let failures = 1;
      destBlobs.blob.put = (h, b, t) => {
        if (failures > 0) {
          failures -= 1;
          return Promise.reject(new Error("disk busy"));
        }
        return put(h, b, t);
      };
      expect((await restoreInto(await server(dest))).status).toBe("done");

      await emptied(dest);
      destBlobs.blobs.clear();
      restarted = 0;
      destBlobs.blob.put = () => Promise.reject(new Error("disk full"));
      const failed = await restoreInto(await server(dest));

      expect(failed.status).toBe("failed");
      expect(failed.error).toMatch(/stays locked.*disk full/);
      expect(restarted).toBe(0);
    });

    it("fails, and rolls back, when a table's file stalls", async () => {
      await seedRow(source, "room-1@restore.test");
      const manifest = await takeBackup();
      await seedRow(dest, "room-old@restore.test");
      await new PgBackupRunStore(dest).create(
        logRow("01ARZ3NDEKTSV4RRFFQ69G5FAW", { kind: "restore" }),
      );
      await (await settingsOn(dest)).set("writeLocked", true, ADMIN);
      s3.stallRead = (key) =>
        key.endsWith(manifest.tables.find((t) => t.name === "rooms")?.file ?? "x");

      const failed = await restoreInto(await server(dest, { socketTimeoutMs: 50 }));

      expect(failed.status).toBe("failed");
      expect(await destRows("rooms")).toBe(1);
      expect(await new PgBackupRunStore(dest).get("01ARZ3NDEKTSV4RRFFQ69G5FAW")).toBeDefined();
    });
  });

  describe("a failure part way", () => {
    const corruptTable = (manifest: BackupManifest, name: string): void => {
      const file = manifest.tables.find((t) => t.name === name)?.file ?? "";
      const object = s3.objects.get(keyOf(file));
      if (object) object.body = gzipSync("not\tthe\tright\tcolumns\n");
    };

    it("rolls the database back, stays locked, and a retry succeeds", async () => {
      await seedRow(source, "room-1@restore.test");
      const manifest = await takeBackup();
      const good = s3.objects.get(
        keyOf(manifest.tables.find((t) => t.name === "rooms")?.file ?? ""),
      );
      const goodBody = good?.body;
      corruptTable(manifest, "rooms");

      const failed = await restoreInto(await server(dest));

      expect(failed.status).toBe("failed");
      expect(failed.error).toMatch(/stays locked/);
      expect(restarted).toBe(0);
      expect(await destRows("rooms")).toBe(0);
      expect((await settingsRows(dest)).get("writeLocked")).toBe("true");

      if (good && goodBody) good.body = goodBody;
      const retried = await restoreInto(await server(dest));
      expect(retried.status).toBe("done");
      expect(await destRows("rooms")).toBe(1);
    });

    it("fails on a row count the manifest does not match, and rolls back", async () => {
      await seedRow(source, "room-1@restore.test");
      await takeBackup();
      rewriteManifest((m) => ({
        ...m,
        tables: m.tables.map((t) => (t.name === "rooms" ? { ...t, rows: 9 } : t)),
      }));

      const failed = await restoreInto(await server(dest));

      expect(failed.status).toBe("failed");
      expect(failed.error).toMatch(/rooms: the manifest says 9 rows, loaded 1/);
      expect(await destRows("rooms")).toBe(0);
    });

    it("refuses a manifest naming a table or column this database does not have", async () => {
      await takeBackup();
      const manifest = manifestOf();
      rewriteManifest((m) => ({
        ...m,
        tables: [...m.tables, { ...m.tables[0]!, name: "backup_runs" }],
      }));
      expect((await restoreInto(await server(dest))).error).toMatch(
        /table backup_runs is not in this database/,
      );

      rewriteManifest(() => ({
        ...manifest,
        tables: manifest.tables.map((t) =>
          t.name === "rooms" ? { ...t, columns: [...t.columns, "invented"] } : t,
        ),
      }));
      expect((await restoreInto(await server(dest))).error).toMatch(
        /column rooms\.invented is not in this database/,
      );
    });

    it("fails before the load when the lock is lifted during the file copy", async () => {
      await seedRow(source, "room-1@restore.test");
      await plantFile(source, randomBytes(16));
      await takeBackup();
      const settings = await settingsOn(dest);
      const put = destBlobs.blob.put;
      destBlobs.blob.put = async (h, b, t, s) => {
        await settings.reset("writeLocked", ADMIN);
        return put(h, b, t, s);
      };

      const run = await restoreInto(await server(dest, { settings }));

      expect(run.status).toBe("failed");
      expect(run.error).toMatch(/lock was lifted/);
      expect(run.error).not.toMatch(/stays locked/);
      expect(await destRows("rooms")).toBe(0);
      expect(restarted).toBe(0);
    });

    it("fails before the load when a place import started in the gap before the lock", async () => {
      await seedRow(source, "room-1@restore.test");
      await takeBackup();
      let checks = 0;
      const run = await restoreInto(
        await server(dest, {
          placeRunActive: () => {
            checks += 1;
            return checks > 1;
          },
        }),
      );

      expect(run.status).toBe("failed");
      expect(run.error).toMatch(/place import/);
      expect(await destRows("rooms")).toBe(0);
    });

    it("treats a lost COMMIT reply as the success it was, and restarts", async () => {
      await seedRow(source, "room-1@restore.test");
      await takeBackup();
      const connections = {
        connect: async (): Promise<PoolClient> => {
          const client = await dest.connect();
          const query = client.query.bind(client) as (...args: unknown[]) => Promise<unknown>;
          (client as unknown as { query: unknown }).query = (...args: unknown[]) =>
            args[0] === "COMMIT"
              ? query("COMMIT").then(() => {
                  throw new Error("connection lost");
                })
              : query(...args);
          return client;
        },
      };

      const run = await restoreInto(await server(dest, { connections }));

      expect(run.status).toBe("done");
      expect(run.error).toBeUndefined();
      expect(restarted).toBe(1);
      expect(await destRows("rooms")).toBe(1);
    });

    it("keeps capability nonces still inside the signing window across the load", async () => {
      await source.query(
        "INSERT INTO capability_nonces (nonce, result, expires_at) VALUES ('shared', 'from-backup', '2027-01-01T00:00:00.000Z')",
      );
      await takeBackup();
      await dest.query(
        "INSERT INTO capability_nonces (nonce, result, expires_at) VALUES " +
          "('fresh', '{}', '2027-01-01T00:00:00.000Z'), " +
          "('shared', 'from-here', '2027-01-01T00:00:00.000Z'), " +
          "('stale', '{}', '2026-01-01T00:00:00.000Z')",
      );

      expect((await restoreInto(await server(dest))).status).toBe("done");

      const rows = await dest.query<{ nonce: string; result: string }>(
        "SELECT nonce, result FROM capability_nonces ORDER BY nonce",
      );
      expect(rows.rows).toEqual([
        { nonce: "fresh", result: "{}" },
        { nonce: "shared", result: "from-backup" },
      ]);
    });

    it("closes an interrupted restore at boot, and the retry goes through", async () => {
      await seedRow(source, "room-1@restore.test");
      await takeBackup();
      const runs = new PgBackupRunStore(dest);
      await runs.create(
        logRow("01ARZ3NDEKTSV4RRFFQ69G5FAX", { kind: "restore", status: "running" }),
      );
      const svc = await server(dest);

      await svc.onApplicationBootstrap();
      expect(await svc.getRun("01ARZ3NDEKTSV4RRFFQ69G5FAX")).toMatchObject({
        status: "failed",
        error: "interrupted by server restart",
      });

      expect((await restoreInto(svc)).status).toBe("done");
      expect(await destRows("rooms")).toBe(1);
    });
  });

  describe("an older backup into a newer schema", () => {
    let later: Pool;
    let dir: string;

    beforeAll(async () => {
      await admin.query(`CREATE SCHEMA ${LATER}`);
      later = schemaPool(LATER);
      dir = mkdtempSync(join(tmpdir(), "beacon-restore-migrations-"));
      cpSync(join(__dirname, "..", "migrations", "postgres"), join(dir, "postgres"), {
        recursive: true,
      });
      writeFileSync(
        join(dir, "postgres", "9999_added_later.sql"),
        `ALTER TABLE rooms ADD COLUMN extra TEXT COLLATE "C" DEFAULT 'later';\n` +
          `ALTER TABLE backup_runs ADD COLUMN note TEXT COLLATE "C";\n`,
      );
    });

    afterAll(async () => {
      await later.end();
      await admin.query(`DROP SCHEMA ${LATER} CASCADE`);
      rmSync(dir, { recursive: true, force: true });
    });

    beforeEach(async () => {
      await later.query(`DROP SCHEMA ${LATER} CASCADE`);
      await later.query(`CREATE SCHEMA ${LATER}`);
      const client = await later.connect();
      try {
        await runMigrations(new PgMigrationExecutor(client), dir);
      } finally {
        client.release();
      }
    });

    const newest = async (): Promise<number> => {
      const res = await later.query<{ v: number }>(
        "SELECT MAX(version) AS v FROM schema_migrations",
      );
      return Number(res.rows[0]?.v);
    };

    it("loads at the backup's version, migrates on, and keeps the job log", async () => {
      await seedRow(source, "room-1@restore.test");
      await source.query("INSERT INTO nonces (nonce, result) VALUES ('n', '{}')");
      const manifest = await takeBackup();
      expect(manifest.schemaVersion).toBeLessThan(await newest());
      await later.query(
        "INSERT INTO backup_runs (id, kind, status, requested_by, target, created_at, note) VALUES ('01ARZ3NDEKTSV4RRFFQ69G5FAY', 'backup', 'done', $1, '{}', '2026-10-01T00:00:00.000Z', 'kept')",
        [ADMIN],
      );

      const svc = await server(later, { migrationsDir: dir, blobs: destBlobs.blob });
      const run = await restoreInto(svc);

      expect(run.status).toBe("done");
      expect(await newest()).toBe(9999);
      const room = await later.query<{ extra: string }>("SELECT extra FROM rooms");
      expect(room.rows).toEqual([{ extra: "later" }]);
      const log = await later.query<{ id: string; status: string; note: string | null }>(
        "SELECT id, status, note FROM backup_runs ORDER BY id",
      );
      expect(log.rows.map((r) => r.status)).toEqual(["done", "done"]);
      expect(log.rows.map((r) => r.id)).toContain("01ARZ3NDEKTSV4RRFFQ69G5FAY");
      // Put back at the shape it was kept from, so a column the backup's schema lacks is not lost.
      expect(log.rows.find((r) => r.id === "01ARZ3NDEKTSV4RRFFQ69G5FAY")?.note).toBe("kept");
      expect((await later.query("SELECT nonce FROM nonces")).rowCount).toBe(1);
    });

    it("leaves the newer schema and the job log whole when the load fails, and retries", async () => {
      await seedRow(source, "room-1@restore.test");
      const manifest = await takeBackup();
      await later.query(
        "INSERT INTO backup_runs (id, kind, status, requested_by, target, created_at) VALUES ('01ARZ3NDEKTSV4RRFFQ69G5FAZ', 'backup', 'done', $1, '{}', '2026-10-01T00:00:00.000Z')",
        [ADMIN],
      );
      const rooms = s3.objects.get(
        keyOf(manifest.tables.find((t) => t.name === "rooms")?.file ?? ""),
      );
      const goodBody = rooms?.body;
      if (rooms) rooms.body = gzipSync("bad\trow\n");
      const svc = await server(later, { migrationsDir: dir, blobs: destBlobs.blob });

      const failed = await restoreInto(svc);

      expect(failed.status).toBe("failed");
      expect(await newest()).toBe(9999);
      const log = await later.query("SELECT id FROM backup_runs");
      expect(log.rows.length).toBe(2);
      expect((await settingsRows(later)).get("writeLocked")).toBe("true");

      if (rooms && goodBody) rooms.body = goodBody;
      expect((await restoreInto(svc)).status).toBe("done");
      expect(await newest()).toBe(9999);
      const room = await later.query<{ extra: string }>("SELECT extra FROM rooms");
      expect(room.rows).toEqual([{ extra: "later" }]);
    });
  });

  describe("refusals", () => {
    const refusedWith = async (svc: BackupService, pattern: RegExp): Promise<void> => {
      const inspected = await svc.inspectRestore(target);
      expect(inspected.refusal).toMatch(pattern);
      await expect(svc.startRestore({ target }, ADMIN)).rejects.toBeInstanceOf(RestoreRefusedError);
      expect((await svc.listRuns()).filter((r) => r.kind === "restore")).toEqual([]);
    };

    it("says yes when nothing is wrong, in the wire shape", async () => {
      await takeBackup();
      const inspected = await (await server(dest)).inspectRestore(target);
      expect(inspected.refusal).toBeUndefined();
      expect(adminRestoreInspectionSchema.safeParse(inspected).success).toBe(true);
    });

    it("refuses a format it does not know, even with fields it has never seen", async () => {
      await takeBackup();
      rewriteManifest((m) => ({ ...m, format: 2, addedLater: true }) as BackupManifest);
      await refusedWith(await server(dest), /format 2, and this server reads format 1/);
    });

    it("refuses a different server when it cannot keep the backup's key", async () => {
      await takeBackup();
      await refusedWith(
        await server(dest, { did: createWallet().account.did, keyPassphrase: PASSPHRASE }),
        /no identity\.key, so take it again with its key included/,
      );
      rewriteManifest((m) => ({ ...m, identity: true }));
      await refusedWith(
        await server(dest, { did: createWallet().account.did }),
        /set BEACON_KEY_PASSPHRASE/,
      );
    });

    it("refuses a server name that could not be minted into an id", async () => {
      await takeBackup();
      rewriteManifest((m) => ({ ...m, host: "bad name/here" }));
      await refusedWith(await server(dest), /is not one a server can use/);
    });

    it("refuses a database the manifest already says is over the limit", async () => {
      const manifest = await takeBackup();
      const size = manifest.tables.reduce((sum, t) => sum + t.bytes, 0);
      await refusedWith(await server(dest, { databaseLimit: size - 1 }), /this server may load/);
    });

    it("refuses a newer schema, saying to upgrade", async () => {
      await takeBackup();
      rewriteManifest((m) => ({ ...m, schemaVersion: m.schemaVersion + 1 }));
      await refusedWith(await server(dest), /upgrade the server first/);
    });

    it("refuses when the media will not fit under the limit", async () => {
      await plantFile(source, randomBytes(1000));
      await takeBackup();
      await refusedWith(await server(dest, { limit: 999 }), /a move needs that much room/);
    });

    it("refuses while a place import is running", async () => {
      await takeBackup();
      await refusedWith(await server(dest, { placeRunActive: true }), /place import/);
    });

    it.each(["rooms", "profiles", "media", "mailbox", "place_sources"])(
      "refuses a server holding player data in %s",
      async (table) => {
        await takeBackup();
        await seedRow(dest, "x@restore.test");
        if (table !== "rooms") {
          await dest.query("TRUNCATE rooms");
          const cols = await dest.query<{
            column_name: string;
            data_type: string;
            is_nullable: string;
          }>(
            "SELECT column_name, data_type, is_nullable FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = $1 AND column_default IS NULL",
            [table],
          );
          const names = cols.rows.map((c) => c.column_name);
          const placeholders = cols.rows.map((c) =>
            c.is_nullable === "NO"
              ? c.data_type === "text"
                ? "'x'"
                : c.data_type.startsWith("json")
                  ? "'{}'"
                  : "0"
              : "NULL",
          );
          await dest.query(
            `INSERT INTO ${table} (${names.join(",")}) VALUES (${placeholders.join(",")})`,
          );
        }
        await refusedWith(await server(dest), /holds player data/);
      },
    );

    it("allows a server this job already restored, only while it is locked", async () => {
      await seedRow(source, "room-1@restore.test");
      await takeBackup();
      const first = await server(dest);
      expect((await restoreInto(first)).status).toBe("done");

      // The restored settings table has no lock, as the backup was live.
      await expect((await server(dest)).startRestore({ target }, ADMIN)).rejects.toBeInstanceOf(
        RestoreRefusedError,
      );

      await (await settingsOn(dest)).set("writeLocked", true, ADMIN);
      clock.advanceSeconds(60);
      expect((await restoreInto(await server(dest))).status).toBe("done");
    });

    it("refuses at the door when the endpoint is not allowed", async () => {
      await takeBackup();
      const fenced = new BackupService(new PgBackupRunStore(dest), {
        connections: dest,
        blobs: destBlobs.blob,
        settings: await settingsOn(dest),
        identity: { account: { did: ADMIN }, recoveryPhrase: () => Promise.resolve(undefined) },
        config: { host: HOST, version: "1.2.3" },
        env: {},
        placeRunActive: () => false,
        restart: () => undefined,
        bucket: { allowPrivateEndpoints: false },
      });
      services.push(fenced);
      await expect(fenced.inspectRestore(target)).rejects.toThrow(/not a public address/);
      await expect(fenced.startRestore({ target }, ADMIN)).rejects.toThrow(/not a public address/);
    });
  });

  describe("the admin routes", () => {
    const routes = (svc: BackupService) => {
      const nonces = memoryNonces();
      const nonce = new NonceService(nonces, { retentionMs: 600_000, writeLocked: false });
      const gate = new AdminGate(testSignedRequestGate(), nonce, [ADMIN]);
      return { controller: new BackupController(svc, gate, nonce), nonces };
    };
    const sign = (op: string, nonce: string): unknown =>
      signOpWithWallet(wallet, {
        op,
        nonce,
        params: { target } as unknown as Record<string, unknown>,
      });
    const failure = async (p: Promise<unknown>): Promise<HttpException> => {
      try {
        await p;
      } catch (err) {
        return err as HttpException;
      }
      throw new Error("expected a refusal");
    };

    it("inspects, and answers a manifest that does not parse with a 400", async () => {
      await takeBackup();
      const { controller } = routes(await server(dest));

      const answer = await controller.inspect(sign("admin.restore.inspect", ulid()));
      expect(answer.ok).toBe(true);
      expect(answer.manifest.host).toBe(HOST);

      rewriteManifest(() => ({ nonsense: true }) as unknown as BackupManifest);
      expect(
        (await failure(controller.inspect(sign("admin.restore.inspect", ulid())))).getStatus(),
      ).toBe(400);
      s3.objects.set(keyOf("manifest.json"), {
        body: Buffer.from("{ not json"),
        contentType: undefined,
        cacheControl: undefined,
      });
      expect(
        (await failure(controller.inspect(sign("admin.restore.inspect", ulid())))).getStatus(),
      ).toBe(400);
      s3.objects.delete(keyOf("manifest.json"));
      expect(
        (await failure(controller.inspect(sign("admin.restore.inspect", ulid())))).getStatus(),
      ).toBe(400);
    });

    it("starts, is idempotent by nonce, and holds no credentials anywhere", async () => {
      await seedRow(source, "room-1@restore.test");
      await takeBackup();
      const svc = await server(dest);
      const { controller, nonces } = routes(svc);
      const log = vi.spyOn(Logger.prototype, "log");
      const nonce = ulid();

      const started = await controller.restore(sign("admin.restore.start", nonce));
      expect(started.run.kind).toBe("restore");
      await svc.idle();
      expect((await controller.restore(sign("admin.restore.start", nonce))).run.id).toBe(
        started.run.id,
      );

      const memo = await nonces.get(
        { actor: ADMIN, op: "admin.restore.start", nonce },
        "2000-01-01T00:00:00.000Z",
      );
      expect(memo?.result).toBe(JSON.stringify({ id: started.run.id }));
      const rows = JSON.stringify((await dest.query("SELECT * FROM backup_runs")).rows);
      const logged = log.mock.calls.map((c) => String(c[0])).join("\n");
      for (const text of [rows, logged]) {
        expect(text).not.toContain(ACCESS_KEY);
        expect(text).not.toContain(SECRET_KEY);
      }
    });

    it("still answers a retried start after the load replaced the nonce log", async () => {
      await seedRow(source, "room-1@restore.test");
      await takeBackup();
      const svc = await server(dest);
      const nonce = new NonceService(new PgNonceStore(dest), {
        retentionMs: 600_000,
        writeLocked: false,
      });
      const gate = new AdminGate(testSignedRequestGate(), nonce, [ADMIN]);
      const controller = new BackupController(svc, gate, nonce);
      const sent = ulid();

      const started = await controller.restore(sign("admin.restore.start", sent));
      await svc.idle();

      const replayed = await controller.restore(sign("admin.restore.start", sent));
      expect(replayed.run.id).toBe(started.run.id);
    });

    it("answers a refusal with a 400 that leaves the nonce free, and a busy slot with a 409", async () => {
      await takeBackup();
      await seedRow(dest, "held@restore.test");
      const { controller, nonces } = routes(await server(dest));
      const nonce = ulid();
      expect(
        (await failure(controller.restore(sign("admin.restore.start", nonce)))).getStatus(),
      ).toBe(400);
      expect(
        await nonces.get(
          { actor: ADMIN, op: "admin.restore.start", nonce },
          "2000-01-01T00:00:00.000Z",
        ),
      ).toBeUndefined();

      await emptied(dest);
      await (await settingsOn(dest)).set("writeLocked", true, ADMIN);
      const holder = new BackupService(new PgBackupRunStore(dest), {
        connections: dest,
        blobs: destBlobs.blob,
        settings: await settingsOn(dest),
        identity: { account: { did: ADMIN }, recoveryPhrase: () => Promise.resolve(undefined) },
        config: { host: HOST, version: "1.2.3" },
        env: {},
        now: clock.now,
        sleep: (_ms, signal) =>
          new Promise((_resolve, reject) => {
            signal.addEventListener("abort", () => reject(signal.reason as Error));
          }),
        placeRunActive: () => false,
        restart: () => undefined,
        bucket: { allowPrivateEndpoints: true },
      });
      services.push(holder);
      await holder.startRestore({ target }, ADMIN);
      const { controller: busy } = routes(holder);
      expect((await failure(busy.restore(sign("admin.restore.start", ulid())))).getStatus()).toBe(
        409,
      );
      await expect(holder.start({ target, includeIdentity: false }, ADMIN)).rejects.toThrow(
        /already queued or running/,
      );
    });
  });

  describe("listing the blob backend", () => {
    it("pages through an S3 prefix, by hash and size, leaving out anything else there", async () => {
      s3.pageSize = 1;
      const store = new S3MediaBlobStore({
        endpoint,
        region: "us-east-1",
        bucket: "media",
        accessKeyId: ACCESS_KEY,
        secretAccessKey: SECRET_KEY,
        forcePathStyle: true,
        prefix: "live/",
      });
      const first = Buffer.from("sized");
      const second = Buffer.from("sized twice");
      await store.put(sha256Base64url(first), first, "text/plain");
      await store.put(sha256Base64url(second), second, "text/plain");
      s3.objects.set("live/stray.txt", {
        body: Buffer.from("x"),
        contentType: undefined,
        cacheControl: undefined,
      });

      const found = new Map<string, number>();
      for await (const entry of store.list()) found.set(entry.hash, entry.size);

      expect(found).toEqual(
        new Map([
          [sha256Base64url(first), first.length],
          [sha256Base64url(second), second.length],
        ]),
      );
      store.close();
    });
  });
});
