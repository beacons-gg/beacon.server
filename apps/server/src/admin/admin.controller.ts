import {
  type AdminMediaList,
  type AdminMediaReview,
  type AdminSettings,
  type AdminStatus,
  type BlockEntry,
  type DidKey,
} from "@beaconsgg/protocol-types";
import { z } from "zod";
import { Body, Controller, Inject, Logger, Post, UseGuards } from "@nestjs/common";
import { AdminGate } from "../common/admin-gate";
import { auditLine, removedDetail } from "../common/audit";
import { SenderBlocklist } from "../common/blocklist";
import { badParams, badRequest, parseParams } from "../common/capability-http";
import { NonceService } from "../common/nonce.service";
import type { SignedBy } from "../stores/nonce-store";
import { type ParsedOp, SIGNED_ROUTES } from "../common/signed-routes";
import { WriteRateLimitGuard } from "../common/rate-limit.guard";
import { AllowWhileLocked } from "../common/write-lock.guard";
import {
  MEDIA_LIST_DEFAULT_LIMIT,
  MediaService,
  decodeMediaCursor,
  encodeMediaCursor,
} from "../media/media.service";
import type { MediaListQuery } from "../stores/media-store";
import { SnapshotService } from "../places/snapshot.service";
import { RoomsService } from "../rooms/rooms.service";
import type { ServerConfig } from "../config";
import { BOOT_ENV, SERVER_CONFIG } from "../settings/live-config";
import { settingsReport } from "../settings/settings-report";
import { SettingsService } from "../settings/settings.service";
import { AdminService } from "./admin.service";

/**
 * The written values for one audit line, bounded.
 *
 * The `settings` rows are the record of what a setting *is* (with `updated_by` and `updated_at` on
 * each), so this line's job is only to say that an operator changed these keys to roughly this, in
 * the same stream as every other admin action. A `description` or a long `coverage` list would
 * otherwise put a kilobyte in the log for no gain. No runtime setting is a secret — `SECRET_KEYS
 * satisfies readonly DeployTimeKey[]` makes that a compile-time fact — so the values are safe to log.
 */
function auditValues(settings: Record<string, unknown>): string {
  const json = JSON.stringify(settings);
  return `values=${json.length > 300 ? `${json.slice(0, 300)}...` : json}`;
}

/**
 * The server-wide **admin** surface (`doc/spec/admin-api.md` §3) — signed reads/ops from a DID on
 * `BEACON_ADMINS`, gated by the shared {@link AdminGate}. Never advertised in the descriptor; 404
 * when no admins are configured (the surface looks absent). POSTs only — a signed read rides a
 * body, the `POST /mailbox/fetch` precedent.
 *
 * **Audit:** every action here logs one structured `{op, actor, target, reason?}` line,
 * configuration changes included — a durable audit table is deferred with a trigger (compliance
 * need / multi-admin dispute). The settings ops are the case that most wants one, and are also the
 * case least hurt by its absence: `settings.updated_by`/`updated_at` already record who holds each
 * override now, so what is missing is the history rather than the current state.
 */
@Controller()
export class AdminController {
  private readonly logger = new Logger("Admin");

  constructor(
    private readonly gate: AdminGate,
    private readonly admin: AdminService,
    private readonly nonce: NonceService,
    private readonly rooms: RoomsService,
    private readonly media: MediaService,
    private readonly blocklist: SenderBlocklist,
    private readonly settings: SettingsService,
    @Inject(SERVER_CONFIG) private readonly config: ServerConfig,
    @Inject(BOOT_ENV) private readonly bootEnv: NodeJS.ProcessEnv,
    private readonly snapshots: SnapshotService,
  ) {}

  /** Signed read: the operator dashboard overview — descriptor facts + store counts. */
  @Post("admin/status")
  @AllowWhileLocked()
  async status(@Body() body: unknown): Promise<{ ok: true; status: AdminStatus }> {
    await this.gate.signedRead(body, SIGNED_ROUTES["admin/status"]);
    return { ok: true, status: await this.admin.status() };
  }

  /** Force-remove a custodied room: watchers get the normal `closed` + `roomGone` events. */
  @Post("admin/rooms/remove")
  @UseGuards(WriteRateLimitGuard)
  roomRemove(@Body() body: unknown): Promise<{ ok: true; removed: boolean }> {
    return this.moderate(
      body,
      SIGNED_ROUTES["admin/rooms/remove"],
      (p) => p.id,
      (p) => this.rooms.adminRemove(p.id),
    );
  }

  /** Delete a media object (blob bytes + metadata) by content hash. */
  @Post("admin/media/remove")
  @UseGuards(WriteRateLimitGuard)
  mediaRemove(@Body() body: unknown): Promise<{ ok: true; removed: boolean }> {
    return this.moderate(
      body,
      SIGNED_ROUTES["admin/media/remove"],
      (p) => p.hash,
      (p) => this.media.remove(p.hash),
    );
  }

  /**
   * Signed read: one newest-first, filtered page of the content-addressed media store — the console's
   * browse/review surface. Enumeration is admin-only (the bytes are already public by hash); the
   * opaque `cursor` walks pages by keyset.
   */
  @Post("admin/media/list")
  async mediaList(@Body() body: unknown): Promise<{ ok: true } & AdminMediaList> {
    const params = await this.gate.signedRead(body, SIGNED_ROUTES["admin/media/list"]);
    const cursor = params.cursor === undefined ? undefined : decodeMediaCursor(params.cursor);
    if (params.cursor !== undefined && cursor === undefined) badRequest("invalid cursor");
    const query: MediaListQuery = {
      limit: params.limit ?? MEDIA_LIST_DEFAULT_LIMIT,
      sort: params.sort ?? "recent",
      ...(cursor ? { cursor } : {}),
      ...(params.owner !== undefined ? { owner: params.owner } : {}),
      ...(params.type !== undefined ? { type: params.type } : {}),
      ...(params.reviewed !== undefined ? { reviewed: params.reviewed } : {}),
    };
    const page = await this.media.list(query);
    return {
      ok: true,
      items: page.items,
      ...(page.nextCursor ? { nextCursor: encodeMediaCursor(page.nextCursor) } : {}),
    };
  }

  /** Mark a media object reviewed (or clear the stamp) — the review-queue action. */
  @Post("admin/media/review")
  @UseGuards(WriteRateLimitGuard)
  async mediaReview(@Body() body: unknown): Promise<{ ok: true } & AdminMediaReview> {
    const route = SIGNED_ROUTES["admin/media/review"];
    const signed = this.gate.verify(body, route.op);
    const { actor } = signed;
    const params = parseParams(route.params, signed.env.params);
    const result = await this.nonce.idempotentResult(signed, () =>
      this.media.review(params.hash, actor, params.reviewed),
    );
    this.audit(
      route.op,
      actor,
      params.hash,
      params.reason,
      undefined,
      `reviewed=${String(params.reviewed)}`,
    );
    return { ok: true, ...result };
  }

  /** Durably block a DID: denied on every signed capability/admin request, effective now. */
  @Post("admin/blocklist/add")
  @UseGuards(WriteRateLimitGuard)
  async blocklistAdd(@Body() body: unknown): Promise<{ ok: true }> {
    const route = SIGNED_ROUTES["admin/blocklist/add"];
    const signed = this.gate.verify(body, route.op);
    const { actor } = signed;
    const params = parseParams(route.params, signed.env.params);
    // SenderBlocklist owns the protected-DID invariant; this is its HTTP translation (400, not 500).
    if (this.blocklist.isProtected(params.did)) badRequest("cannot block an admin");
    const result = await this.nonce.idempotentResult(signed, async () => {
      await this.blocklist.add({
        did: params.did,
        ...(params.reason !== undefined ? { reason: params.reason } : {}),
        addedBy: actor,
        addedAt: new Date().toISOString(),
      });
      return { ok: true as const };
    });
    this.audit(route.op, actor, params.did, params.reason);
    return result;
  }

  /** Lift a durable blocklist entry. */
  @Post("admin/blocklist/remove")
  @UseGuards(WriteRateLimitGuard)
  blocklistRemove(@Body() body: unknown): Promise<{ ok: true; removed: boolean }> {
    return this.moderate(
      body,
      SIGNED_ROUTES["admin/blocklist/remove"],
      (p) => p.did,
      (p) => this.blocklist.remove(p.did),
    );
  }

  /** Signed read: the durable blocklist. */
  @Post("admin/blocklist/fetch")
  async blocklistFetch(@Body() body: unknown): Promise<{ ok: true; entries: BlockEntry[] }> {
    await this.gate.signedRead(body, SIGNED_ROUTES["admin/blocklist/fetch"]);
    return { ok: true, entries: await this.blocklist.list() };
  }

  /**
   * Signed read: the whole server configuration (`doc/spec/runtime-settings.md` §5) — the 42
   * editable settings with their provenance, and the 29 deploy-time fields read-only beside them,
   * so one screen answers both "what is this set to" and "why can I not change it here". Secrets
   * report set/unset only.
   */
  @Post("admin/settings/get")
  @AllowWhileLocked()
  async settingsGet(@Body() body: unknown): Promise<{ ok: true } & AdminSettings> {
    await this.gate.signedRead(body, SIGNED_ROUTES["admin/settings/get"]);
    return this.report();
  }

  /**
   * Override one or more settings, effective on the next request rather than the next deploy.
   *
   * **Several keys in one op is the design, not a batching convenience.** These settings constrain
   * each other, so turning `placesEnabled` off means turning its dependants off in the same signed
   * write; one at a time forces the operator through a state the validator refuses, in whichever
   * order they try. `SettingsService.setMany` validates the whole patch against the resulting
   * configuration before storing any of it.
   */
  @Post("admin/settings/set")
  @AllowWhileLocked()
  @UseGuards(WriteRateLimitGuard)
  async settingsSet(@Body() body: unknown): Promise<{ ok: true } & AdminSettings> {
    const route = SIGNED_ROUTES["admin/settings/set"];
    const signed = this.gate.verify(body, route.op);
    const params = parseParams(route.params, signed.env.params);

    // `null` is how "no value" travels (JSON has no `undefined`), and the registry schemas speak
    // `undefined` — so an optional setting an operator clears is refused by its own schema rather
    // than by a type error nobody sees. Overriding to no value is not a reset: the row stands and
    // the environment stays out of it until `admin.settings.reset` drops it.
    const patch: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(params.settings)) {
      patch[key] = value === null ? undefined : value;
    }

    await this.write(signed, Object.keys(patch), params.reason, {
      run: () => {
        this.refuseLockOverPlaceRun(patch["writeLocked"] === true);
        return this.settings.setMany(patch, signed.actor);
      },
      detail: auditValues(params.settings),
    });
    return this.report();
  }

  /**
   * Drop these overrides, handing the settings back to the environment.
   *
   * Never refused for the combination it leaves behind: an admin who could not reset a prerequisite
   * while a dependant override stood could not undo their own change except in one particular
   * order. The dependant goes dormant instead, and applies again if its prerequisite comes back
   * (`doc/spec/runtime-settings.md` §4.1).
   */
  @Post("admin/settings/reset")
  @AllowWhileLocked()
  @UseGuards(WriteRateLimitGuard)
  async settingsReset(@Body() body: unknown): Promise<{ ok: true } & AdminSettings> {
    const route = SIGNED_ROUTES["admin/settings/reset"];
    const signed = this.gate.verify(body, route.op);
    const params = parseParams(route.params, signed.env.params);

    await this.write(signed, params.keys, params.reason, {
      run: () => {
        // A reset hands the key to the environment, so it locks too when BEACON_WRITE_LOCK is on.
        this.refuseLockOverPlaceRun(
          params.keys.includes("writeLocked") && this.settings.state("writeLocked").envValue,
        );
        return this.settings.resetMany(params.keys, signed.actor);
      },
    });
    return this.report();
  }

  /**
   * The settings write bracket: nonce-idempotent run, audit **inside** it, refusals as 400s.
   *
   * The audit line goes inside the bracket because outside it a replayed envelope logs a change that
   * did not happen: `idempotentResult` correctly declines to re-run the write, and an audit call
   * after it would still record one, so a stream would show two configuration changes where an
   * operator made one. What actually changed is logged separately by `SettingsService`, from the
   * `finally` of the write, so a patch that dies half way still says which rows it got through.
   *
   * `SettingsService` throws a {@link z.ZodError} for a key it will not write, a value its schema
   * refuses, and a combination `loadConfig` could not have produced. All three are the operator's
   * input, so all three are 400s carrying the per-key detail intact rather than a 500 that says
   * nothing. A 4xx inside `run` never records the nonce, so a corrected retry is free to reuse it.
   */
  private async write(
    signed: SignedBy,
    keys: readonly string[],
    reason: string | undefined,
    { run, detail }: { run: () => Promise<void>; detail?: string },
  ): Promise<void> {
    await this.nonce.idempotentResult(signed, async () => {
      try {
        await run();
      } catch (err) {
        if (err instanceof z.ZodError) badParams(err);
        throw err;
      }
      this.audit(signed.env.op, signed.actor, keys.join(","), reason, undefined, detail);
      return { applied: keys };
    });
  }

  /**
   * Refuse to lock the server under a place run, which would keep writing through the lock. A
   * {@link z.ZodError} so it reaches an admin the way every other settings refusal does: one 400,
   * with the reason on the setting it is about, and the nonce left free for the retry.
   */
  private refuseLockOverPlaceRun(locking: boolean): void {
    if (!locking || !this.snapshots.hasActiveRun()) return;
    throw new z.ZodError([
      {
        code: z.ZodIssueCode.custom,
        path: ["writeLocked"],
        message:
          "a place import is queued or running; wait for it to finish or cancel it, then lock",
      },
    ]);
  }

  /** The whole configuration, rebuilt after every op — see {@link settingsGet}. */
  private report(): { ok: true } & AdminSettings {
    return { ok: true, settings: settingsReport(this.config, this.settings, this.bootEnv) };
  }

  /**
   * The shared moderation bracket: gate → parse → nonce-idempotent run → audit. Every remove route
   * is shaped `{target, reason?} → {removed}`; `target` extracts the audit line's subject.
   */
  private async moderate<P extends { reason?: string | undefined }>(
    body: unknown,
    { op, params: schema }: ParsedOp<P>,
    target: (params: P) => string,
    run: (params: P) => Promise<boolean>,
  ): Promise<{ ok: true; removed: boolean }> {
    const signed = this.gate.verify(body, op);
    const params = parseParams(schema, signed.env.params);
    const { removed } = await this.nonce.idempotentResult(signed, async () => ({
      removed: await run(params),
    }));
    this.audit(op, signed.actor, target(params), params.reason, removed);
    return { ok: true, removed };
  }

  /** One structured audit line per admin action (`doc/spec/admin-api.md` §3, Audit). */
  private audit(
    op: string,
    actor: DidKey,
    target: string,
    reason?: string,
    removed?: boolean,
    detail?: string,
  ): void {
    this.logger.log(auditLine(op, actor, target, [removedDetail(removed), detail], reason));
  }
}
