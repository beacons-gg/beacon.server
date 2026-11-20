import { Client, DatabaseError } from "pg";

/**
 * The one-writer rule, enforced (doc/deploy.md "Topology"). The server's in-memory `KeyedMutex`,
 * geoIndex and timer wheel make it the only writer its database may have: two processes on one
 * database would each take their own mutex and let two ops interleave on a room, which breaks
 * no-double-spend. The rule used to be a sentence in the deploy doc, which an orchestrator that
 * starts the new container before stopping the old (a rolling deploy) broke silently.
 *
 * So a server takes a Postgres session advisory lock before it touches its database, holds it on a
 * connection of its own for as long as it runs, and gives up waiting after a while rather than
 * serving beside another. The wait covers a redeploy whose old process is still shutting down.
 *
 * Holding it is the half that needs care. The connection is otherwise idle, so it is pinged; a ping
 * that fails or hangs means the lock may be gone, and the server is told at once. Postgres's side of
 * the same connection is given short keepalives, so a server that vanished (a partition, a killed
 * host) has its lock released within seconds rather than hours. The server's own detection is the
 * quicker of the two, so it stops before a new server can take the lock.
 */

/** The lock every Beacon server on a database contends for: next to the migrations' `0xbeac04` (pg.migrations.ts). */
const WRITER_LOCK_KEY = 0xbeac05;

/** How often the holder proves its connection is alive, and how long one ping may take. */
const PING_EVERY_MS = 10_000;
const PING_TIMEOUT_MS = 5_000;
/** Postgres drops a silent client after idle + interval × count: 10 + 5 × 3 = 25s, after the holder's own ~15s. */
const SERVER_KEEPALIVE = { idle: 10, interval: 5, count: 3 };
/** `lock_timeout` is an int of milliseconds; 0 there would mean "wait forever". */
const MAX_WAIT_MS = 2_147_483_647;

/** The connection that holds the lock; ending it releases the lock. */
export interface WriterLock {
  /** The backend holding the lock, for a suite that needs to name it. */
  readonly pid: number;
  release(): Promise<void>;
}

export interface WriterLockOptions {
  /** How long to wait for a server already holding the lock to stop, before refusing to start. 0 refuses at once. */
  waitMs: number;
  /**
   * Called once if the connection holding the lock is lost while the server runs: the lock went with
   * it, so another server could now take it. The server's answer is to stop (`createStores`).
   */
  onLost: (reason: Error) => void;
}

export async function takeWriterLock(
  databaseUrl: string,
  options: WriterLockOptions,
): Promise<WriterLock> {
  const client = new Client({
    connectionString: databaseUrl,
    application_name: "beacon-server writer lock",
    keepAlive: true,
    keepAliveInitialDelayMillis: SERVER_KEEPALIVE.idle * 1000,
  });
  // Listening before anything else: pg emits `error` on a broken connection even mid-query, and an
  // `error` with no listener is a crash rather than the refusal below.
  // Losses count only while the lock is held: the refusal path's own `end()` is not one, nor is a
  // release, nor a second report of the same loss.
  let state: "taking" | "held" | "done" = "taking";
  const lost = (reason: Error) => {
    if (state !== "held") return;
    state = "done";
    options.onLost(reason);
  };
  client.on("error", lost);
  client.on("end", () => lost(new Error("the connection holding the writer lock ended")));

  await client.connect();
  const waitMs = Math.min(Math.max(Math.round(options.waitMs), 1), MAX_WAIT_MS);
  try {
    await client.query(
      `SET tcp_keepalives_idle = ${SERVER_KEEPALIVE.idle}; ` +
        `SET tcp_keepalives_interval = ${SERVER_KEEPALIVE.interval}; ` +
        `SET tcp_keepalives_count = ${SERVER_KEEPALIVE.count}; ` +
        // Postgres's own wait, cut off by `lock_timeout` alone: a role's `statement_timeout` would
        // otherwise end it early with a message that names neither the lock nor the other server.
        `SET statement_timeout = 0; SET lock_timeout = ${waitMs}`,
    );
    await client.query("SELECT pg_advisory_lock($1)", [WRITER_LOCK_KEY]);
  } catch (error) {
    await client.end().catch(() => {});
    if (error instanceof DatabaseError && error.code === "55P03") {
      throw new Error(
        `Another Beacon server is already serving this database (BEACON_DATABASE_URL), and it did not stop within ` +
          `${formatWait(waitMs)}. Two servers on one database would break no-double-spend ` +
          `(doc/deploy.md "Topology"): stop the other one, or point this one at its own database.`,
      );
    }
    throw error;
  }
  const { rows } = await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
  state = "held";

  const ping = setInterval(() => {
    const timeout = new Promise<never>((_, reject) =>
      setTimeout(
        () =>
          reject(
            new Error(`the writer lock's connection did not answer within ${PING_TIMEOUT_MS}ms`),
          ),
        PING_TIMEOUT_MS,
      ).unref(),
    );
    Promise.race([client.query("SELECT 1"), timeout]).catch((error: unknown) =>
      lost(error instanceof Error ? error : new Error(String(error))),
    );
  }, PING_EVERY_MS);
  ping.unref();

  return {
    pid: rows[0]?.pid ?? 0,
    async release() {
      state = "done";
      clearInterval(ping);
      await client.end().catch(() => {});
    },
  };
}

function formatWait(ms: number): string {
  return ms < 1000 ? `${ms}ms` : `${Math.round(ms / 1000)}s`;
}
