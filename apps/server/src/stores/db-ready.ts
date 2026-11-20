import { Logger } from "@nestjs/common";
import { Client } from "pg";

/**
 * Wait for the database to accept a connection before the server takes its writer lock. A server
 * and its Postgres often start together, and a Postgres still starting refuses connections for a
 * few seconds. Exiting on the first `ECONNREFUSED` turns that ordinary race into a crash loop, or
 * into a healthcheck every deploy has to get right.
 *
 * Only a database that is not there yet is waited for. A wrong password, a missing database or any
 * other answer from a running Postgres fails at once, since waiting would not change it.
 */

/** How long the server keeps trying before it gives up and exits (plus at most one attempt's limit). */
export const DB_CONNECT_WAIT_MS = 60_000;
const FIRST_DELAY_MS = 500;
const MAX_DELAY_MS = 5_000;
/** One attempt's limit. A host that drops packets would otherwise hold an attempt for minutes. */
const ATTEMPT_MS = 5_000;

/** Socket errors from a host that is not listening yet, or whose name does not resolve yet. */
const NOT_UP_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENOTFOUND",
  "EAI_AGAIN",
  // Postgres's own "the database system is starting up" (cannot_connect_now).
  "57P03",
]);

/** Whether `err` means the database is not up yet, rather than up and refusing this server. */
export function isNotUpYet(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  // A host name with several addresses (`localhost`) fails as one error per address.
  if (err instanceof AggregateError && err.errors.some(isNotUpYet)) return true;
  const code = (err as { code?: unknown }).code;
  if (typeof code === "string" && NOT_UP_CODES.has(code)) return true;
  // Postgres's first-boot init restarts the server once, which drops a fresh connection this way.
  return err.message.includes("Connection terminated unexpectedly");
}

export interface WaitForDatabaseOptions {
  waitMs?: number;
  /** One connection attempt within `timeoutMs`; resolves once the database answered. Tests replace it. */
  probe?: (databaseUrl: string, timeoutMs: number) => Promise<void>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  logger?: Pick<Logger, "warn">;
}

/**
 * One connection attempt that gives up after `timeoutMs`. pg's own connect has no limit by default,
 * and a host that drops packets holds it until the kernel's TCP timeout (about two minutes on
 * Linux), so the attempt races a timer that fails with `ETIMEDOUT`, a code `isNotUpYet` retries.
 */
export async function probeOnce(databaseUrl: string, timeoutMs = ATTEMPT_MS): Promise<void> {
  // pg's own limit, a little past the timer's, makes it close the socket after the timer fails the
  // attempt; the timer still decides, so the error always carries `ETIMEDOUT`.
  const client = new Client({
    connectionString: databaseUrl,
    connectionTimeoutMillis: timeoutMs + 1_000,
  });
  // A broken connection emits `error`; with no listener that would crash instead of retrying.
  client.on("error", () => {});
  const connecting = client.connect();
  // The connect can still reject after the timer wins; that late rejection is expected.
  connecting.catch(() => {});
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(Object.assign(new Error(`no answer within ${timeoutMs}ms`), { code: "ETIMEDOUT" }));
    }, timeoutMs);
  });
  try {
    await Promise.race([connecting, timedOut]);
  } finally {
    clearTimeout(timer);
    // Not awaited: on a silent host `end` waits for a socket that pg closes a moment later.
    void client.end().catch(() => {});
  }
}

/**
 * Resolve once the database accepts a connection; retry a database that is not up yet with
 * exponential backoff, logging each failed attempt, for at most `waitMs`. The URL never reaches a
 * log or an error, because the URL carries the password.
 */
export async function waitForDatabase(
  databaseUrl: string,
  options: WaitForDatabaseOptions = {},
): Promise<void> {
  const waitMs = options.waitMs ?? DB_CONNECT_WAIT_MS;
  const probe = options.probe ?? probeOnce;
  const sleep = options.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = options.now ?? Date.now;
  const logger = options.logger ?? new Logger("Database");
  const deadline = now() + waitMs;
  let delay = FIRST_DELAY_MS;
  for (let attempt = 1; ; attempt += 1) {
    try {
      await probe(databaseUrl, ATTEMPT_MS);
      return;
    } catch (err) {
      if (!isNotUpYet(err)) throw err;
      const reason = reasonOf(err);
      const left = deadline - now();
      if (left <= 0) {
        throw new Error(
          `The database at BEACON_DATABASE_URL did not accept a connection within ` +
            `${Math.round(waitMs / 1000)}s (${attempt} attempts, last: ${reason}). Check that ` +
            "Postgres is running and reachable from this server.",
        );
      }
      const wait = Math.min(delay, left);
      logger.warn(
        `The database is not accepting connections yet (${reason}); attempt ${attempt}, ` +
          `retrying in ${wait}ms.`,
      );
      await sleep(wait);
      delay = Math.min(delay * 2, MAX_DELAY_MS);
    }
  }
}

function reasonOf(err: unknown): string {
  const code = (err as { code?: unknown }).code;
  return typeof code === "string" ? code : err instanceof Error ? err.message : String(err);
}
