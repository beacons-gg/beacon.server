import { randomBytes } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { sha256Base64url, createWallet, signOpWithWallet } from "@beaconsgg/identity";
import {
  adminBackupRunsSchema,
  backupManifestSchema,
  backupRunSchema,
  type BackupManifest,
  type BackupRun,
  type BackupS3Target,
} from "@beaconsgg/protocol-types";
import { HttpException, Logger } from "@nestjs/common";
import { Pool, type PoolClient } from "pg";
import { Readable } from "node:stream";
import { ulid } from "ulid";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { BACKUP_EXCLUDED_TABLES, discoverTables } from "../backup/backup-db";
import { LOCK_SETTLE_MS, RunProgress, safeRunError } from "../backup/backup-job";
import { emptyStats, type BackupRunStore } from "../stores/backup-run-store";
import { PgBackupRunStore } from "../stores/backup-run.pg.store";
import {
  BackupBucket,
  BackupEndpointError,
  checkBackupEndpoint,
  isNonPublicAddress,
} from "../backup/backup-target";
import { BackupController } from "../backup/backup.controller";
import { BackupBusyError, BackupService } from "../backup/backup.service";
import { AdminGate } from "../common/admin-gate";
import { NonceService } from "../common/nonce.service";
import { S3MediaBlobStore } from "../media/media-blob";
import { runtimeSettingsFrom } from "../settings/registry";
import { SettingsService } from "../settings/settings.service";
import { migrate } from "../stores/pg.migrations";
import { PgSettingsStore } from "../stores/settings.pg.store";
import { FakeS3 } from "./fake-s3";
import { memoryNonces } from "./memory-stores";
import { testDatabaseUrl } from "./pg-twin";
import { testConfig } from "./test-config";
import { memoryBlobStore, makeClock, testSignedRequestGate } from "./test-helpers";

/**
 * Backups, against real Postgres and the real AWS SDK talking to an in-process S3 ({@link FakeS3}).
 * The suite runs in a schema of its own, because `discoverTables` walks a schema and the parity
 * suites truncate the shared tables from other workers.
 */

const SCHEMA = `backup_test_${process.pid}_${randomBytes(4).toString("hex")}`;
const ACCESS_KEY = "ACCESSKEYIDVALUE123";
const SECRET_KEY = "s3cr3t-secret-access-key-value";
const PHRASE = "legal winner thank year wave sausage worth useful legal winner thank yellow";

const EXCLUDED = ["schema_migrations", "backup_runs", "restored_identity"];

const wallet = createWallet();
const ADMIN = wallet.account.did;

describe("backup", () => {
  let adminPool: Pool;
  let pool: Pool;
  let s3: FakeS3;
  let endpoint: string;
  let target: BackupS3Target;
  let runs: PgBackupRunStore;
  let clock: ReturnType<typeof makeClock>;
  let slept: number[];
  let blobStore: ReturnType<typeof memoryBlobStore>;
  const services: BackupService[] = [];

  beforeAll(async () => {
    adminPool = new Pool({ connectionString: testDatabaseUrl(), max: 1 });
    await adminPool.query(`CREATE SCHEMA ${SCHEMA}`);
    const url = new URL(testDatabaseUrl());
    url.searchParams.set("options", `-c search_path=${SCHEMA}`);
    pool = new Pool({ connectionString: url.href, max: 4 });
    await migrate(pool);
    s3 = new FakeS3();
    endpoint = await s3.start();
  });

  afterAll(async () => {
    await pool.end();
    await adminPool.query(`DROP SCHEMA ${SCHEMA} CASCADE`);
    await adminPool.end();
    await s3.close();
  });

  beforeEach(async () => {
    s3.reset();
    const tables = await pool.query<{ table_name: string }>(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema() AND table_type = 'BASE TABLE' AND table_name <> 'schema_migrations'",
    );
    await pool.query(`TRUNCATE ${tables.rows.map((r) => r.table_name).join(", ")}`);
    runs = new PgBackupRunStore(pool);
    clock = makeClock("2026-11-08T12:00:00.000Z");
    slept = [];
    blobStore = memoryBlobStore();
    target = {
      endpoint,
      region: "us-east-1",
      bucket: "backups",
      prefix: "srv/one",
      accessKeyId: ACCESS_KEY,
      secretAccessKey: SECRET_KEY,
      forcePathStyle: true,
    };
  });

  afterEach(async () => {
    await Promise.all(services.splice(0).map((s) => s.onModuleDestroy()));
    vi.restoreAllMocks();
  });

  const keyOf = (path: string): string => `srv/one/${path}`;

  /** Settings as a server boots with them, over the real `settings` table. */
  async function settingsWith(env: NodeJS.ProcessEnv = {}): Promise<SettingsService> {
    const svc = new SettingsService(
      new PgSettingsStore(pool),
      runtimeSettingsFrom(testConfig(env)),
      clock.now,
    );
    await svc.load();
    return svc;
  }

  function service(
    settings: SettingsService,
    over: {
      env?: NodeJS.ProcessEnv;
      phrase?: string | undefined;
      recoveryPhrase?: () => Promise<string | undefined>;
      sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
      runStore?: BackupRunStore;
      connections?: { connect(): Promise<PoolClient> };
      mediaStallMs?: number;
      socketTimeoutMs?: number;
      allowPrivateEndpoints?: boolean;
    } = {},
  ): BackupService {
    const svc = new BackupService(over.runStore ?? runs, {
      connections: over.connections ?? pool,
      blobs: blobStore.blob,
      settings,
      identity: {
        account: { did: ADMIN },
        recoveryPhrase:
          over.recoveryPhrase ?? (() => Promise.resolve("phrase" in over ? over.phrase : PHRASE)),
      },
      placeRunActive: () => false,
      restart: () => undefined,
      bucket: {
        allowPrivateEndpoints: over.allowPrivateEndpoints ?? true,
        ...(over.socketTimeoutMs !== undefined ? { socketTimeoutMs: over.socketTimeoutMs } : {}),
      },
      ...(over.mediaStallMs !== undefined ? { mediaStallMs: over.mediaStallMs } : {}),
      config: { host: "backup.test", version: "1.2.3" },
      env: over.env ?? {},
      now: clock.now,
      sleep:
        over.sleep ??
        ((ms) => {
          slept.push(ms);
          clock.advanceSeconds(ms / 1000);
          return Promise.resolve();
        }),
    });
    services.push(svc);
    return svc;
  }

  const params = (
    includeIdentity = true,
  ): { target: BackupS3Target; includeIdentity: boolean } => ({
    target,
    includeIdentity,
  });

  async function runBackupOn(svc: BackupService, includeIdentity = true): Promise<BackupRun> {
    const queued = await svc.start(params(includeIdentity), ADMIN);
    await svc.idle();
    const finished = await svc.getRun(queued.id);
    if (!finished) throw new Error("run missing");
    backupRunSchema.parse(finished);
    return finished;
  }

  function manifest(): BackupManifest {
    const found = s3.objects.get(keyOf("manifest.json"));
    if (!found) throw new Error("no manifest");
    return backupManifestSchema.parse(JSON.parse(found.body.toString("utf8")));
  }

  /** A table's COPY text rows, from its gzipped file. */
  function copyRows(m: BackupManifest, name: string): string[][] {
    const entry = m.tables.find((t) => t.name === name);
    if (!entry) throw new Error(`no table ${name}`);
    const object = s3.objects.get(keyOf(entry.file));
    if (!object) throw new Error(`no file ${entry.file}`);
    const text = gunzipSync(object.body).toString("utf8");
    return text
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => line.split("\t"));
  }

  async function plantMedia(bytes: Buffer, type = "image/jpeg"): Promise<string> {
    const hash = sha256Base64url(bytes);
    await pool.query(
      "INSERT INTO media (hash, type, size, owner, uploaded_at, last_access_at) VALUES ($1, $2, $3, $4, $5, NULL)",
      [hash, type, bytes.length, ADMIN, "2026-11-08T00:00:00.000Z"],
    );
    return hash;
  }

  /** A media row and a blob the server holds, whose bytes hash to the row. */
  async function plantFile(bytes: Buffer, type?: string): Promise<string> {
    const hash = await plantMedia(bytes, type);
    await blobStore.blob.put(hash, bytes, type ?? "image/jpeg");
    return hash;
  }

  describe("a live backup", () => {
    it("writes the database, the files, the key and the manifest", async () => {
      const bytes = randomBytes(2048);
      const hash = await plantFile(bytes, "image/webp");
      const settings = await settingsWith();

      const run = await runBackupOn(service(settings));

      expect(run.status).toBe("done");
      expect(run.locked).toBe(false);
      expect(run.finishedAt).toBeDefined();
      const m = manifest();
      expect(m).toMatchObject({
        format: 1,
        host: "backup.test",
        did: ADMIN,
        serverVersion: "1.2.3",
        locked: false,
        identity: true,
        media: { count: 1, bytes: 2048, missing: 0 },
      });
      const migrated = await pool.query<{ v: number }>(
        "SELECT MAX(version) AS v FROM schema_migrations",
      );
      expect(m.schemaVersion).toBe(migrated.rows[0]?.v);

      const media = copyRows(m, "media");
      expect(media).toHaveLength(1);
      expect(media[0]?.[0]).toBe(hash);
      // A table's size is its uploaded, compressed file.
      const entry = m.tables.find((t) => t.name === "media");
      expect(entry).toMatchObject({ rows: 1 });
      expect(s3.objects.get(keyOf(entry?.file ?? ""))?.body.length).toBe(entry?.bytes);

      // The timestamp fits the manifest's path rule.
      expect(entry?.file).toMatch(/^db\/[A-Za-z0-9._-]+\/media\.copy\.gz$/);

      const file = s3.objects.get(keyOf(`media/${hash.slice(0, 2)}/${hash}`));
      expect(file?.body.equals(bytes)).toBe(true);
      expect(file?.contentType).toBe("image/webp");
      expect(file?.cacheControl).toBe("public, max-age=31536000, immutable");

      expect(s3.objects.get(keyOf("identity.key"))?.body.toString("utf8")).toBe(`${PHRASE}\n`);
      expect(run.stats).toMatchObject({
        mediaDone: 1,
        mediaTotal: 1,
        mediaBytes: 2048,
        mediaSkipped: 0,
        mediaMissing: 0,
        tablesTotal: m.tables.length,
        tablesDone: m.tables.length,
      });
    });

    it("writes the manifest last, after every other object", async () => {
      await plantFile(randomBytes(64));
      await runBackupOn(service(await settingsWith()));
      expect(s3.writes.at(-1)).toBe(keyOf("manifest.json"));
      expect(s3.writes.filter((k) => k === keyOf("manifest.json"))).toHaveLength(1);
      // Everything else in the bucket was written before it.
      expect(new Set(s3.writes)).toEqual(new Set(s3.objects.keys()));
    });

    it("leaves the previous good backup intact when a run dies before its manifest", async () => {
      const settings = await settingsWith();
      const svc = service(settings);
      await runBackupOn(svc);
      const before = s3.objects.get(keyOf("manifest.json"))?.body;
      const beforeFile = s3.objects.get(keyOf(manifest().tables[0]?.file ?? ""));
      expect(before).toBeDefined();

      clock.advanceSeconds(60);
      s3.refuseWrite = (key) => key.endsWith("manifest.json");
      const failed = await runBackupOn(svc);

      expect(failed.status).toBe("failed");
      expect(s3.objects.get(keyOf("manifest.json"))?.body.equals(before as Buffer)).toBe(true);
      // The old folder the old manifest names is still there: removal waits for a new manifest.
      expect(s3.objects.get(keyOf(manifest().tables[0]?.file ?? ""))).toBe(beforeFile);
    });

    it("removes earlier database folders once the new manifest is in, keeping its own", async () => {
      const svc = service(await settingsWith());
      await runBackupOn(svc);
      const first = manifest().tables[0]?.file ?? "";
      const folderOf = (file: string): string => file.split("/")[1] ?? "";

      clock.advanceSeconds(60);
      await runBackupOn(svc);

      const m = manifest();
      expect(s3.objects.has(keyOf(first))).toBe(false);
      for (const table of m.tables) expect(s3.objects.has(keyOf(table.file))).toBe(true);
      expect(new Set(m.tables.map((t) => folderOf(t.file))).size).toBe(1);
    });

    it("keeps the data of the snapshot it took, not rows committed while files copy", async () => {
      const hash = await plantFile(randomBytes(16));
      const late = randomBytes(32);
      const read = blobStore.blob.read;
      let inserted = false;
      blobStore.blob.read = async (h) => {
        if (!inserted) {
          inserted = true;
          await plantMedia(late); // a row committed mid-run, after the snapshot closed
        }
        return read(h);
      };
      await runBackupOn(service(await settingsWith()));
      const m = manifest();
      expect(m.media.count).toBe(1);
      expect(copyRows(m, "media").map((r) => r[0])).toEqual([hash]);
    });
  });

  describe("the lock", () => {
    it("waits until a fresh lock is 15 seconds old, then records locked", async () => {
      const settings = await settingsWith();
      await settings.set("writeLocked", true, ADMIN);
      clock.advanceSeconds(5); // 5 seconds into the lock

      const run = await runBackupOn(service(settings));

      expect(slept).toEqual([LOCK_SETTLE_MS - 5000]);
      expect(run.locked).toBe(true);
      expect(manifest().locked).toBe(true);
    });

    it("takes the age of a lock set by environment from the process start, and carries it", async () => {
      const env = { BEACON_WRITE_LOCK: "1" };
      const settings = await settingsWith(env);

      const run = await runBackupOn(service(settings, { env }));

      // No `updatedAt` on an env lock, so the clock it is judged by is PROCESS_STARTED_AT.
      expect(slept).toHaveLength(1);
      expect(run.locked).toBe(true);
      expect(copyRows(manifest(), "settings").map((r) => r[0])).toContain("writeLocked");
    });

    it("does not wait for an old lock", async () => {
      const settings = await settingsWith();
      await settings.set("writeLocked", true, ADMIN);
      clock.advanceSeconds(120);
      await runBackupOn(service(settings));
      expect(slept).toEqual([]);
      expect(manifest().locked).toBe(true);
    });

    it("says not locked when the lock is lifted during the run, and warns", async () => {
      const settings = await settingsWith();
      await settings.set("writeLocked", true, ADMIN);
      clock.advanceSeconds(120);
      await plantFile(randomBytes(8));
      const read = blobStore.blob.read;
      blobStore.blob.read = async (hash) => {
        await settings.reset("writeLocked", ADMIN);
        return read(hash);
      };

      const run = await runBackupOn(service(settings));

      expect(manifest().locked).toBe(false);
      expect(run.locked).toBe(false);
      expect(run.warnings?.join(" ")).toMatch(/unlocked during this backup/);
    });
  });

  describe("a lock saved again during the run", () => {
    it("still records locked, because the row was not rewritten", async () => {
      const settings = await settingsWith();
      await settings.set("writeLocked", true, ADMIN);
      clock.advanceSeconds(120);
      await plantFile(randomBytes(8));
      const read = blobStore.blob.read;
      blobStore.blob.read = async (hash, signal) => {
        clock.advanceSeconds(5);
        await settings.set("writeLocked", true, ADMIN); // a console re-saving the form
        return read(hash, signal);
      };

      const run = await runBackupOn(service(settings));

      expect(run.locked).toBe(true);
      expect(manifest().locked).toBe(true);
      expect(run.warnings).toBeUndefined();
    });
  });

  describe("what the database phase discovers", () => {
    let client: PoolClient;
    beforeAll(async () => {
      await pool.query(
        'CREATE TABLE backup_extra (b TEXT COLLATE "C", a INT, g INT GENERATED ALWAYS AS (a * 2) STORED)',
      );
      await pool.query("CREATE VIEW backup_view AS SELECT a FROM backup_extra");
    });
    afterAll(async () => {
      await pool.query("DROP VIEW backup_view");
      await pool.query("DROP TABLE backup_extra");
    });
    beforeEach(async () => {
      client = await pool.connect();
    });
    afterEach(() => {
      client.release();
    });

    it("finds every base table in ordinal column order, without the excluded ones", async () => {
      const tables = await discoverTables(client);
      const names = tables.map((t) => t.name);

      expect(names).toContain("rooms");
      expect(names).toContain("media");
      for (const excluded of EXCLUDED) {
        expect(names).not.toContain(excluded);
        expect(BACKUP_EXCLUDED_TABLES.has(excluded)).toBe(true);
      }
      expect(tables.find((t) => t.name === "backup_view")).toBeUndefined();
      // A generated column cannot be loaded back, and comes back from the schema anyway.
      expect(tables.find((t) => t.name === "backup_extra")?.columns).toEqual(["b", "a"]);
    });

    it("fails fast on a name the manifest would refuse", async () => {
      await client.query(`CREATE TABLE "BadName" (a int)`);
      try {
        await expect(discoverTables(client)).rejects.toThrow();
      } finally {
        await client.query(`DROP TABLE "BadName"`);
      }
    });
  });

  describe("env-only settings", () => {
    it("writes exported env settings as rows, leaves defaults and the live table alone", async () => {
      const env = {
        BEACON_NAME: "From the Environment",
        BEACON_CONTACT: "ops@example.test",
      };
      const settings = await settingsWith(env);
      await settings.set("description", "set by an admin", ADMIN);

      await runBackupOn(service(settings, { env }));

      const m = manifest();
      const rows = new Map(copyRows(m, "settings").map((r) => [r[0], r]));
      expect(rows.get("name")?.[1]).toBe('"From the Environment"');
      expect(rows.get("name")?.[2]).toBe(ADMIN); // the requester, who took the backup
      expect(rows.get("contact")?.[1]).toBe('"ops@example.test"');
      expect(rows.get("description")?.[1]).toBe('"set by an admin"');
      // Not exported, so it stays the new server's default rather than a pinned copy of today's.
      expect(rows.has("about")).toBe(false);
      expect(rows.has("accessLevel")).toBe(false);

      const live = await pool.query("SELECT key FROM settings ORDER BY key");
      expect(live.rows.map((r: { key: string }) => r.key)).toEqual(["description"]);
      expect(m.tables.find((t) => t.name === "settings")?.rows).toBe(rows.size);
    });

    it("selects a settings column added later by name, with NULL in the env-only rows", async () => {
      await pool.query('ALTER TABLE settings ADD COLUMN note TEXT COLLATE "C"');
      try {
        const env = { BEACON_NAME: "From the Environment" };
        const settings = await settingsWith(env);
        await settings.set("description", "set by an admin", ADMIN);

        const run = await runBackupOn(service(settings, { env }));

        expect(run.status).toBe("done");
        const m = manifest();
        expect(m.tables.find((t) => t.name === "settings")?.columns).toEqual([
          "key",
          "value",
          "updated_by",
          "updated_at",
          "note",
        ]);
        const rows = new Map(copyRows(m, "settings").map((r) => [r[0], r]));
        expect(rows.get("name")?.[4]).toBe("\\N");
        expect(rows.get("description")?.[1]).toBe('"set by an admin"');
      } finally {
        await pool.query("ALTER TABLE settings DROP COLUMN note");
      }
    });

    it("prefers a stored row over the env value when both exist", async () => {
      const env = { BEACON_CONTACT: "env@example.test" };
      const settings = await settingsWith(env);
      await settings.set("contact", "admin@example.test", ADMIN);

      await runBackupOn(service(settings, { env }));

      const rows = copyRows(manifest(), "settings").filter((r) => r[0] === "contact");
      expect(rows).toEqual([["contact", '"admin@example.test"', ADMIN, expect.any(String)]]);
    });

    it("leaves out, with a warning, an env value the settings table would refuse", async () => {
      const env = { BEACON_PUBLIC_URL: "not-a-url" };
      const settings = await settingsWith(env);

      const run = await runBackupOn(service(settings, { env }));

      expect(copyRows(manifest(), "settings").map((r) => r[0])).not.toContain("publicUrl");
      expect(run.warnings?.join(" ")).toMatch(/publicUrl from BEACON_PUBLIC_URL/);
    });
  });

  describe("files", () => {
    it("skips a file already there with the right size, without reading it", async () => {
      const bytes = randomBytes(128);
      const hash = await plantFile(bytes);
      const path = keyOf(`media/${hash.slice(0, 2)}/${hash}`);
      s3.objects.set(path, { body: bytes, contentType: "image/jpeg", cacheControl: undefined });
      const read = vi.spyOn(blobStore.blob, "read");

      const run = await runBackupOn(service(await settingsWith()));

      expect(read).not.toHaveBeenCalled();
      expect(run.stats).toMatchObject({ mediaDone: 1, mediaSkipped: 1, mediaBytes: 128 });
      expect(run.status).toBe("done");
    });

    it("finds existing files across every page of the listing", async () => {
      s3.pageSize = 1;
      for (let i = 0; i < 3; i += 1) {
        const bytes = randomBytes(16);
        const hash = await plantFile(bytes);
        s3.objects.set(keyOf(`media/${hash.slice(0, 2)}/${hash}`), {
          body: bytes,
          contentType: "image/jpeg",
          cacheControl: undefined,
        });
      }
      const read = vi.spyOn(blobStore.blob, "read");

      const run = await runBackupOn(service(await settingsWith()));

      expect(read).not.toHaveBeenCalled();
      expect(run.stats).toMatchObject({ mediaDone: 3, mediaSkipped: 3 });
    });

    it("drains the files in flight before the run ends, when one worker fails", async () => {
      const bad = randomBytes(16);
      const good = randomBytes(16);
      const badHash = await plantFile(bad);
      const goodHash = await plantFile(good);
      const read = blobStore.blob.read;
      blobStore.blob.read = async (hash, signal) => {
        if (hash === badHash) throw new Error("backend down");
        await new Promise((resolve) => setTimeout(resolve, 50));
        return read(hash, signal);
      };

      const run = await runBackupOn(service(await settingsWith()));

      expect(run.status).toBe("failed");
      expect(s3.writes).toContain(keyOf(`media/${goodHash.slice(0, 2)}/${goodHash}`));
    });

    it("sizes its workers from the largest file against the byte budget", async () => {
      const peakReads = async (): Promise<number> => {
        let reading = 0;
        let peak = 0;
        blobStore.blob.read = async () => {
          reading += 1;
          peak = Math.max(peak, reading);
          await new Promise((resolve) => setTimeout(resolve, 5));
          reading -= 1;
          return undefined;
        };
        await runBackupOn(service(await settingsWith()));
        return peak;
      };
      for (let i = 0; i < 12; i += 1) await plantMedia(randomBytes(16));
      expect(await peakReads()).toBe(4);

      // A row, not a real file: only its size matters, and 40 MB leaves room for one under 48 MB.
      await pool.query(
        "INSERT INTO media (hash, type, size, owner, uploaded_at, last_access_at) VALUES ('big', 'image/jpeg', 40000000, $1, 'x', NULL)",
        [ADMIN],
      );
      clock.advanceSeconds(60);
      expect(await peakReads()).toBe(1);
    });

    it("replaces a file with the wrong size", async () => {
      const bytes = randomBytes(128);
      const hash = await plantFile(bytes);
      const path = keyOf(`media/${hash.slice(0, 2)}/${hash}`);
      s3.objects.set(path, {
        body: bytes.subarray(0, 10),
        contentType: undefined,
        cacheControl: undefined,
      });

      const run = await runBackupOn(service(await settingsWith()));

      expect(run.stats).toMatchObject({ mediaSkipped: 0, mediaDone: 1 });
      expect(s3.objects.get(path)?.body.equals(bytes)).toBe(true);
    });

    it("counts a missing or corrupt file, lists it, and still finishes", async () => {
      const good = randomBytes(64);
      await plantFile(good);
      const missing = await plantMedia(randomBytes(64));
      const corruptBytes = randomBytes(64);
      const corrupt = await plantMedia(corruptBytes);
      await blobStore.blob.put(corrupt, randomBytes(64), "image/jpeg"); // same size, wrong content
      const tooLong = randomBytes(32);
      const longHash = await plantMedia(tooLong);
      await blobStore.blob.put(longHash, Buffer.concat([tooLong, Buffer.alloc(8)]), "image/jpeg");

      const run = await runBackupOn(service(await settingsWith()));

      expect(run.status).toBe("done");
      expect(run.stats).toMatchObject({ mediaMissing: 3, mediaDone: 4, mediaSkipped: 0 });
      expect(s3.objects.has(keyOf(`media/${missing.slice(0, 2)}/${missing}`))).toBe(false);
      expect(s3.objects.has(keyOf(`media/${corrupt.slice(0, 2)}/${corrupt}`))).toBe(false);
      const list = s3.objects.get(keyOf("media-missing.txt"))?.body.toString("utf8") ?? "";
      expect(list.trim().split("\n").sort()).toEqual([missing, corrupt, longHash].sort());
      expect(manifest().media).toMatchObject({ count: 4, missing: 3 });
      expect(run.warnings?.join(" ")).toMatch(/file is missing from this server/);
      expect(run.warnings?.join(" ")).toMatch(/does not match its hash/);
    });

    it("retries a media backend error, and the file is not missing", async () => {
      const bytes = randomBytes(32);
      const hash = await plantFile(bytes);
      const read = blobStore.blob.read;
      let failures = 2;
      blobStore.blob.read = (h, signal) => {
        if (failures > 0) {
          failures -= 1;
          return Promise.reject(new Error("backend down"));
        }
        return read(h, signal);
      };

      const run = await runBackupOn(service(await settingsWith()));

      expect(run.status).toBe("done");
      expect(run.stats?.mediaMissing).toBe(0);
      expect(s3.objects.get(keyOf(`media/${hash.slice(0, 2)}/${hash}`))?.body.equals(bytes)).toBe(
        true,
      );
    });

    it("fails the run past the retries, leaving the previous backup and its folders", async () => {
      const svc = service(await settingsWith());
      await runBackupOn(svc);
      const before = s3.objects.get(keyOf("manifest.json"))?.body;
      const oldFile = manifest().tables[0]?.file ?? "";

      clock.advanceSeconds(60);
      await plantFile(randomBytes(32));
      blobStore.blob.read = () => Promise.reject(new Error("backend down"));
      const run = await runBackupOn(svc);

      expect(run.status).toBe("failed");
      expect(run.error).toMatch(/could not be read after 3 attempts: backend down/);
      expect(s3.objects.get(keyOf("manifest.json"))?.body.equals(before as Buffer)).toBe(true);
      expect(s3.objects.has(keyOf(oldFile))).toBe(true);
      expect(s3.objects.has(keyOf("media-missing.txt"))).toBe(false);
    });

    it("fails the run when a media read hangs before it answers, and frees the slot", async () => {
      await plantFile(randomBytes(32));
      blobStore.blob.read = () => new Promise(() => undefined);
      const svc = service(await settingsWith(), { mediaStallMs: 20 });

      const run = await runBackupOn(svc);

      expect(run.status).toBe("failed");
      expect(run.error).toMatch(/no data for 20ms/);

      clock.advanceSeconds(60);
      blobStore.blob.read = () => Promise.resolve(undefined);
      expect((await runBackupOn(svc)).status).toBe("done");
    });

    it("fails the run when a media stream stalls part way through", async () => {
      await plantFile(randomBytes(32));
      blobStore.blob.read = () => {
        const stream = new Readable({ read: () => undefined });
        stream.push(Buffer.alloc(4));
        return Promise.resolve(stream);
      };

      const run = await runBackupOn(service(await settingsWith(), { mediaStallMs: 20 }));

      expect(run.status).toBe("failed");
      expect(run.error).toMatch(/no data for 20ms/);
    });

    it("fails the run when the destination stops answering", async () => {
      await plantFile(randomBytes(32));
      s3.hangWrite = (key) => key.endsWith("manifest.json");

      const run = await runBackupOn(service(await settingsWith(), { socketTimeoutMs: 50 }));

      expect(run.status).toBe("failed");
      expect(run.error).toMatch(/timed out/);
    });

    it("removes an older media-missing.txt once nothing is missing", async () => {
      s3.objects.set(keyOf("media-missing.txt"), {
        body: Buffer.from("old\n"),
        contentType: undefined,
        cacheControl: undefined,
      });
      await runBackupOn(service(await settingsWith()));
      expect(s3.objects.has(keyOf("media-missing.txt"))).toBe(false);
    });

    it("keeps warnings within the schema's limits however many files are missing", async () => {
      for (let i = 0; i < 130; i += 1) await plantMedia(randomBytes(16));

      const run = await runBackupOn(service(await settingsWith()));

      expect(run.status).toBe("done");
      expect(run.warnings?.length).toBe(100);
      expect(run.warnings?.at(-1)).toMatch(/more warnings/);
      expect(
        s3.objects.get(keyOf("media-missing.txt"))?.body.toString("utf8").trim().split("\n"),
      ).toHaveLength(130);
    });

    it("fails the run when the destination refuses a file", async () => {
      const hash = await plantFile(randomBytes(32));
      s3.refuseWrite = (key) => key.includes(`media/${hash.slice(0, 2)}`);
      const run = await runBackupOn(service(await settingsWith()));
      expect(run.status).toBe("failed");
      expect(s3.objects.has(keyOf("manifest.json"))).toBe(false);
    });
  });

  describe("identity", () => {
    it("writes the phrase when asked", async () => {
      await runBackupOn(service(await settingsWith()), true);
      expect(manifest().identity).toBe(true);
      expect(s3.objects.get(keyOf("identity.key"))?.body.toString("utf8")).toBe(`${PHRASE}\n`);
    });

    it("removes an older identity.key when not asked, so the manifest stays truthful", async () => {
      const svc = service(await settingsWith());
      await runBackupOn(svc, true);
      expect(s3.objects.has(keyOf("identity.key"))).toBe(true);

      clock.advanceSeconds(60);
      await runBackupOn(svc, false);

      expect(s3.objects.has(keyOf("identity.key"))).toBe(false);
      expect(manifest().identity).toBe(false);
    });

    it("never reads the phrase when it was not asked for", async () => {
      const recoveryPhrase = vi.fn(() => Promise.resolve(PHRASE));
      const run = await runBackupOn(service(await settingsWith(), { recoveryPhrase }), false);

      expect(run.status).toBe("done");
      expect(recoveryPhrase).not.toHaveBeenCalled();
      expect(manifest().identity).toBe(false);
    });

    it("warns for an ephemeral identity when one was asked for, and records none", async () => {
      s3.objects.set(keyOf("identity.key"), {
        body: Buffer.from("an older phrase\n"),
        contentType: undefined,
        cacheControl: undefined,
      });
      const run = await runBackupOn(service(await settingsWith(), { phrase: undefined }), true);

      expect(run.status).toBe("done");
      expect(run.warnings?.join(" ")).toMatch(/cannot restore as the same server/);
      expect(manifest().identity).toBe(false);
      expect(s3.objects.has(keyOf("identity.key"))).toBe(false);
    });
  });

  describe("credentials", () => {
    it("never reach a run row or the error stored on one", async () => {
      s3.failureMessage = `refused key ${ACCESS_KEY} signature ${SECRET_KEY}`;
      await plantFile(randomBytes(32));
      s3.refuseWrite = () => true;

      const run = await runBackupOn(service(await settingsWith()));

      expect(run.status).toBe("failed");
      expect(run.error).toContain("[redacted]");
      const stored = await pool.query("SELECT * FROM backup_runs");
      const all = JSON.stringify(stored.rows);
      expect(all).not.toContain(ACCESS_KEY);
      expect(all).not.toContain(SECRET_KEY);
      expect(all).toContain("srv/one"); // the row is there, and carries the target it may carry
    });

    it("truncates a stored error to the schema's limit", () => {
      expect(safeRunError(new Error("x".repeat(3000)), [])).toHaveLength(2000);
      expect(safeRunError("plain", ["pl"])).toBe("[redacted]ain");
    });
  });

  describe("the admin routes", () => {
    /** The real controller + real gate over the in-memory nonce log. */
    function routes(svc: BackupService, admins: string[] = [ADMIN]) {
      const nonces = memoryNonces();
      const nonce = new NonceService(nonces, { retentionMs: 600_000, writeLocked: false });
      const gate = new AdminGate(testSignedRequestGate(), nonce, admins);
      return { controller: new BackupController(svc, gate, nonce), nonces };
    }

    const signStart = (p: object, nonce: string): unknown =>
      signOpWithWallet(wallet, {
        op: "admin.backup.start",
        nonce,
        params: p as Record<string, unknown>,
      });
    const signRuns = (p: object, nonce: string): unknown =>
      signOpWithWallet(wallet, {
        op: "admin.backup.runs",
        nonce,
        params: p as Record<string, unknown>,
      });

    it("starts a run, answers it by id and in the list, and a replay returns the same run", async () => {
      const svc = service(await settingsWith());
      const { controller, nonces } = routes(svc);
      const log = vi.spyOn(Logger.prototype, "log");

      const startNonce = ulid();
      const started = await controller.start(signStart(params(), startNonce));
      expect(started.ok).toBe(true);
      expect(backupRunSchema.safeParse(started.run).success).toBe(true);
      await svc.idle();

      const replayed = await controller.start(signStart(params(), startNonce));
      expect(replayed.run.id).toBe(started.run.id);

      const { runs: byId } = await controller.runs(signRuns({ id: started.run.id }, ulid()));
      expect(byId.map((r) => r.id)).toEqual([started.run.id]);
      expect(byId[0]?.status).toBe("done");
      const { runs: list } = await controller.runs(signRuns({}, ulid()));
      expect(adminBackupRunsSchema.safeParse({ runs: list }).success).toBe(true);
      expect(list.map((r) => r.id)).toContain(started.run.id);
      expect(
        (await controller.runs(signRuns({ id: "01ARZ3NDEKTSV4RRFFQ69G5FAV" }, ulid()))).runs,
      ).toEqual([]);

      // The nonce memo and the audit line hold nothing of the credentials.
      const memo = await nonces.get(
        { actor: ADMIN, op: "admin.backup.start", nonce: startNonce },
        "2000-01-01T00:00:00.000Z",
      );
      expect(memo?.result).toBe(JSON.stringify({ id: started.run.id }));
      const logged = log.mock.calls.map((c) => String(c[0])).join("\n");
      expect(logged).toMatch(/admin\.backup\.start .*backups\/srv\/one/);
      expect(logged).not.toContain(SECRET_KEY);
      expect(logged).not.toContain(ACCESS_KEY);
    });

    it("refuses a second run with a 409 that does not consume the nonce", async () => {
      const settings = await settingsWith();
      await settings.set("writeLocked", true, ADMIN);
      // Stuck waiting out the lock, so a run is genuinely in progress.
      const svc = service(settings, {
        sleep: (_ms, signal) =>
          new Promise((_resolve, reject) => {
            signal.addEventListener("abort", () => reject(signal.reason as Error));
          }),
      });
      const { controller, nonces } = routes(svc);

      await controller.start(signStart(params(), ulid()));
      const second = ulid();
      const refused = await controller
        .start(signStart(params(), second))
        .catch((err: unknown) => err as HttpException);

      expect(refused).toBeInstanceOf(HttpException);
      expect((refused as HttpException).getStatus()).toBe(409);
      expect(
        await nonces.get(
          { actor: ADMIN, op: "admin.backup.start", nonce: second },
          "2000-01-01T00:00:00.000Z",
        ),
      ).toBeUndefined();
      await expect(svc.start(params(), ADMIN)).rejects.toBeInstanceOf(BackupBusyError);
    });

    it("hides from a non-admin and rejects bad params", async () => {
      const svc = service(await settingsWith());
      const { controller } = routes(svc, ["did:key:zSomeoneElse"]);
      const denied = await controller
        .start(signStart(params(), ulid()))
        .catch((err: unknown) => err as HttpException);
      expect((denied as HttpException).getStatus()).toBe(403);

      const { controller: mine } = routes(svc);
      const bad = await mine
        .start(signStart({ target: { bucket: "b" }, includeIdentity: true }, ulid()))
        .catch((err: unknown) => err as HttpException);
      expect((bad as HttpException).getStatus()).toBe(400);
    });
  });

  describe("a run that loses its footing", () => {
    it("fails cleanly when the database connection drops, and the server carries on", async () => {
      let pid = 0;
      let killed = false;
      s3.beforeWrite = async () => {
        if (killed) return;
        killed = true;
        await adminPool.query("SELECT pg_terminate_backend($1)", [pid]);
        await new Promise((resolve) => setTimeout(resolve, 50));
      };
      const svc = service(await settingsWith(), {
        connections: {
          connect: async () => {
            const client = await pool.connect();
            pid = (client as unknown as { processID: number }).processID;
            return client;
          },
        },
      });

      const run = await runBackupOn(svc);

      expect(run.status).toBe("failed");
      expect(run.error).toMatch(/terminat/i);
      await expect(pool.query("SELECT 1")).resolves.toBeDefined();
    });

    it("retries the closing write, so a brief database failure does not strand the row", async () => {
      let failures = 2;
      const flaky: BackupRunStore = {
        create: (r) => runs.create(r),
        get: (id) => runs.get(id),
        recent: (n) => runs.recent(n),
        failActive: (e, t) => runs.failActive(e, t),
        hasDone: (k) => runs.hasDone(k),
        update: (id, patch) => {
          if (patch.status === "done" && failures > 0) {
            failures -= 1;
            return Promise.reject(new Error("database away"));
          }
          return runs.update(id, patch);
        },
      };
      const run = await runBackupOn(service(await settingsWith(), { runStore: flaky }));
      expect(failures).toBe(0);
      expect(run.status).toBe("done");
    });

    it("closes out a live row with no job behind it and proceeds", async () => {
      await runs.create({
        id: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
        kind: "backup",
        status: "running",
        requestedBy: ADMIN,
        target: { region: "r", bucket: "b", prefix: "p" },
        createdAt: "2026-11-01T00:00:00.000Z",
      });
      const svc = service(await settingsWith());

      const run = await runBackupOn(svc);

      expect(run.status).toBe("done");
      expect(await svc.getRun("01ARZ3NDEKTSV4RRFFQ69G5FAV")).toMatchObject({
        status: "failed",
        error: expect.stringMatching(/no job was running/),
      });
    });

    it("does not mistake a simultaneous start for an orphan", async () => {
      const svc = service(await settingsWith());

      const [one, two] = await Promise.allSettled([
        svc.start(params(), ADMIN),
        svc.start(params(), ADMIN),
      ]);
      await svc.idle();

      const started = [one, two].filter((r) => r.status === "fulfilled");
      expect(started).toHaveLength(1);
      expect([one, two].find((r) => r.status === "rejected")).toMatchObject({
        reason: expect.any(BackupBusyError),
      });
      const [only] = await svc.listRuns();
      expect(only?.status).toBe("done");
    });
  });

  describe("BEACON_BACKUP_PRIVATE_ENDPOINTS", () => {
    const refused = /not a public address/;

    it("is on unless turned off", () => {
      expect(testConfig().backupPrivateEndpoints).toBe(true);
      expect(testConfig({ BEACON_BACKUP_PRIVATE_ENDPOINTS: "0" }).backupPrivateEndpoints).toBe(
        false,
      );
    });

    it("checks nothing when private endpoints are allowed", async () => {
      await expect(
        checkBackupEndpoint({ endpoint: "http://10.0.0.5:9000" }, true),
      ).resolves.toBeUndefined();
    });

    it.each([
      "http://127.0.0.1:9000",
      "http://10.1.2.3",
      "http://172.20.0.2:9000",
      "http://192.168.1.1",
      "http://169.254.169.254",
      "http://100.64.0.1",
      "http://0.0.0.0",
      "http://2130706433", // 127.0.0.1, as the URL parser normalizes it
      "http://[::1]:9000",
      "http://[::ffff:127.0.0.1]",
      "http://[fe80::1]",
      "http://[fd00::1]",
    ])("refuses %s", async (endpoint) => {
      await expect(checkBackupEndpoint({ endpoint }, false)).rejects.toThrow(refused);
    });

    it("refuses a name that resolves to a private address, naming it", async () => {
      await expect(
        checkBackupEndpoint({ endpoint: "http://localhost:9000" }, false),
      ).rejects.toThrow(/localhost resolves to .* not a public address/);
      const mixed = (): Promise<{ address: string }[]> =>
        Promise.resolve([{ address: "8.8.8.8" }, { address: "10.0.0.1" }]);
      await expect(
        checkBackupEndpoint({ endpoint: "https://s3.example" }, false, mixed),
      ).rejects.toThrow(/10\.0\.0\.1/);
    });

    it("allows AWS, a public address and a public name, and refuses an unresolvable one", async () => {
      await expect(checkBackupEndpoint({}, false)).resolves.toBeUndefined();
      await expect(
        checkBackupEndpoint({ endpoint: "https://8.8.8.8" }, false),
      ).resolves.toBeUndefined();
      await expect(
        checkBackupEndpoint({ endpoint: "https://s3.example" }, false, () =>
          Promise.resolve([{ address: "93.184.216.34" }]),
        ),
      ).resolves.toBeUndefined();
      await expect(
        checkBackupEndpoint({ endpoint: "https://s3.example" }, false, () =>
          Promise.reject(new Error("ENOTFOUND")),
        ),
      ).rejects.toThrow(/could not be resolved/);
      expect(isNonPublicAddress("2606:4700::1111")).toBe(false);
    });

    it("refuses a start with no row written, and the route answers 400", async () => {
      const svc = service(await settingsWith(), { allowPrivateEndpoints: false });
      await expect(svc.start(params(), ADMIN)).rejects.toBeInstanceOf(BackupEndpointError);
      expect(await svc.listRuns()).toEqual([]);

      const nonce = new NonceService(memoryNonces(), { retentionMs: 600_000, writeLocked: false });
      const gate = new AdminGate(testSignedRequestGate(), nonce, [ADMIN]);
      const answered = await new BackupController(svc, gate, nonce)
        .start(
          signOpWithWallet(wallet, {
            op: "admin.backup.start",
            nonce: ulid(),
            params: params() as unknown as Record<string, unknown>,
          }),
        )
        .catch((err: unknown) => err as HttpException);
      expect((answered as HttpException).getStatus()).toBe(400);
    });

    it("refuses at the connection too, so re-pointing a name after the check gains nothing", async () => {
      const port = new URL(endpoint).port;
      const fenced = new BackupBucket(
        { ...target, endpoint: `http://localhost:${port}` },
        new AbortController().signal,
        { allowPrivateEndpoints: false },
      );
      await expect(fenced.objectSizes("media/")).rejects.toThrow(refused);
      fenced.close();
    });
  });

  describe("restart", () => {
    it("closes a queued or running run left by a previous process", async () => {
      const live: BackupRunStore = runs;
      await live.create({
        id: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
        kind: "backup",
        status: "running",
        requestedBy: ADMIN,
        target: { region: "r", bucket: "b", prefix: "p" },
        createdAt: "2026-11-01T00:00:00.000Z",
      });
      const svc = service(await settingsWith());

      await svc.onApplicationBootstrap();

      expect(await svc.getRun("01ARZ3NDEKTSV4RRFFQ69G5FAV")).toMatchObject({
        status: "failed",
        error: "interrupted by server restart",
        finishedAt: "2026-11-08T12:00:00.000Z",
      });
    });

    it("stops a run in progress at shutdown and records why", async () => {
      const settings = await settingsWith();
      await settings.set("writeLocked", true, ADMIN);
      const svc = new BackupService(runs, {
        connections: pool,
        blobs: blobStore.blob,
        settings,
        identity: { account: { did: ADMIN }, recoveryPhrase: () => Promise.resolve(PHRASE) },
        config: { host: "backup.test", version: "1.2.3" },
        env: {},
        placeRunActive: () => false,
        restart: () => undefined,
        bucket: { allowPrivateEndpoints: true },
        // Real sleep and clock: the lock is fresh, so the run sits in its wait until aborted.
      });
      const queued = await svc.start(params(), ADMIN);

      await svc.onModuleDestroy();

      expect(await svc.getRun(queued.id)).toMatchObject({ status: "failed" });
      expect((await svc.getRun(queued.id))?.error).toMatch(/shutting down/);
    });
  });

  describe("BackupBucket and the media read", () => {
    const bucket = (): BackupBucket =>
      new BackupBucket(target, new AbortController().signal, { allowPrivateEndpoints: true });

    it("streams a body larger than a part as a multipart upload", async () => {
      const big = randomBytes(9 * 1024 * 1024);
      await bucket().putStream("db/ts/big.copy.gz", Readable.from([big]), { contentType: "x" });
      expect(s3.objects.get(keyOf("db/ts/big.copy.gz"))?.body.equals(big)).toBe(true);
    });

    it("pages through folders and a tree, and reports an absent object's size as undefined", async () => {
      s3.pageSize = 1;
      for (const k of ["db/a/1.gz", "db/a/2.gz", "db/b/1.gz", "db/c/1.gz"]) {
        s3.objects.set(keyOf(k), {
          body: Buffer.from("x"),
          contentType: undefined,
          cacheControl: undefined,
        });
      }
      const b = bucket();
      expect(await b.folders("db/")).toEqual(["a", "b", "c"]);
      await b.removeTree("db/a/");
      expect(await b.objectSizes("db/")).toEqual(
        new Map([
          ["db/b/1.gz", 1],
          ["db/c/1.gz", 1],
        ]),
      );
      expect(await b.folders("db/")).toEqual(["b", "c"]);
    });

    it("reads an S3 blob straight from the backend, even with a CDN configured", async () => {
      const store = new S3MediaBlobStore({
        endpoint,
        region: "us-east-1",
        bucket: "media",
        accessKeyId: ACCESS_KEY,
        secretAccessKey: SECRET_KEY,
        forcePathStyle: true,
        prefix: "live/",
        cdnUrl: "https://cdn.example",
      });
      const bytes = Buffer.from("from the bucket");
      const hash = sha256Base64url(bytes);
      await store.put(hash, bytes, "text/plain");

      const stream = await store.read(hash);
      const chunks: Buffer[] = [];
      for await (const c of stream as Readable) chunks.push(Buffer.from(c as Buffer));
      expect(Buffer.concat(chunks).equals(bytes)).toBe(true);
      expect(await store.read("absent")).toBeUndefined();

      // A bucket that does not exist is a misconfiguration, not a file that was never there.
      s3.bucketMissing = true;
      await expect(store.read(hash)).rejects.toThrow(/no such bucket/);
      store.close();
    });
  });

  describe("RunProgress", () => {
    it("drops a progress write that fails rather than failing the run", async () => {
      const onError = vi.fn();
      const progress = new RunProgress(
        emptyStats(),
        () => Promise.reject(new Error("db gone")),
        onError,
        () => 1_000_000,
        () => Promise.resolve(),
      );
      progress.tick();
      await progress.finish({ status: "done" });
      expect(onError).toHaveBeenCalledTimes(2);
    });
  });
});
