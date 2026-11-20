import { Pool } from "pg";
import { afterAll } from "vitest";
import { migrate } from "../stores/pg.migrations";

/**
 * The shared Postgres twin harness for the store parity suites.
 *
 * Every `*.pg.store.ts` is the twin that actually runs in production. Four of them had a paired
 * suite and five had none, and the four had grown four slightly different versions of the same
 * setup, two of which opened a fresh `Pool` per test just to issue one `TRUNCATE`. This is that
 * setup once, in the shape the place-store suite had already converged on, so the nine suites now
 * differ only in what they assert.
 *
 * The database is `BEACON_TEST_DATABASE_URL`, which the suite requires since SQLite went:
 * `global-setup.ts` fails the whole run, with the command that starts one, when it is unset or
 * unreachable, so a parity suite never quietly runs without its production twin.
 */

/** The test database's URL. `global-setup.ts` has already refused to run without a reachable one. */
export function testDatabaseUrl(): string {
  const url = process.env["BEACON_TEST_DATABASE_URL"];
  if (!url)
    throw new Error("BEACON_TEST_DATABASE_URL is unset (global-setup.ts should have said so)");
  return url;
}

/**
 * One backend a parity suite runs against. The Postgres twin below is one; the in-process
 * {@link memoryTwin} is the same shape with a trivial reset, so this types the whole `twins` array.
 */
export interface StoreTwin<S> {
  name: string;
  /** Open a store against the backend. Postgres's pool is ended in `afterAll`. */
  open(): Promise<S>;
  /** Empty this twin's tables, leaving the schema. Call it from `beforeEach`. */
  reset(): Promise<void>;
}

/**
 * The twin for one of the in-memory fakes the service suites run on (`./memory-stores`), so each is
 * held to the same contract as the stores it stands in for. A fresh store per `open`, so there is
 * nothing to reset.
 */
export function memoryTwin<S>(create: () => S): StoreTwin<S> {
  return {
    name: "memory",
    open: (): Promise<S> => Promise.resolve(create()),
    reset: (): Promise<void> => Promise.resolve(),
  };
}

/** The Postgres twin: a {@link StoreTwin}, plus raw access for a suite that has to plant a row state. */
export interface PgTwin<S> extends StoreTwin<S> {
  /** Run one statement on the twin's shared connection, e.g. to write what an older build left. */
  query(sql: string, params?: unknown[]): Promise<void>;
}

/**
 * The Postgres twin for one store, on the test database.
 *
 * One pool per suite, as a server has one: every store `open` builds goes onto it, and `afterAll`
 * ends it. The migrations run once, on the first `open`, `reset` or `query`, the way the store
 * factory runs them before it builds any store. `tables` is truncated between tests rather than the
 * database being dropped, so suites can share one database and still start from empty.
 */
export function pgTwin<S>(create: (pool: Pool) => S, tables: readonly string[]): PgTwin<S> {
  let shared: Promise<Pool> | undefined;
  const pool = (): Promise<Pool> =>
    (shared ??= (async () => {
      const p = new Pool({ connectionString: testDatabaseUrl(), max: 4 });
      await migrate(p);
      return p;
    })());

  afterAll(async () => {
    const p = shared;
    shared = undefined;
    await (await p)?.end();
  });

  return {
    name: "postgres",
    open: async (): Promise<S> => create(await pool()),
    async reset(): Promise<void> {
      await (await pool()).query(`TRUNCATE ${tables.join(", ")}`);
    },
    async query(sql: string, params: unknown[] = []): Promise<void> {
      await (await pool()).query(sql, params);
    },
  };
}
