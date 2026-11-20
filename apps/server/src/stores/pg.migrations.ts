import type { Pool, PoolClient } from "pg";
import { type MigrationExecutor, SCHEMA_MIGRATIONS_DDL, runMigrations } from "../migrations/runner";

/**
 * Run the checked-in migrations on one client from `pool` (idempotent: applied versions are
 * skipped). The store factory calls it once, before it builds any store, so every store opens onto
 * a migrated schema; no store migrates on its own.
 */
export async function migrate(pool: Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await runMigrations(new PgMigrationExecutor(client));
  } finally {
    client.release();
  }
}

/**
 * The {@link MigrationExecutor} adapter for node-postgres — runs each raw-SQL migration inside a
 * transaction on a single pooled client and records it in `schema_migrations`. DDL in Postgres is
 * transactional, so a failed migration rolls back cleanly (nothing half-applied).
 */
export class PgMigrationExecutor implements MigrationExecutor {
  /** A fixed advisory-lock key for the whole migration process (arbitrary, app-scoped constant). */
  protected static readonly LOCK_KEY = 0xbeac04;

  constructor(protected readonly client: PoolClient) {}

  /**
   * Serialize the migration run DB-wide with a session advisory lock, so two concurrent `migrate()`
   * runs (two app processes, or a shared test DB) don't race on `CREATE TABLE/INDEX IF NOT EXISTS`
   * (Postgres system-catalog race). The lock is released in `finally`, even on error.
   */
  async withLock<T>(fn: () => Promise<T>): Promise<T> {
    await this.client.query("SELECT pg_advisory_lock($1)", [PgMigrationExecutor.LOCK_KEY]);
    try {
      return await fn();
    } finally {
      await this.client.query("SELECT pg_advisory_unlock($1)", [PgMigrationExecutor.LOCK_KEY]);
    }
  }

  async ensureVersionTable(): Promise<void> {
    await this.client.query(SCHEMA_MIGRATIONS_DDL);
  }

  async appliedVersions(): Promise<Set<number>> {
    const res = await this.client.query<{ version: number }>(
      "SELECT version FROM schema_migrations",
    );
    return new Set(res.rows.map((r) => Number(r.version)));
  }

  /** Run one migration's SQL and record its version, in whatever transaction is open. */
  protected async runAndRecord(version: number, name: string, sql: string): Promise<void> {
    await this.client.query(sql);
    await this.client.query(
      "INSERT INTO schema_migrations (version, name, applied_at) VALUES ($1, $2, $3)",
      [version, name, new Date().toISOString()],
    );
  }

  async applyMigration(version: number, name: string, sql: string): Promise<void> {
    try {
      await this.client.query("BEGIN");
      await this.runAndRecord(version, name, sql);
      await this.client.query("COMMIT");
    } catch (err) {
      await this.client.query("ROLLBACK");
      throw err;
    }
  }
}

/**
 * {@link PgMigrationExecutor} for a client already inside a transaction, where a restore runs the
 * migrations so that everything it does commits or rolls back together. Its advisory lock lasts the
 * transaction, and a migration opens no transaction of its own.
 */
export class PgInTransactionMigrationExecutor extends PgMigrationExecutor {
  override async withLock<T>(fn: () => Promise<T>): Promise<T> {
    await this.client.query("SELECT pg_advisory_xact_lock($1)", [PgMigrationExecutor.LOCK_KEY]);
    return fn();
  }

  override async applyMigration(version: number, name: string, sql: string): Promise<void> {
    await this.runAndRecord(version, name, sql);
  }
}
