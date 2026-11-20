import { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import { loadConfig } from "../config";
import { migrate } from "../stores/pg.migrations";
import { PgStore } from "../stores/pg.store";
import { createStores } from "../stores/store.factory";
import { testDatabaseUrl } from "./pg-twin";

/**
 * The store factory + config. Postgres is the only backend: without `BEACON_DATABASE_URL` the
 * server refuses to start, and says what to set.
 */

describe("loadConfig: the database", () => {
  it("refuses to start without BEACON_DATABASE_URL, naming what to set", () => {
    for (const env of [{}, { BEACON_DATABASE_URL: "" }]) {
      expect(() => loadConfig(env)).toThrow(
        /^BEACON_DATABASE_URL is not set\. The Beacon server requires Postgres: set BEACON_DATABASE_URL=postgres:\/\/.*doc\/deploy\.md/,
      );
    }
  });

  it("tells an operator on an old .env that BEACON_DB_PATH is no longer read", () => {
    expect(() => loadConfig({ BEACON_DB_PATH: "beacon-rooms.db" })).toThrow(
      /BEACON_DB_PATH \("beacon-rooms\.db"\) is no longer read/,
    );
    // Only when it is set: a fresh deployment is not told about a variable it never had.
    expect(() => loadConfig({})).not.toThrow(/BEACON_DB_PATH/);
  });

  it("takes the URL and the pool knobs, with their defaults", () => {
    const url = "postgres://localhost/x";
    expect(loadConfig({ BEACON_DATABASE_URL: url })).toMatchObject({
      databaseUrl: url,
      pgPoolSize: 10,
      maxNonces: 50_000,
      writerLockWaitMs: 30_000,
    });
    const cfg = loadConfig({
      BEACON_DATABASE_URL: url,
      BEACON_PG_POOL_SIZE: "20",
      BEACON_MAX_NONCES: "100",
      BEACON_WRITER_LOCK_WAIT_MS: "5000",
    });
    expect(cfg).toMatchObject({
      databaseUrl: url,
      pgPoolSize: 20,
      maxNonces: 100,
      writerLockWaitMs: 5000,
    });
    // 0 is an answer for the writer lock's wait ("refuse at once"), not an unset value.
    expect(
      loadConfig({ BEACON_DATABASE_URL: url, BEACON_WRITER_LOCK_WAIT_MS: "0" }).writerLockWaitMs,
    ).toBe(0);
    expect(
      loadConfig({ BEACON_DATABASE_URL: url, BEACON_WRITER_LOCK_WAIT_MS: "-5" }).writerLockWaitMs,
    ).toBe(30_000);
    expect(cfg).not.toHaveProperty("dbPath");
  });
});

/**
 * A test database URL whose connections carry a unique `application_name`, and a count of this
 * process's backends under it, so a case can see exactly the connections one bundle holds.
 */
function taggedDatabase(extra: Record<string, string> = {}): {
  url: string;
  connections(): Promise<number>;
} {
  const app = `store-factory-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const url = new URL(testDatabaseUrl());
  url.searchParams.set("application_name", app);
  for (const [k, v] of Object.entries(extra)) url.searchParams.set(k, v);
  return {
    url: url.href,
    async connections(): Promise<number> {
      const probe = new Pool({ connectionString: testDatabaseUrl(), max: 1 });
      try {
        const res = await probe.query<{ n: string }>(
          "SELECT COUNT(*) AS n FROM pg_stat_activity WHERE application_name = $1",
          [app],
        );
        return Number(res.rows[0]?.n);
      } finally {
        await probe.end();
      }
    },
  };
}

describe("createStores", () => {
  it("builds every store on the one Postgres, migrated", async () => {
    // Read-only on purpose: the parity suites truncate these tables from other workers.
    const bundle = await createStores({
      databaseUrl: testDatabaseUrl(),
      pgPoolSize: 2,
      maxNonces: 50_000,
      writerLockWaitMs: null,
    });
    try {
      expect(bundle.store).toBeInstanceOf(PgStore);
      expect(Object.keys(bundle).sort()).toEqual(
        [
          "access",
          "backupRuns",
          "blocklist",
          "close",
          "connections",
          "geocodeCache",
          "mailbox",
          "media",
          "nonces",
          "places",
          "profiles",
          "settings",
          "store",
        ].sort(),
      );
      // Each answers a query, so each table exists: the migrations ran before the bundle came back.
      expect(typeof (await bundle.store.countRooms())).toBe("number");
      expect(typeof (await bundle.profiles.count())).toBe("number");
      expect(Array.isArray(await bundle.settings.all())).toBe(true);
      // A backup holds one of these connections for a long COPY.
      expect(
        (bundle.connections as unknown as { options: { keepAlive: boolean } }).options,
      ).toMatchObject({
        keepAlive: true,
      });
    } finally {
      await bundle.close();
    }
  });

  /**
   * One pool for every store. With a pool per store the server could hold nine times
   * `BEACON_PG_POOL_SIZE` connections, and each store's `init()` would run the migrations again.
   * The bundle's connections are told apart by `application_name`.
   */
  it("runs every store on one pool of pgPoolSize connections, and close ends it", async () => {
    const db = taggedDatabase();
    const bundle = await createStores({
      databaseUrl: db.url,
      pgPoolSize: 1,
      maxNonces: 1,
      writerLockWaitMs: null,
    });
    try {
      // A read on each store, all at once: nine pools would open a connection each.
      await Promise.all([
        bundle.store.countRooms(),
        bundle.profiles.count(),
        bundle.mailbox.fetch("did:key:zNobody", "game-a", "2026-01-01T00:00:00.000Z"),
        bundle.media.stats(),
        bundle.nonces.get({ actor: "a", op: "o", nonce: "n" }, "2026-01-01T00:00:00.000Z"),
        bundle.geocodeCache.get("c23", "2026-01-01T00:00:00.000Z"),
        bundle.places.stats(),
        bundle.blocklist.all(),
        bundle.settings.all(),
      ]);
      expect(await db.connections()).toBe(1);

      await bundle.close();
      await bundle.close(); // a second shutdown hook is harmless
      // A backend leaves pg_stat_activity as it exits, which can trail the socket closing.
      await vi.waitFor(async () => expect(await db.connections()).toBe(0));
      await expect(bundle.settings.all()).rejects.toThrow();
    } finally {
      await bundle.close();
    }
  });

  it("ends its pool when a boot fails after connecting", async () => {
    // A search_path naming no schema: the connection opens, and the migration run then fails.
    const db = taggedDatabase({ options: "-c search_path=no_such_schema" });
    await expect(
      createStores({ databaseUrl: db.url, pgPoolSize: 1, maxNonces: 1, writerLockWaitMs: null }),
    ).rejects.toThrow(/no schema has been selected/);
    // Left open, the pool would keep that connection idle for pg's 10 s idle timeout.
    await vi.waitFor(async () => expect(await db.connections()).toBe(0));
  });

  /**
   * `0023_byte_order`: all server text sorts by byte, the order the fakes' `<` gives, whatever
   * collation the operator's database has. A column added later without `COLLATE "C"` fails here,
   * including the ones no parity pair can tell apart (ISO timestamps, id columns only joined on).
   */
  it("leaves every text column in byte order", async () => {
    const pool = new Pool({ connectionString: testDatabaseUrl(), max: 1 });
    try {
      await migrate(pool); // the migration run a boot does
      const res = await pool.query<{ col: string; collation_name: string | null }>(
        "SELECT table_name || '.' || column_name AS col, collation_name FROM information_schema.columns " +
          "WHERE table_schema = current_schema() AND data_type = 'text'",
      );
      expect(res.rows.map((r) => r.col)).toContain("places.unique_id"); // not vacuous
      expect(res.rows.filter((r) => r.collation_name !== "C").map((r) => r.col)).toEqual([]);
    } finally {
      await pool.end();
    }
  });
});
