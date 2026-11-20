import type { DidKey, OpEnvelope } from "@beaconsgg/protocol-types";
import { HttpException, HttpStatus, Inject, Injectable } from "@nestjs/common";
import { BLOCKED_MESSAGE, SenderBlocklist } from "./blocklist";
import { MemberList } from "./member-list";
import { verifySignedRequest } from "./signed-request";

/** DI token for the device-revocation source (the published-profile registry in production). */
export const DEVICE_REVOCATIONS = "DEVICE_REVOCATIONS";

/**
 * Whether a device is currently revoked, as this gate needs to ask it. A narrow interface rather
 * than `ProfilesService` itself, for two reasons: it keeps `common/` from value-importing a feature
 * module (nothing else here does), and it lets a test double be typechecked instead of cast, so
 * changing this shape breaks the doubles rather than silently passing against a stale one.
 */
export interface DeviceRevocations {
  isRevoked(account: DidKey, device: DidKey): boolean;
}

/**
 * The verdict {@link SignedRequestGate.check} returns: the cryptographic actor and their envelope,
 * or a refusal carrying **both** shapes its two kinds of caller need — an HTTP status for a route
 * that throws, and an `error` code for the WS gateway, which has no response to throw and answers
 * in its own ack. `message` is for the operator reading a log, not the client branching on it.
 */
export type SignedRequestCheck =
  | { readonly ok: true; readonly actor: DidKey; readonly env: OpEnvelope }
  | {
      readonly ok: false;
      readonly status: number;
      readonly error: string;
      readonly message: string;
      readonly fields?: readonly string[];
    };

/**
 * The one bracket every signed request passes through: parse → op name → verify → freshness →
 * **the two consults that are true of every surface**.
 *
 * "Every" is now literal rather than aspirational: room placement and the scout relay were the last
 * two paths that opened their own envelopes, and both route through here. `verifySignedRequest` has
 * exactly one caller, which is what makes that structural rather than a habit.
 *
 * Two signed inputs are verified elsewhere, both deliberately. A room **op** goes through the
 * engine, which verifies and consults inside `applyOp` — a different bracket by design, not a
 * straggler. And a **`ProfileDoc`** (`POST /profiles`) is not an op envelope at all: it is signed by
 * the account *root* rather than a device, so there is no device to ask about, and gating the
 * revocation registry on revocation would be circular.
 *
 * **Identity is settled here, before any application question is asked.** The chain a boundary path
 * runs is therefore `block → revocation → app → budget`, while the engine's is `block → app →
 * revocation → budget`. That divergence is decided, not inherited: the two consults this holds
 * answer whether there is a legitimate actor at all, and an application question presumes a player
 * to ask it about — a revoked device is not the player (see "Requests, not writes" below), so
 * asking what application it claims to be is asking about nobody. The structure agrees: the only
 * way to seat the app gate between the two is to give this bracket an app predicate or split it
 * into two stages, which is machinery this bracket exists to avoid.
 *
 * The consequence is visible on one request: a revoked device *and* an unadmitted game gets
 * `deviceRevoked` here and `gameNotAdmitted` from the engine. The engine's own ordering claim is
 * unasserted (no test pins app-before-revocation), and its stated reasons ("a blocked actor is
 * still refused first", "before any budget is charged") constrain only the ends of the chain. So
 * the engine is the side that should move, rather than this bracket.
 *
 * **Block and revocation are universal; the app gate and the budget are not.** Membership sits in
 * between: it needs only the actor, like these two, but applies to writes alone, so it has its own
 * entry point ({@link verifyWrite}) rather than a place in {@link check}. That asymmetry is
 * why this holds exactly two things and not four, and the criterion behind it is sharper than "some
 * consults are shared": these two need nothing but the `(actor, envelope)` the bracket already has,
 * while the other two need what it cannot know. An app gate covers game content only and must never
 * reach the admin surface; a budget is a per-surface class whose classes do not even share a
 * failure code (`429` for the rate windows, `413` for the media byte quota). Both stay at their
 * call sites. `doc/spec/room-operation.md` §5 has the order a room op sees.
 *
 * **Requests, not writes.** A revoked device may not *read* its owner's mailbox either — that is a
 * stolen phone reading their messages — so signed reads go through this too. That is the opposite
 * of the app gate's rule next door, and deliberately: an app-denied player still owns their pending
 * submissions, while a revoked device is not the player at all.
 */
@Injectable()
export class SignedRequestGate {
  constructor(
    private readonly blocklist: SenderBlocklist,
    @Inject(DEVICE_REVOCATIONS) private readonly revocations: DeviceRevocations,
    private readonly members: MemberList,
  ) {}

  /**
   * The verdict: verify a signed request, then refuse it if the operator blocked the actor or the
   * actor revoked the device. Returns the cryptographic `actor` and the envelope; the caller owns
   * everything after — its own capability flag, its params, its budget, and (for game content) the
   * app gate.
   *
   * Non-throwing, because one signed surface is not an HTTP route: `mailbox:subscribe` arrives over
   * the WS gateway and answers in an ack. {@link verify} is the throwing form the routes use. Same
   * split, and for the same reason, as `GameGate`'s `admits` / `assertAdmits`.
   */
  check(body: unknown, op: string | readonly string[]): SignedRequestCheck {
    const req = verifySignedRequest(body, op);
    if (!req.ok) return req;

    // Block before revocation, matching the order the engine runs. Not for the lookup it saves (the
    // consult is a Map read against an Ed25519 verify that has already happened), but so a blocked
    // actor learns nothing about the account's device state, which is the only difference the two
    // refusals have on the wire.
    if (this.blocklist.has(req.actor)) {
      return {
        ok: false,
        status: HttpStatus.FORBIDDEN,
        error: "denied",
        message: BLOCKED_MESSAGE,
      };
    }

    // A revoked device still presents its owner's account DID and still passes `verifyOp`, because
    // the device authorization is signed by the account root and stays cryptographically valid
    // forever; revocation is the separate, online, eventually-consistent check (beacon.core
    // `doc/spec/identity.md` §2.1). So nothing else on this path turns a revoked device away, and
    // every path has to ask.
    //
    // Asked per request and never memoized under the nonce, so a device un-revoked by a later
    // published profile is admitted again on its next attempt rather than staying refused.
    //
    // Its own code, not the block's `denied`: the two want different things from the player, and
    // the block check above runs first, so a blocked actor still learns nothing about their
    // devices.
    if (this.revocations.isRevoked(req.actor, req.env.device)) {
      return {
        ok: false,
        status: HttpStatus.FORBIDDEN,
        error: "deviceRevoked",
        message: "device revoked",
      };
    }

    return { ok: true, actor: req.actor, env: req.env };
  }

  /** The HTTP form, for the signed **routes** — {@link check}, with a refusal thrown as its status. */
  verify(body: unknown, op: string | readonly string[]): { actor: DidKey; env: OpEnvelope } {
    const req = this.check(body, op);
    if (!req.ok) {
      const { status: _status, ...body } = req;
      throw new HttpException(body, req.status);
    }
    return { actor: req.actor, env: req.env };
  }

  /**
   * {@link verify} for a game **write**: it also refuses a non-member with `403 notMember` on a
   * server whose `accessLevel` is `request` or `private` ({@link MemberList}). Reads, a profile
   * publish and the admin surface call {@link verify}, since membership gates writes only.
   *
   * Membership belongs to the actor alone, like the two consults above, so it runs right after them
   * and before the call site's game gate and budget: a non-member is not billed.
   */
  verifyWrite(body: unknown, op: string | readonly string[]): { actor: DidKey; env: OpEnvelope } {
    const verified = this.verify(body, op);
    this.members.assertMember(verified.actor);
    return verified;
  }
}
