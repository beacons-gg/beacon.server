import type { DidKey, OpEnvelope } from "@beaconsgg/protocol-types";
import { HttpException, HttpStatus, Inject, Injectable } from "@nestjs/common";
import { notFound, signedReadParams } from "./capability-http";
import { SignedRequestGate } from "./signed-request-gate";
import { NonceService } from "./nonce.service";
import type { ParsedOp } from "./signed-routes";

/** DI token for the server-wide operator allowlist (`BEACON_ADMINS`). */
export const ADMINS = "BEACON_ADMINS_LIST";

/**
 * The one admin gate (`doc/spec/admin-api.md` §2), shared by every admin controller: no admins
 * configured ⇒ the routes 404 as if absent (before any crypto work) → signature verified + not
 * blocked + device not revoked (the shared signed-request gate) → the verified actor is on
 * `BEACON_ADMINS` (else 403). A capability-scoped controller (places) 404s on its own opt-in flag
 * before calling in. The gate also owns the replay-rejecting **signed-read** bracket (it composes
 * {@link verify}); the idempotent-write bracket is `NonceService.idempotentResult` — pure nonce
 * discipline, no admin policy, so it lives with the nonce log.
 */
@Injectable()
export class AdminGate {
  constructor(
    private readonly signed: SignedRequestGate,
    private readonly nonce: NonceService,
    @Inject(ADMINS) private readonly admins: string[],
  ) {}

  /**
   * The surface's own 404, before any input is read: with no admins configured the routes look
   * absent. A route that must decode something before it can {@link verify} calls this first, so a
   * server with no admins answers 404 whatever the request carries.
   */
  assertEnabled(): void {
    if (this.admins.length === 0) notFound("admin surface not enabled");
  }

  /** The gate itself: absent surface → signed + admitted by the shared bracket → allowlisted. */
  verify(body: unknown, op: string): { actor: DidKey; env: OpEnvelope } {
    this.assertEnabled();
    const verified = this.signed.verify(body, op);
    if (!this.admins.includes(verified.actor)) {
      throw new HttpException(
        { ok: false, error: "denied", message: "not an admin" },
        HttpStatus.FORBIDDEN,
      );
    }
    return verified;
  }

  /** The admin signed-read: the allowlist gate, then the shared replay/parse bracket. */
  signedRead<P>(body: unknown, route: ParsedOp<P>): Promise<P> {
    return signedReadParams(this.nonce, this.verify(body, route.op), route.params);
  }
}
