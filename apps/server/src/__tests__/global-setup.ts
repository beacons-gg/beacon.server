import { Client } from "pg";

/**
 * The server suite's vitest `globalSetup`. Postgres is the only backend, so a run without one fails
 * here, once, with the command that starts one, instead of as a wall of failing suites.
 */
const HOW =
  "Start one with `pnpm test:db` from the repo root, and run with the BEACON_TEST_DATABASE_URL it prints.";

/** The URL with any password masked, safe to print. */
function shown(url: string): string {
  try {
    const u = new URL(url);
    if (u.password) u.password = "***";
    return u.toString();
  } catch {
    return "(not a URL)";
  }
}

export default async function setup(): Promise<void> {
  const url = process.env["BEACON_TEST_DATABASE_URL"];
  if (!url) {
    throw new Error(
      `BEACON_TEST_DATABASE_URL is not set. The server suite runs on Postgres. ${HOW}`,
    );
  }
  const client = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
  try {
    await client.connect();
    await client.query("SELECT 1");
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    throw new Error(`BEACON_TEST_DATABASE_URL (${shown(url)}) is not reachable: ${why}. ${HOW}`);
  } finally {
    await client.end().catch(() => undefined);
  }
}
