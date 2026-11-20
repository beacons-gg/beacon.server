import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * A tiny **forward-only, versioned raw-SQL** migration runner.
 *
 * This is the *portable default*, deliberately un-opinionated: migrations are hand-written `.sql`
 * files, one per version, checked in under `migrations/postgres/NNNN_name.sql`, and applied in
 * ascending numeric order. Each applied version is recorded in a `schema_migrations`
 * table so a re-run is a no-op (idempotent) and never re-applies or rolls back.
 *
 * It can be swapped for TypeORM / Kysely / Drizzle later without touching the custody path: the
 * atomic `commit(Mutation[])` hot write stays hand-written SQL behind the `Store` interface
 * regardless. An ORM, if adopted, would own *schema/migrations only*, not the hot path.
 *
 * Postgres is the only dialect since SQLite was removed. The runner is driver-agnostic, taking a
 * {@link MigrationExecutor} the caller adapts to its driver. The executor owns the transaction: at
 * boot it opens one per migration file, and a restore's runs inside the one its caller already
 * holds.
 */
export interface MigrationExecutor {
  /** Ensure the bookkeeping table exists. Runs once, before anything else. */
  ensureVersionTable(): Promise<void>;
  /** The set of already-applied version numbers. */
  appliedVersions(): Promise<Set<number>>;
  /** Apply one migration's SQL and record its version, atomically (all-or-nothing). */
  applyMigration(version: number, name: string, sql: string): Promise<void>;
  /**
   * Serialize the whole migration run so **concurrent** runs (two app processes, or a shared
   * test DB) don't race on `CREATE TABLE/INDEX IF NOT EXISTS` (Postgres has a known system-catalog
   * race there). The Pg executor implements this with a session advisory lock.
   */
  withLock<T>(fn: () => Promise<T>): Promise<T>;
}

export interface MigrationFile {
  version: number;
  name: string;
  sql: string;
}

/** The DDL that creates the bookkeeping table. */
export const SCHEMA_MIGRATIONS_DDL =
  "CREATE TABLE IF NOT EXISTS schema_migrations (" +
  "version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)";

/** The directory under `migrations/` the runner reads. */
const MIGRATIONS_DIR = "postgres";

/**
 * Load and parse the `.sql` migration files from `migrations/postgres/`, sorted by their leading
 * numeric version (`0001_init.sql` -> `{ version: 1, name: "init" }`). Files that don't match
 * `NNNN_name.sql` are ignored. An empty set throws, as a missing directory does: either means a
 * build that did not copy the SQL, and migrating nothing would boot a server onto a database with
 * no schema, failing at its first query instead of here.
 */
export function loadMigrations(baseDir = __dirname): MigrationFile[] {
  const dir = join(baseDir, MIGRATIONS_DIR);
  const files = readdirSync(dir).filter((f) => f.endsWith(".sql"));
  const parsed: MigrationFile[] = [];
  const seen = new Set<number>();
  for (const file of files) {
    const match = /^(\d+)_(.+)\.sql$/.exec(file);
    if (!match) continue;
    const version = Number(match[1]);
    // Fail loudly on a mis-numbered migration set at load time, rather than as a primary-key error
    // halfway through a run.
    if (seen.has(version)) {
      throw new Error(
        `loadMigrations: duplicate migration version ${version} in migrations/${MIGRATIONS_DIR}`,
      );
    }
    seen.add(version);
    parsed.push({ version, name: match[2] as string, sql: readFileSync(join(dir, file), "utf8") });
  }
  if (parsed.length === 0) {
    throw new Error(`loadMigrations: no migrations in ${dir} (was the SQL copied?)`);
  }
  return parsed.sort((a, b) => a.version - b.version);
}

/**
 * Apply every not-yet-applied migration, in order, through the given executor.
 * Idempotent: already-applied versions are skipped. Returns the versions applied this run.
 */
export async function runMigrations(
  executor: MigrationExecutor,
  baseDir = __dirname,
  /** Apply nothing past this version: how a restore reaches the schema its backup was taken at. */
  options: { stopAt?: number } = {},
): Promise<number[]> {
  const { stopAt } = options;
  const run = async (): Promise<number[]> => {
    await executor.ensureVersionTable();
    const applied = await executor.appliedVersions();
    const pending = loadMigrations(baseDir).filter(
      (m) => !applied.has(m.version) && (stopAt === undefined || m.version <= stopAt),
    );
    const done: number[] = [];
    for (const m of pending) {
      await executor.applyMigration(m.version, m.name, m.sql);
      done.push(m.version);
    }
    return done;
  };
  // Serialize the whole run under the lock (concurrent init safety).
  return executor.withLock(run);
}
