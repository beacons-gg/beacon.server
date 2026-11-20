import type {
  AdminAccessAdmitAllResult,
  AdminAccessEntryResult,
  AdminAccessFetchResult,
  DidKey,
} from "@beaconsgg/protocol-types";
import { Body, Controller, Logger, Post, UseGuards } from "@nestjs/common";
import { AdminGate } from "../common/admin-gate";
import { auditLine, removedDetail } from "../common/audit";
import { badRequest, parseParams } from "../common/capability-http";
import { MemberList } from "../common/member-list";
import { NonceService } from "../common/nonce.service";
import { WriteRateLimitGuard } from "../common/rate-limit.guard";
import { type ParsedOp, SIGNED_ROUTES } from "../common/signed-routes";
import { ProfilesService } from "../profiles/profiles.service";

/**
 * The admin side of the member list (`doc/spec/admin-api.md` §6): list it, add or approve, decline,
 * remove, and admit everyone with a profile here and no entry. Every route is behind the shared
 * {@link AdminGate}, and each write logs one audit line in the admin surface's format.
 *
 * The list can be managed at any level, so an operator can prepare it before moving off `open`.
 */
@Controller()
export class AccessAdminController {
  private readonly logger = new Logger("Admin");

  constructor(
    private readonly gate: AdminGate,
    private readonly members: MemberList,
    private readonly nonce: NonceService,
    private readonly profiles: ProfilesService,
  ) {}

  /** Signed read: the member list, pending requests first. */
  @Post("admin/access/fetch")
  async fetch(@Body() body: unknown): Promise<AdminAccessFetchResult> {
    const params = await this.gate.signedRead(body, SIGNED_ROUTES["admin/access/fetch"]);
    return { ok: true, entries: this.members.list(params.status) };
  }

  /** Make an account a member, approving its request if it has one. */
  @Post("admin/access/add")
  @UseGuards(WriteRateLimitGuard)
  async add(@Body() body: unknown): Promise<AdminAccessEntryResult> {
    const entry = await this.write(body, SIGNED_ROUTES["admin/access/add"], (p, actor, now) =>
      this.members.add(p.did, actor, now),
    );
    return { ok: true, entry };
  }

  /** Decline a pending request; `400` when the account has none. */
  @Post("admin/access/decline")
  @UseGuards(WriteRateLimitGuard)
  async decline(@Body() body: unknown): Promise<AdminAccessEntryResult> {
    const entry = await this.write(
      body,
      SIGNED_ROUTES["admin/access/decline"],
      async (p, actor, now) =>
        (await this.members.decline(p.did, actor, now)) ?? badRequest("no pending request"),
    );
    return { ok: true, entry };
  }

  /** Delete an entry: a member loses write access, and a declined player may ask again. */
  @Post("admin/access/remove")
  @UseGuards(WriteRateLimitGuard)
  async remove(@Body() body: unknown): Promise<{ ok: true; removed: boolean }> {
    const removed = await this.write(
      body,
      SIGNED_ROUTES["admin/access/remove"],
      (p) => this.members.remove(p.did),
      removedDetail,
    );
    return { ok: true, removed };
  }

  /** Make a member of every account with a profile here and no entry. */
  @Post("admin/access/admitAll")
  @UseGuards(WriteRateLimitGuard)
  async admitAll(@Body() body: unknown): Promise<AdminAccessAdmitAllResult> {
    const added = await this.write(
      body,
      SIGNED_ROUTES["admin/access/admitAll"],
      (_p, actor, now) => this.members.admitAll(this.profiles.accounts(), actor, now),
      (n) => `added=${String(n)}`,
    );
    return { ok: true, added };
  }

  /**
   * The bracket every write shares: gate, parse, a nonce-idempotent run, one audit line. The line is
   * written inside the run, so a replayed envelope logs nothing a second time. Its target is the
   * account the params name, or `profiles` for `admitAll`, which names none.
   */
  private async write<P extends { did?: DidKey | undefined; reason?: string | undefined }, R>(
    body: unknown,
    route: ParsedOp<P>,
    run: (params: P, actor: DidKey, now: string) => Promise<R>,
    detail?: (result: R) => string | undefined,
  ): Promise<R> {
    const signed = this.gate.verify(body, route.op);
    const params = parseParams(route.params, signed.env.params);
    const { result } = await this.nonce.idempotentResult(signed, async () => {
      const done = await run(params, signed.actor, new Date().toISOString());
      const line = auditLine(
        route.op,
        signed.actor,
        params.did ?? "profiles",
        [detail?.(done)],
        params.reason,
      );
      this.logger.log(line);
      return { result: done };
    });
    return result;
  }
}
