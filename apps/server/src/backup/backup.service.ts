import { setTimeout as sleep } from "node:timers/promises";
import type {
  AdminBackupStartParams,
  AdminRestoreInspection,
  AdminRestoreStartParams,
  BackupManifest,
  BackupRun,
  BackupRunTarget,
  BackupS3Target,
} from "@beaconsgg/protocol-types";
import { Logger, type OnApplicationBootstrap, type OnModuleDestroy } from "@nestjs/common";
import { ulid } from "ulid";
import { BackupBucket, checkBackupEndpoint, type BackupBucketOptions } from "./backup-target";
import { MEDIA_READ_STALL_MS, retrying } from "./backup-files";
import {
  MAX_ERROR_LENGTH,
  RunProgress,
  runBackup,
  safeRunError,
  targetSecrets,
  type BackupJobDeps,
} from "./backup-job";
import {
  RestoreRefusedError,
  readRestoreManifest,
  restoreRefusal,
  runRestore,
  type RestoreJobDeps,
  type RestoreRefusalDeps,
} from "./restore-job";
import { emptyStats, type BackupRunPatch, type BackupRunStore } from "../stores/backup-run-store";

/** How many recent runs a list read returns (the schema's own cap). */
const RUN_LIST_LIMIT = 50;

/** Terminal `error` line for a run whose in-process job died with a server restart. */
const INTERRUPTED_REASON = "interrupted by server restart";

/** Terminal `error` line for a live row with no job behind it, found by a later start. */
const ORPHANED_REASON = "no job was running for this run; closed by a later start";

/** One run, as the shell around it sees it. */
interface RunJob {
  /** The job. Resolves with its closing patch, or nothing when it wrote its own closing row. */
  work: (bucket: BackupBucket, progress: RunProgress) => Promise<BackupRunPatch | undefined>;
  /** Whether a failure was in fact a commit whose reply was lost. */
  committed?: () => Promise<boolean>;
  /** Runs once the run has ended well and everything is closed. */
  after?: () => void;
  /** A sentence to put in front of the failure's message. */
  failureNote?: () => string | undefined;
}

/** The collaborators a backup and a restore need between them. */
type ServiceDeps = BackupJobDeps &
  RestoreJobDeps &
  Omit<RestoreRefusalDeps, "runs"> & {
    /** Ends this process after a restore, so it comes back with the restored state in memory. */
    restart: () => void;
  };

/** How long shutdown waits for an aborted run to record that it failed. */
const SHUTDOWN_WAIT_MS = 5000;

/** A start refused because a run of either kind is already live: a 409. */
export class BackupBusyError extends Error {
  constructor() {
    super("a backup or restore is already queued or running");
  }
}

/** What a run reports as its destination: the target with its credentials removed. */
function reportedTarget(target: AdminBackupStartParams["target"]): BackupRunTarget {
  return {
    ...(target.endpoint !== undefined ? { endpoint: target.endpoint } : {}),
    region: target.region,
    bucket: target.bucket,
    prefix: target.prefix,
  };
}

/** A delay that ends early, rejecting, when the server shuts down. */
function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return sleep(ms, undefined, { signal, ref: false });
}

/**
 * The durable shell around a backup, on the place-import pattern: an idempotent start that records
 * a run and returns at once, the work running in this process, a console polling the row, and runs
 * orphaned by a restart closed out at boot (`SnapshotService.onApplicationBootstrap`).
 *
 * Credentials live only in `params`, for the length of {@link execute}; nothing here persists,
 * logs or reports them.
 */
export class BackupService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger("Backup");
  private readonly deps: ServiceDeps;
  private readonly bucketOptions: BackupBucketOptions;
  private active: Promise<void> | undefined;
  /** A start is between its first check and {@link active}: another start must not read a gap. */
  private starting = false;
  private readonly stopping = new AbortController();

  constructor(
    private readonly runs: BackupRunStore,
    {
      bucket,
      ...deps
    }: Omit<ServiceDeps, "sleep" | "now" | "mediaStallMs"> &
      Partial<Pick<ServiceDeps, "sleep" | "now" | "mediaStallMs">> & {
        bucket: BackupBucketOptions;
      },
  ) {
    this.deps = {
      sleep: abortableSleep,
      now: () => Date.now(),
      mediaStallMs: MEDIA_READ_STALL_MS,
      ...deps,
    };
    this.bucketOptions = bucket;
  }

  async onApplicationBootstrap(): Promise<void> {
    const closed = await this.runs.failActive(INTERRUPTED_REASON, this.nowIso());
    if (closed > 0)
      this.logger.warn(`closed out ${closed} interrupted backup run(s) after restart`);
  }

  /**
   * Stop the active run so shutdown is not held up by it: the pool cannot end while the run still
   * holds its connection. A run that fails to record its own end is closed out at the next boot.
   */
  async onModuleDestroy(): Promise<void> {
    this.stopping.abort(new Error("server shutting down"));
    const running = this.active;
    if (running === undefined) return;
    await Promise.race([
      running,
      new Promise((resolve) => setTimeout(resolve, SHUTDOWN_WAIT_MS).unref()),
    ]);
  }

  /**
   * Record a backup and start it. Throws {@link BackupBusyError} if a run is already live, and
   * `BackupEndpointError` for a destination this server may not use.
   */
  start(params: AdminBackupStartParams, requestedBy: string): Promise<BackupRun> {
    return this.claimSlot(params.target, "backup", requestedBy, (run) =>
      Promise.resolve({
        work: async (bucket, progress) => {
          const { locked } = await runBackup(
            this.deps,
            bucket,
            run,
            params,
            progress,
            this.stopping.signal,
          );
          return { status: "done", locked, finishedAt: this.nowIso() };
        },
      }),
    );
  }

  /** Read a backup's manifest and say whether this server would restore it. */
  async inspectRestore(target: BackupS3Target): Promise<AdminRestoreInspection> {
    await checkBackupEndpoint(target, this.bucketOptions.allowPrivateEndpoints);
    const { manifest, refusal } = await this.assessRestore(target);
    return { manifest, ...(refusal !== undefined ? { refusal } : {}) };
  }

  /**
   * Record a restore and start it. Refuses, with the reason inspect gives, by throwing
   * {@link RestoreRefusedError}; the rest as {@link start}.
   */
  startRestore(params: AdminRestoreStartParams, requestedBy: string): Promise<BackupRun> {
    return this.claimSlot(params.target, "restore", requestedBy, async (run) => {
      const { manifest, refusal } = await this.assessRestore(params.target);
      if (refusal !== undefined) throw new RestoreRefusedError(refusal);
      return {
        work: async (bucket, progress) => {
          await runRestore(this.deps, bucket, run, manifest, progress, this.stopping.signal);
          return undefined;
        },
        // The load's connection can die with COMMIT's reply in flight, so a failure here can be a
        // restore that committed. Its row says which, being written in that transaction.
        committed: () => this.isDone(run.id),
        after: this.deps.restart,
        failureNote: () =>
          this.deps.settings.state("writeLocked").value
            ? "the restore failed and this server stays locked (admin.settings.set lifts it)"
            : undefined,
      };
    });
  }

  /** Read a target's manifest and the verdict on it. */
  private async assessRestore(
    target: BackupS3Target,
  ): Promise<{ manifest: BackupManifest; refusal: string | undefined }> {
    const bucket = new BackupBucket(target, this.stopping.signal, this.bucketOptions);
    try {
      const manifest = await readRestoreManifest(bucket, targetSecrets(target));
      const refusal = await restoreRefusal(
        { ...this.deps, runs: this.runs },
        manifest,
        this.stopping.signal,
      );
      return { manifest, refusal };
    } finally {
      bucket.close();
    }
  }

  /** Whether the row says `done`. Not the run's signal: this has to answer during a shutdown too. */
  private async isDone(id: string): Promise<boolean> {
    try {
      const row = await retrying(
        this.deps,
        "the run could not be read",
        new AbortController().signal,
        () => this.runs.get(id),
      );
      return row?.status === "done";
    } catch {
      return false;
    }
  }

  private newRun(kind: BackupRun["kind"], target: BackupS3Target, requestedBy: string): BackupRun {
    return {
      id: ulid(),
      kind,
      status: "queued",
      requestedBy: requestedBy as BackupRun["requestedBy"],
      target: reportedTarget(target),
      createdAt: this.nowIso(),
    };
  }

  /**
   * Take the one slot backup and restore share, record a run, and start the job `prepare` returns.
   * The claim comes before the first await after the endpoint check, so a second start cannot see
   * no job here while this one is still creating its row, and close that row out as orphaned.
   */
  private async claimSlot(
    target: BackupS3Target,
    kind: BackupRun["kind"],
    requestedBy: string,
    prepare: (run: BackupRun) => Promise<RunJob>,
  ): Promise<BackupRun> {
    await checkBackupEndpoint(target, this.bucketOptions.allowPrivateEndpoints);
    if (this.starting || this.active !== undefined) throw new BackupBusyError();
    this.starting = true;
    try {
      const run = this.newRun(kind, target, requestedBy);
      const job = await prepare(run);
      if (!(await this.runs.create(run))) {
        // One server per database, and no job running here, so the live row is a run whose closing
        // write was lost. Without this it would refuse every start until a restart.
        const closed = await this.runs.failActive(ORPHANED_REASON, this.nowIso());
        this.logger.warn(`closed out ${closed} run(s) with no job behind them`);
        if (!(await this.runs.create(run))) throw new BackupBusyError();
      }
      this.active = this.execute(run, target, job).finally(() => {
        this.active = undefined;
      });
      return run;
    } finally {
      this.starting = false;
    }
  }

  getRun(id: string): Promise<BackupRun | undefined> {
    return this.runs.get(id);
  }

  listRuns(): Promise<BackupRun[]> {
    return this.runs.recent(RUN_LIST_LIMIT);
  }

  /** Resolves once no run is in progress: for tests, which poll a run that is otherwise fire-and-forget. */
  async idle(): Promise<void> {
    await this.active;
  }

  /** Run the job to its end, then its `after` once everything is closed, if it ended well. */
  private async execute(run: BackupRun, target: BackupS3Target, job: RunJob): Promise<void> {
    if (await this.attempt(run, target, job)) job.after?.();
  }

  /** Whether the run ended well. Never throws: every failure is written to the run instead. */
  private async attempt(run: BackupRun, target: BackupS3Target, job: RunJob): Promise<boolean> {
    const secrets = targetSecrets(target);
    const progress = new RunProgress(
      emptyStats(),
      (patch) => this.runs.update(run.id, patch),
      (err) => {
        this.logger.error(`could not save run ${run.id}: ${safeRunError(err, secrets)}`);
      },
      this.deps.now,
      // Not the run's signal: the closing write has to go out even when shutdown stopped the run.
      (ms) => this.deps.sleep(ms, new AbortController().signal),
    );
    let bucket: BackupBucket | undefined;
    try {
      bucket = new BackupBucket(target, this.stopping.signal, this.bucketOptions);
      await this.runs.update(run.id, {
        status: "running",
        startedAt: this.nowIso(),
        stats: emptyStats(),
      });
      const closing = await job.work(bucket, progress);
      if (closing) await progress.finish(closing);
      return true;
    } catch (err) {
      const message = safeRunError(err, secrets);
      if (await job.committed?.()) {
        this.logger.warn(`${run.kind} run ${run.id} committed before this error: ${message}`);
        return true;
      }
      const note = job.failureNote?.();
      const error = (note !== undefined ? `${note}: ${message}` : message).slice(
        0,
        MAX_ERROR_LENGTH,
      );
      this.logger.error(`${run.kind} run ${run.id} failed: ${error}`);
      await progress.finish({ status: "failed", error, finishedAt: this.nowIso() });
      return false;
    } finally {
      bucket?.close();
    }
  }

  private nowIso(): string {
    return new Date(this.deps.now()).toISOString();
  }
}
