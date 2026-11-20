import type { BackupRun, BackupRunStats } from "@beaconsgg/protocol-types";

/**
 * The fields of a {@link BackupRun} that change after it is created. Each is written whole: `stats`
 * and `warnings` are small, so there is no partial update to reason about.
 */
export type BackupRunPatch = Partial<
  Pick<BackupRun, "status" | "locked" | "stats" | "warnings" | "error" | "startedAt" | "finishedAt">
>;

/**
 * The durable job log behind `admin.backup.*` (`0026_backup_runs`). {@link PgBackupRunStore} is the
 * production twin; the suites hold an in-memory fake to the same parity tests.
 */
export interface BackupRunStore {
  /** Insert a run; false (and no row) when another run of either kind is queued or running. */
  create(run: BackupRun): Promise<boolean>;
  update(id: string, patch: BackupRunPatch): Promise<void>;
  get(id: string): Promise<BackupRun | undefined>;
  /** The most recent runs of both kinds, newest first. */
  recent(limit: number): Promise<BackupRun[]>;
  /** Whether a run of `kind` has finished `done` here: the job log's memory of a restore. */
  hasDone(kind: BackupRun["kind"]): Promise<boolean>;
  /** Close every queued or running run (the boot hook after a restart); how many it closed. */
  failActive(error: string, finishedAt: string): Promise<number>;
}

/** Counters for a run that has not started moving anything yet. */
export function emptyStats(): BackupRunStats {
  return {
    tablesDone: 0,
    tablesTotal: 0,
    rows: 0,
    mediaDone: 0,
    mediaTotal: 0,
    mediaBytes: 0,
    mediaSkipped: 0,
    mediaMissing: 0,
  };
}
