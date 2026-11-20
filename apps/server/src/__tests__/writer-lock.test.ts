import { Pool } from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type StoreBundle, createStores } from "../stores/store.factory";
import { type WriterLock, takeWriterLock } from "../stores/writer-lock";
import { testDatabaseUrl } from "./pg-twin";

/**
 * The one-writer rule (doc/deploy.md "Topology"), enforced at boot: a second server on a database
 * waits for the first to let go, and refuses to start when it does not. These cases contend for the
 * real lock, so each releases what it takes; other suites build their stores without it.
 */
const held: Array<{ release(): Promise<void> } | StoreBundle> = [];
const take = async (waitMs: number) => {
  const lock = await takeWriterLock(testDatabaseUrl(), { waitMs, onLost: () => {} });
  held.push(lock);
  return lock;
};
const config = (waitMs: number) => ({
  databaseUrl: testDatabaseUrl(),
  pgPoolSize: 1,
  maxNonces: 10,
  writerLockWaitMs: waitMs,
});
const ignore = { onWriterLockLost: () => {} };

afterEach(async () => {
  for (const holder of held.splice(0))
    await ("close" in holder ? holder.close() : holder.release());
});

/** Whether some backend is waiting on an advisory lock it has not been granted. */
async function someoneWaits(): Promise<boolean> {
  const probe = new Pool({ connectionString: testDatabaseUrl(), max: 1 });
  try {
    const { rows } = await probe.query(
      "SELECT 1 FROM pg_locks WHERE locktype = 'advisory' AND NOT granted",
    );
    return rows.length > 0;
  } finally {
    await probe.end();
  }
}

describe("writer lock", () => {
  it("refuses a second server on the same database, saying why", async () => {
    await take(1000);
    await expect(createStores(config(200), ignore)).rejects.toThrow(
      /Another Beacon server is already serving this database \(BEACON_DATABASE_URL\), and it did not stop within 200ms.*no-double-spend/,
    );
  });

  it("refuses at once when told not to wait", async () => {
    await take(1000);
    await expect(createStores(config(0), ignore)).rejects.toThrow(/did not stop within 1ms/);
  });

  it("makes the next server wait for the first, and start once the first has closed, as a redeploy does", async () => {
    const first = await createStores(config(1000), ignore);
    const second = createStores(config(10_000), ignore);
    await vi.waitFor(async () => expect(await someoneWaits()).toBe(true));
    await first.close();
    held.push(await second);
    expect(await someoneWaits()).toBe(false);
  });

  it("tells the server, once, when the connection holding the lock is lost, and not when it is released", async () => {
    const onLost = vi.fn();
    const lock: WriterLock = await takeWriterLock(testDatabaseUrl(), { waitMs: 1000, onLost });
    const admin = new Pool({ connectionString: testDatabaseUrl(), max: 1 });
    try {
      // This lock's backend and no other: a real server on the same cluster holds one too.
      await admin.query("SELECT pg_terminate_backend($1)", [lock.pid]);
      await vi.waitFor(() => expect(onLost).toHaveBeenCalled());
      expect(onLost).toHaveBeenCalledTimes(1);
    } finally {
      await admin.end();
      await lock.release();
    }

    const quiet = vi.fn();
    const next = await takeWriterLock(testDatabaseUrl(), { waitMs: 1000, onLost: quiet });
    await next.release();
    expect(quiet).not.toHaveBeenCalled();
  });

  it("is not taken at all when the caller says so, as the other suites do", async () => {
    held.push(await createStores({ ...config(1000), writerLockWaitMs: null }));
    held.push(await createStores({ ...config(1000), writerLockWaitMs: null }));
    expect(held).toHaveLength(2);
  });
});
