import {
  type AdminRestoreInspection,
  type BackupRun,
  type BackupS3Target,
  type DidKey,
} from "@beaconsgg/protocol-types";
import { Body, Controller, Logger, Post, UseGuards } from "@nestjs/common";
import { AdminGate } from "../common/admin-gate";
import { badRequest, conflict, missing, parseParams } from "../common/capability-http";
import { NonceService } from "../common/nonce.service";
import { type ParsedOp, SIGNED_ROUTES } from "../common/signed-routes";
import { WriteRateLimitGuard } from "../common/rate-limit.guard";
import { AllowWhileLocked } from "../common/write-lock.guard";
import { BackupEndpointError } from "./backup-target";
import { BackupBusyError, BackupService } from "./backup.service";
import { RestoreManifestError, RestoreRefusedError } from "./restore-job";

/** Rethrow `err`, as the refusal it is when the operator's input is what is wrong. */
function refusedAs4xx(err: unknown): never {
  if (err instanceof BackupBusyError) conflict(err.message);
  if (
    err instanceof BackupEndpointError ||
    err instanceof RestoreManifestError ||
    err instanceof RestoreRefusedError
  ) {
    badRequest(err.message);
  }
  throw err;
}

/**
 * The backup admin surface: the signed start and the poll the console follows a run with
 * (`doc/spec/admin-api.md` §3). Both answer while the server is locked, because locking first is
 * how an owner takes a backup nothing can change under.
 *
 * Credentials come in the signed params of the start and go no further than the run's memory. They
 * are not in the audit line, and only the run id is memoized against the nonce, so a retry re-reads
 * the run and the nonce log holds nothing of the target.
 */
@Controller()
export class BackupController {
  private readonly logger = new Logger("Admin");

  constructor(
    private readonly backups: BackupService,
    private readonly gate: AdminGate,
    private readonly nonce: NonceService,
  ) {}

  /** Start a backup. Idempotent by nonce: a retried start returns the run the first call created. */
  @Post("admin/backup/start")
  @AllowWhileLocked()
  @UseGuards(WriteRateLimitGuard)
  start(@Body() body: unknown): Promise<{ ok: true; run: BackupRun }> {
    return this.startRun(
      body,
      SIGNED_ROUTES["admin/backup/start"],
      (params, actor) => this.backups.start(params, actor),
      (params) => ` includeIdentity=${String(params.includeIdentity)}`,
    );
  }

  /** Signed read of a backup's manifest and whether this server would restore it. */
  @Post("admin/restore/inspect")
  @AllowWhileLocked()
  async inspect(@Body() body: unknown): Promise<{ ok: true } & AdminRestoreInspection> {
    const { target } = await this.gate.signedRead(body, SIGNED_ROUTES["admin/restore/inspect"]);
    try {
      return { ok: true, ...(await this.backups.inspectRestore(target)) };
    } catch (err) {
      refusedAs4xx(err);
    }
  }

  /** Start a restore. Idempotent by nonce; refused with the reason inspect gives. */
  @Post("admin/restore/start")
  @AllowWhileLocked()
  @UseGuards(WriteRateLimitGuard)
  restore(@Body() body: unknown): Promise<{ ok: true; run: BackupRun }> {
    return this.startRun(body, SIGNED_ROUTES["admin/restore/start"], (params, actor) =>
      this.backups.startRestore(params, actor),
    );
  }

  /** Signed read: one run by id, or the most recent runs of both kinds. */
  @Post("admin/backup/runs")
  @AllowWhileLocked()
  async runs(@Body() body: unknown): Promise<{ ok: true; runs: BackupRun[] }> {
    const params = await this.gate.signedRead(body, SIGNED_ROUTES["admin/backup/runs"]);
    if (params.id !== undefined) {
      const run = await this.backups.getRun(params.id);
      return { ok: true, runs: run ? [run] : [] };
    }
    return { ok: true, runs: await this.backups.listRuns() };
  }

  /** Gate, parse and nonce bracket around a start: only the memoized run id outlives the request. */
  private async startRun<P extends { target: BackupS3Target }>(
    body: unknown,
    { op, params: schema }: ParsedOp<P>,
    start: (params: P, actor: DidKey) => Promise<BackupRun>,
    detail: (params: P) => string = () => "",
  ): Promise<{ ok: true; run: BackupRun }> {
    const signed = this.gate.verify(body, op);
    const { actor } = signed;
    const params = parseParams(schema, signed.env.params);

    const { id } = await this.nonce.idempotentResult(signed, async () => {
      try {
        const run = await start(params, actor);
        // Inside the bracket, as `admin.settings.*` are, so a replay does not log a second start.
        const { bucket, prefix } = params.target;
        this.logger.log(
          `${op} actor=${actor} target=${bucket}/${prefix}${detail(params)} run=${run.id}`,
        );
        return { id: run.id };
      } catch (err) {
        refusedAs4xx(err);
      }
    });
    const run = await this.backups.getRun(id);
    if (!run) missing("unknownRun", "run record missing"); // a durable row, so this is only for safety
    return { ok: true, run };
  }
}
