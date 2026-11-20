import { backupTableSchema } from "@beaconsgg/protocol-types";
import type { PoolClient } from "pg";
import type { DbConnections } from "../stores/store.factory";

/**
 * Run `fn` on one connection held out of the pool, the seam backup and restore share. `fn` gets a
 * signal that also ends when the connection is lost, so a `COPY` in flight is stopped in case the
 * broken socket never reports through it.
 *
 * The listener comes first (`stores/writer-lock.ts`): the pool drops its own while a client is
 * checked out, and an `error` nobody listens for is a crash of the whole server.
 */
export async function withRunClient<T>(
  connections: DbConnections,
  signal: AbortSignal,
  fn: (client: PoolClient, signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const client = await connections.connect();
  const connectionLost = new AbortController();
  const onConnectionError = (err: Error): void => {
    connectionLost.abort(err);
  };
  client.on("error", onConnectionError);
  let failed = false;
  try {
    return await fn(client, AbortSignal.any([signal, connectionLost.signal]));
  } catch (err) {
    failed = true;
    throw (connectionLost.signal.reason as Error | undefined) ?? err;
  } finally {
    // The listener stays on a discarded client, which can still report while it is torn down.
    if (!failed) client.off("error", onConnectionError);
    // Discarded on failure: a connection stopped mid-COPY is still mid-protocol.
    client.release(failed);
  }
}

/** Anything that can run a statement: a checked-out client, inside a backup's own transaction. */
export type Queryable = Pick<PoolClient, "query">;

/**
 * The tables a backup leaves out: the migrations record (a restore rebuilds it by running the
 * migrations up to the backup's version), the job log (`0026_backup_runs`) and who this server was
 * restored as (`0028_restored_identity`, the manifest and `identity.key` say that). Everything else
 * is discovered, so a table added in a later migration cannot be skipped by a list nobody updated.
 */
export const BACKUP_EXCLUDED_TABLES: ReadonlySet<string> = new Set([
  "schema_migrations",
  "backup_runs",
  "restored_identity",
]);

/** One table a backup carries, with its columns in ordinal order. */
export interface BackupTableShape {
  name: string;
  columns: string[];
}

/**
 * Every base table of the current schema except {@link BACKUP_EXCLUDED_TABLES}, with its columns in
 * ordinal order. A generated column is left out, since `COPY FROM` cannot load one and the database
 * derives it again anyway. Refuses, at once, a table or column name the manifest would refuse at
 * the end of the run: the manifest is written last, after hours of photo copying.
 */
export async function discoverTables(db: Queryable): Promise<BackupTableShape[]> {
  const res = await db.query<{ table_name: string; column_name: string }>(
    "SELECT c.table_name, c.column_name FROM information_schema.columns c " +
      "JOIN information_schema.tables t " +
      "  ON t.table_schema = c.table_schema AND t.table_name = c.table_name " +
      "WHERE c.table_schema = current_schema() AND t.table_type = 'BASE TABLE' " +
      "  AND c.is_generated = 'NEVER' " +
      "ORDER BY c.table_name, c.ordinal_position",
  );

  const tables = new Map<string, string[]>();
  for (const { table_name: table, column_name: column } of res.rows) {
    if (BACKUP_EXCLUDED_TABLES.has(table)) continue;
    const columns = tables.get(table);
    if (columns) columns.push(column);
    else tables.set(table, [column]);
  }
  return [...tables].map(([name, columns]) => {
    backupTableSchema.shape.name.parse(name);
    backupTableSchema.shape.columns.parse(columns);
    return { name, columns };
  });
}

/** The highest applied migration version. */
export async function readSchemaVersion(db: Queryable): Promise<number> {
  const res = await db.query<{ version: number | null }>(
    "SELECT MAX(version) AS version FROM schema_migrations",
  );
  const version = res.rows[0]?.version;
  if (version === null || version === undefined) {
    throw new Error("no applied migration recorded in schema_migrations");
  }
  return version;
}
