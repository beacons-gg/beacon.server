import { randomBytes } from "node:crypto";
import { GetObjectCommand, ListObjectsV2Command, S3Client } from "@aws-sdk/client-s3";
import { createWallet, sha256Base64url } from "@beaconsgg/identity";
import { backupManifestSchema, type BackupS3Target } from "@beaconsgg/protocol-types";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MemoryBackupRunStore } from "./memory-stores";
import { BackupService } from "../backup/backup.service";
import { PgBackupRunStore } from "../stores/backup-run.pg.store";
import { runtimeSettingsFrom } from "../settings/registry";
import { SettingsService } from "../settings/settings.service";
import { migrate } from "../stores/pg.migrations";
import { MemorySettingsStore } from "./memory-stores";
import { testDatabaseUrl } from "./pg-twin";
import { testConfig } from "./test-config";
import { memoryBlobStore } from "./test-helpers";

/**
 * A backup through the real S3 client and a real S3-compatible store, the same gate as
 * `media-blob.integration.test.ts`: it runs when `BEACON_TEST_S3_ENDPOINT` is set (CI's
 * `s3-integration` job, MinIO) and is skipped otherwise. It checks the things the in-process fake
 * cannot: that the SDK's stream upload and listing speak to a real object store with our client
 * settings.
 */

const endpoint = process.env["BEACON_TEST_S3_ENDPOINT"];
const suite = endpoint ? describe : describe.skip;

suite("backup, against a real object store", () => {
  const SCHEMA = `backup_itest_${process.pid}_${randomBytes(4).toString("hex")}`;
  const RESTORED = `${SCHEMA}_restored`;
  const bucket = process.env["BEACON_TEST_S3_BUCKET"] ?? "beacon-media";
  const credentials = {
    accessKeyId: process.env["BEACON_TEST_S3_ACCESS_KEY_ID"] ?? "",
    secretAccessKey: process.env["BEACON_TEST_S3_SECRET_ACCESS_KEY"] ?? "",
  };
  const region = process.env["BEACON_TEST_S3_REGION"] ?? "us-east-1";
  const prefix = `itest-backup/${Date.now()}-${process.pid}`;
  let pool: Pool;
  let adminPool: Pool;
  let client: S3Client;

  beforeAll(async () => {
    adminPool = new Pool({ connectionString: testDatabaseUrl(), max: 1 });
    await adminPool.query(`CREATE SCHEMA ${SCHEMA}`);
    const url = new URL(testDatabaseUrl());
    url.searchParams.set("options", `-c search_path=${SCHEMA}`);
    pool = new Pool({ connectionString: url.href, max: 4 });
    await migrate(pool);
    client = new S3Client({
      ...(endpoint ? { endpoint } : {}),
      region,
      forcePathStyle: true,
      credentials,
    });
  });

  afterAll(async () => {
    client.destroy();
    await pool.end();
    await adminPool.query(`DROP SCHEMA ${SCHEMA} CASCADE`);
    await adminPool.end();
  });

  async function objectText(key: string): Promise<string> {
    const out = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    return (await out.Body?.transformToString("utf8")) ?? "";
  }

  it("uploads a whole backup and lists back its manifest and files", async () => {
    const wallet = createWallet();
    const { blob, blobs } = memoryBlobStore();
    const bytes = randomBytes(4096);
    const hash = sha256Base64url(bytes);
    blobs.set(hash, bytes);
    await pool.query(
      "INSERT INTO media (hash, type, size, owner, uploaded_at, last_access_at) VALUES ($1, 'image/jpeg', $2, $3, $4, NULL)",
      [hash, bytes.length, wallet.account.did, new Date().toISOString()],
    );
    const settings = new SettingsService(
      new MemorySettingsStore(),
      runtimeSettingsFrom(testConfig()),
    );
    await settings.load();

    const runs = new MemoryBackupRunStore();
    const service = new BackupService(runs, {
      connections: pool,
      blobs: blob,
      settings,
      identity: {
        account: { did: wallet.account.did },
        recoveryPhrase: () => Promise.resolve(undefined),
      },
      config: { host: "backup.itest", version: "1.0.0" },
      env: {},
      bucket: { allowPrivateEndpoints: true },
      placeRunActive: () => false,
      restart: () => undefined,
    });
    const target: BackupS3Target = {
      ...(endpoint ? { endpoint } : {}),
      region,
      bucket,
      prefix,
      accessKeyId: credentials.accessKeyId,
      secretAccessKey: credentials.secretAccessKey,
      forcePathStyle: true,
    };

    const run = await service.start({ target, includeIdentity: true }, wallet.account.did);
    await service.idle();

    expect(await runs.get(run.id)).toMatchObject({ status: "done" });
    const manifest = backupManifestSchema.parse(
      JSON.parse(await objectText(`${prefix}/manifest.json`)),
    );
    expect(manifest).toMatchObject({ host: "backup.itest", media: { count: 1, missing: 0 } });

    const listed = await client.send(
      new ListObjectsV2Command({ Bucket: bucket, Prefix: `${prefix}/` }),
    );
    const keys = (listed.Contents ?? []).map((c) => c.Key);
    expect(keys).toContain(`${prefix}/media/${hash.slice(0, 2)}/${hash}`);
    const table = manifest.tables.find((t) => t.name === "media");
    expect(keys).toContain(`${prefix}/${table?.file}`);

    // And back: the same backup restored into an empty schema through the real GetObject path.
    await pool.query(`CREATE SCHEMA ${RESTORED}`);
    const url = new URL(testDatabaseUrl());
    url.searchParams.set("options", `-c search_path=${RESTORED}`);
    const restored = new Pool({ connectionString: url.href, max: 4 });
    try {
      await migrate(restored);
      const destBlobs = memoryBlobStore();
      const destSettings = new SettingsService(
        new MemorySettingsStore(),
        runtimeSettingsFrom(testConfig()),
      );
      await destSettings.load();
      let clock = Date.now();
      let restarted = 0;
      const dest = new BackupService(new PgBackupRunStore(restored), {
        connections: restored,
        blobs: destBlobs.blob,
        settings: destSettings,
        identity: {
          account: { did: wallet.account.did },
          recoveryPhrase: () => Promise.resolve(undefined),
        },
        config: { host: "backup.itest", version: "1.0.0" },
        env: {},
        now: () => clock,
        sleep: (ms) => {
          clock += ms;
          return Promise.resolve();
        },
        bucket: { allowPrivateEndpoints: true },
        placeRunActive: () => false,
        restart: () => {
          restarted += 1;
        },
      });
      expect((await dest.inspectRestore(target)).refusal).toBeUndefined();
      const restoring = await dest.startRestore({ target }, wallet.account.did);
      await dest.idle();
      expect(restarted).toBe(1);
      expect(await dest.getRun(restoring.id)).toMatchObject({ status: "done", kind: "restore" });
      expect(destBlobs.blobs.get(hash)?.equals(bytes)).toBe(true);
      const rows = await restored.query("SELECT hash FROM media");
      expect(rows.rows).toEqual([{ hash }]);
    } finally {
      await restored.end();
      await pool.query(`DROP SCHEMA ${RESTORED} CASCADE`);
    }
  });
});
