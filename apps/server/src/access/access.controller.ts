import type { AccessResult } from "@beaconsgg/protocol-types";
import { Body, Controller, Post, UseGuards } from "@nestjs/common";
import { denied, parseParams, rateLimited, signedReadParams } from "../common/capability-http";
import { DidBudgets } from "../common/did-budgets";
import { MAX_PENDING_REQUESTS, MemberList } from "../common/member-list";
import { NonceService } from "../common/nonce.service";
import { WriteRateLimitGuard } from "../common/rate-limit.guard";
import { SignedReadRateLimitGuard } from "../common/read-rate-limit.guard";
import { SignedRequestGate } from "../common/signed-request-gate";
import { SIGNED_ROUTES } from "../common/signed-routes";

/**
 * The player side of the member list (`doc/spec/admin-api.md` §6): ask to join a server at the
 * `request` level, and read where you stand.
 *
 * Both are signed, so the request is the verified account's and nobody can ask on another's behalf
 * or read another's standing. Neither is a game write: a player who is not a member yet is exactly
 * who calls them, so both go through the plain bracket, never `verifyWrite`, and neither names or
 * needs a game. A blocked account is still refused by the bracket.
 */
@Controller()
export class AccessController {
  constructor(
    private readonly members: MemberList,
    private readonly gate: SignedRequestGate,
    private readonly nonce: NonceService,
    private readonly budgets: DidBudgets,
  ) {}

  /**
   * Ask to join. Only a `request` server takes one: `private` refuses `denied`, and an `open` server
   * answers `member` without recording anything. Asking again while pending replaces the note; a
   * member or a declined player is answered as they stand.
   */
  @Post("access/request")
  @UseGuards(WriteRateLimitGuard)
  async request(@Body() body: unknown): Promise<AccessResult> {
    const route = SIGNED_ROUTES["access/request"];
    const signed = this.gate.verify(body, route.op);
    const params = parseParams(route.params, signed.env.params);
    const level = this.members.level;
    if (level === "private") denied("this server takes no requests to join");
    if (level === "open") return { ok: true, accessLevel: level, status: "member" };
    // The memo is the status the request left, so a retry after a lost reply answers the same and
    // is not billed again. A refusal inside the bracket records nothing, so a retry may yet fit.
    const { status } = await this.nonce.idempotentResult(signed, async () => {
      // Billed as a player write, so a loop re-sending its note runs out like any other write.
      if (!this.budgets.allowPlayerWrite(signed.actor, route.op)) {
        rateLimited("too many writes for this account");
      }
      const result = await this.members.request(
        signed.actor,
        params.note,
        new Date().toISOString(),
      );
      if (result === "full") {
        rateLimited(`${String(MAX_PENDING_REQUESTS)} requests are already waiting for an answer`);
      }
      return { status: result };
    });
    return { ok: true, accessLevel: level, status };
  }

  /** Signed read: where the verified player stands on this server. */
  @Post("access/status")
  @UseGuards(SignedReadRateLimitGuard)
  async status(@Body() body: unknown): Promise<AccessResult> {
    const route = SIGNED_ROUTES["access/status"];
    const signed = this.gate.verify(body, route.op);
    await signedReadParams(this.nonce, signed, route.params);
    return { ok: true, accessLevel: this.members.level, status: this.members.status(signed.actor) };
  }
}
