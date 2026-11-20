import type { BackupRun, BackupRunStats, DidKey } from "@beaconsgg/protocol-types";
import type { Pool, PoolClient } from "pg";
import type { BackupRunPatch, BackupRunStore } from "./backup-run-store";

const COLUMNS =
  "id, kind, status, requested_by, target, locked, stats, warnings, error, created_at, started_at, finished_at";

interface RunRow {
  id: string;
  kind: BackupRun["kind"];
  status: BackupRun["status"];
  requested_by: string;
  target: string;
  locked: boolean | null;
  stats: string | null;
  warnings: string | null;
  error: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

function rowToRun(r: RunRow): BackupRun {
  return {
    id: r.id,
    kind: r.kind,
    status: r.status,
    requestedBy: r.requested_by as DidKey,
    target: JSON.parse(r.target) as BackupRun["target"],
    ...(r.locked !== null ? { locked: r.locked } : {}),
    ...(r.stats !== null ? { stats: JSON.parse(r.stats) as BackupRunStats } : {}),
    ...(r.warnings !== null ? { warnings: JSON.parse(r.warnings) as string[] } : {}),
    ...(r.error !== null ? { error: r.error } : {}),
    createdAt: r.created_at,
    ...(r.started_at !== null ? { startedAt: r.started_at } : {}),
    ...(r.finished_at !== null ? { finishedAt: r.finished_at } : {}),
  };
}

/** The patch as `[column, bindValue]` pairs (`snapshotPatchEntries`'s shape). */
function patchEntries(patch: BackupRunPatch): [string, unknown][] {
  const entries: [string, unknown][] = [];
  if (patch.status !== undefined) entries.push(["status", patch.status]);
  if (patch.locked !== undefined) entries.push(["locked", patch.locked]);
  if (patch.stats !== undefined) entries.push(["stats", JSON.stringify(patch.stats)]);
  if (patch.warnings !== undefined) entries.push(["warnings", JSON.stringify(patch.warnings)]);
  if (patch.error !== undefined) entries.push(["error", patch.error]);
  if (patch.startedAt !== undefined) entries.push(["started_at", patch.startedAt]);
  if (patch.finishedAt !== undefined) entries.push(["finished_at", patch.finishedAt]);
  return entries;
}

/**
 * Write a patch through `db`: a restore writes its closing patch on its own connection, inside the
 * transaction that loads the data, so a crash cannot leave restored data with no `done` run.
 */
export async function updateBackupRun(
  db: Pick<PoolClient, "query">,
  id: string,
  patch: BackupRunPatch,
): Promise<void> {
  const entries = patchEntries(patch);
  if (entries.length === 0) return;
  const sets = entries.map(([column], i) => `${column} = $${i + 1}`).join(", ");
  await db.query(`UPDATE backup_runs SET ${sets} WHERE id = $${entries.length + 1}`, [
    ...entries.map(([, value]) => value),
    id,
  ]);
}

/** Postgres {@link BackupRunStore}, over the `backup_runs` table (`0026_backup_runs`). */
export class PgBackupRunStore implements BackupRunStore {
  constructor(private readonly pool: Pool) {}

  async create(run: BackupRun): Promise<boolean> {
    // `ON CONFLICT` on the partial index is what makes "one run at a time" atomic: the second of two
    // racing inserts finds the live row and writes nothing.
    const res = await this.pool.query(
      `INSERT INTO backup_runs (${COLUMNS}) VALUES ($1, $2, $3, $4, $5, $6, NULL, NULL, NULL, $7, NULL, NULL) ` +
        "ON CONFLICT ((true)) WHERE status IN ('queued', 'running') DO NOTHING",
      [
        run.id,
        run.kind,
        run.status,
        run.requestedBy,
        JSON.stringify(run.target),
        run.locked ?? null,
        run.createdAt,
      ],
    );
    return (res.rowCount ?? 0) > 0;
  }

  update(id: string, patch: BackupRunPatch): Promise<void> {
    return updateBackupRun(this.pool, id, patch);
  }

  async get(id: string): Promise<BackupRun | undefined> {
    const res = await this.pool.query<RunRow>(`SELECT ${COLUMNS} FROM backup_runs WHERE id = $1`, [
      id,
    ]);
    const row = res.rows[0];
    return row ? rowToRun(row) : undefined;
  }

  async recent(limit: number): Promise<BackupRun[]> {
    // Newest first by id: a ULID sorts by creation time, and `id` is the primary key.
    const res = await this.pool.query<RunRow>(
      `SELECT ${COLUMNS} FROM backup_runs ORDER BY id DESC LIMIT $1`,
      [limit],
    );
    return res.rows.map(rowToRun);
  }

  async hasDone(kind: BackupRun["kind"]): Promise<boolean> {
    const res = await this.pool.query(
      "SELECT 1 FROM backup_runs WHERE kind = $1 AND status = 'done' LIMIT 1",
      [kind],
    );
    return (res.rowCount ?? 0) > 0;
  }

  async failActive(error: string, finishedAt: string): Promise<number> {
    const res = await this.pool.query(
      "UPDATE backup_runs SET status = 'failed', error = $1, finished_at = $2 " +
        "WHERE status IN ('queued', 'running')",
      [error, finishedAt],
    );
    return res.rowCount ?? 0;
  }
}
