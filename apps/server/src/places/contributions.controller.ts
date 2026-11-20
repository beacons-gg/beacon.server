import { type DidKey, type OpEnvelope } from "@beaconsgg/protocol-types";
import { Body, Controller, Post, UseGuards } from "@nestjs/common";
import { GameGate } from "../common/game-gate";
import { SignedRequestGate } from "../common/signed-request-gate";
import {
  badRequest,
  conflict,
  missing,
  notFound,
  parseParams,
  rateLimited,
  signedReadParams,
} from "../common/capability-http";
import { NonceService } from "../common/nonce.service";
import { SIGNED_ROUTES } from "../common/signed-routes";
import { WriteRateLimitGuard } from "../common/rate-limit.guard";
import { SignedReadRateLimitGuard } from "../common/read-rate-limit.guard";
import type { PlaceProposalRecord } from "../stores/place-store";
import { ContributionsService, ProposeError, type ProposeRejection } from "./contributions.service";

/**
 * The **player-facing** half of place contributions (the place proposals spec,
 * `doc/spec/place-proposals.md` §5), the one places surface that isn't an operator route and isn't
 * a public read. Both endpoints are signed requests (an `OpEnvelope` with a `places.*` op), exactly
 * like mailbox: `verifyOp` establishes the actor cryptographically, so a submission is attributed,
 * rate-limitable, and blocklist-gated, and a fetch is scoped to the verified reader.
 *
 * Nothing here publishes anything. A submission is a `pending` row an operator must approve; the
 * dataset is untouched until then.
 *
 * 404s when `BEACON_PLACES` is off **or** `BEACON_PLACES_PROPOSALS` is off; an operator may
 * well want a curated dataset without accepting submissions.
 */
@Controller()
export class ContributionsController {
  constructor(
    private readonly contributions: ContributionsService,
    private readonly gate: SignedRequestGate,
    private readonly games: GameGate,
    private readonly nonce: NonceService,
  ) {}

  /** Propose a new place, or descriptor fields for one that exists. Idempotent by envelope nonce. */
  @Post("places/propose")
  @UseGuards(WriteRateLimitGuard)
  async propose(@Body() body: unknown): Promise<{ ok: true; proposal: PlaceProposalRecord }> {
    const route = SIGNED_ROUTES["places/propose"];
    const signed = this.verifyGameWrite(body, route.op);
    const params = parseParams(route.params, signed.env.params);

    const { id } = await this.nonce.idempotentResult(signed, async () => {
      try {
        return { id: (await this.contributions.propose(params, signed.actor)).id };
      } catch (err) {
        if (err instanceof ProposeError) rejectProposal(err.rejection);
        throw err;
      }
    });
    const proposal = await this.contributions.getProposal(id);
    if (!proposal) missing("unknownProposal", "proposal missing"); // durable row — safety only
    return { ok: true, proposal };
  }

  /**
   * Signed read: **only the verified actor's own** submissions and their outcomes. There is
   * deliberately no way to read someone else's — a contribution is attributable to a DID and a
   * point in the world, so an open listing would be a location-disclosure surface.
   */
  @Post("places/proposals/fetch")
  @UseGuards(SignedReadRateLimitGuard)
  async fetch(@Body() body: unknown): Promise<{ ok: true; proposals: PlaceProposalRecord[] }> {
    const route = SIGNED_ROUTES["places/proposals/fetch"];
    const signed = this.verify(body, route.op);
    const params = await signedReadParams(this.nonce, signed, route.params);
    return { ok: true, proposals: await this.contributions.list(params, signed.actor) };
  }

  /** Capability gate: 404 when off, else the shared signed-request gate (verify → fresh → not blocked → device not revoked). */
  private verify(body: unknown, op: string): { actor: DidKey; env: OpEnvelope } {
    this.assertEnabled();
    return this.gate.verify(body, op);
  }

  private assertEnabled(): void {
    if (!this.contributions.enabled) notFound("place contributions not enabled");
  }

  /**
   * {@link verify} plus membership and the game gate — the bracket for the **write**. A submission is a
   * durable row in the OPERATOR's curated dataset and one more item in their review queue, so it is
   * game content by the gate's rule even though it arrives through the shared bracket the way
   * mailbox and media do. Consulted after the block and before the service's per-DID budget and
   * pending cap, so a refused application is charged nothing.
   *
   * Its own method rather than a line inside {@link verify}, so the signed **read** beside it keeps
   * the plain bracket by construction rather than by comment: an app gate guards writes only, and
   * refusing a fetch would hide a player's own pending contributions from them without taking one
   * row off the queue.
   */
  private verifyGameWrite(body: unknown, op: string): { actor: DidKey; env: OpEnvelope } {
    this.assertEnabled();
    const verified = this.gate.verifyWrite(body, op);
    this.games.assertAdmits(verified.env.game);
    return verified;
  }
}

/**
 * A domain rejection as its HTTP answer: bad input → 400 (with a code naming *which* input), an
 * exhausted budget → 429, a full review queue → 409. The switch is exhaustive, so a sixth rejection
 * reason can't ship unmapped. The operator's review route uses it too, for an approval whose place
 * has retired.
 */
export function rejectProposal(rejection: ProposeRejection): never {
  switch (rejection.reason) {
    case "invalidPair":
      return badRequest(
        "`subcategory` is not a curated slug of that `category` (see GET /places/taxonomy)",
        rejection.reason,
      );
    case "unknownPlace":
      return badRequest("no active place with that `unique`", rejection.reason);
    case "unknownMedia":
      return badRequest(
        `media ${rejection.hash} is not stored here — upload it to this server first`,
        rejection.reason,
      );
    case "rateLimited":
      return rateLimited("too many submissions");
    case "tooManyPending":
      // 409, not 429: a state refusal that waiting does not clear (an operator's review does), so a
      // client that retries every 429 must not read it as one.
      return conflict(
        `you already have ${rejection.max} submissions awaiting review`,
        rejection.reason,
      );
  }
}
