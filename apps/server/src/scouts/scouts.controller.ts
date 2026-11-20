import { verifyScoutProvenance } from "@beaconsgg/identity";
import { Body, Controller, HttpException, HttpStatus, Post, UseGuards } from "@nestjs/common";
import { badRequest, parseParams, rateLimited } from "../common/capability-http";
import { DidBudgets } from "../common/did-budgets";
import { GameGate } from "../common/game-gate";
import { SignedRequestGate } from "../common/signed-request-gate";
import { SIGNED_ROUTES } from "../common/signed-routes";
import { WriteRateLimitGuard } from "../common/rate-limit.guard";
import { ScoutsService } from "./scouts.service";

/**
 * The two ops this one entry serves — a scout's publish/heartbeat and its takedown, which are the
 * same conversation with the same owner. Passing both to the bracket is why it takes a set of
 * acceptable ops rather than one.
 */
const [REPORT, CANCEL] = SIGNED_ROUTES.scouts;
const SCOUT_OPS = [REPORT.op, CANCEL.op];

/**
 * The `POST /scouts` relay endpoint (`doc/spec/room-operation.md` §9.5): the shared
 * `SignedRequestGate` (parse, verify, `issuedAt` freshness against the authoritative server clock,
 * the sender blocklist, device revocation), then the two consults that stay per-surface — game
 * admission and the relay budget class — then scout provenance, before handing off to {@link
 * ScoutsService}. This path bypasses the engine, so it has to ask for what the engine would have
 * asked.
 */
@Controller()
export class ScoutsController {
  constructor(
    private readonly scouts: ScoutsService,
    private readonly signed: SignedRequestGate,
    private readonly games: GameGate,
    private readonly budgets: DidBudgets,
  ) {}

  /** Relay path (`doc/spec/room-operation.md` §9.5): a signed `report` (publish/heartbeat) or `cancel`. */
  @Post("scouts")
  @UseGuards(WriteRateLimitGuard)
  scout(@Body() body: unknown) {
    // The bracket: parse, op name, verify, freshness, block, revocation. Five of those were spelled
    // out here — freshness under a private `SCOUT_REPLAY_WINDOW_MS` holding the same five minutes
    // as the shared constant, revocation as a hand-built `HttpException`. One rule, three
    // spellings; this keeps the rule and drops two of the spellings.
    //
    // Two orderings change, and both move TOWARDS the engine rather than away. The **op name** was
    // checked last, as a fallthrough after both branches, so a `place` envelope posted here was
    // verified, put through four consults and billed before anything looked at its name; it is now
    // the first thing refused. And **freshness** sat after the budget charge, so a captured report
    // replayed past the window still spent the owner's relay budget on its way to a 400.
    const { actor: owner, env } = this.signed.verifyWrite(body, SCOUT_OPS);

    // Game admission, then the budget: the two the bracket deliberately does not hold. An
    // unadmitted game is not billed.
    //
    // The pair runs in the engine's order; the full chain no longer does. Routing through the
    // bracket moved revocation ahead of this consult, so a revoked device reporting from an
    // unadmitted game used to be told `gameNotAdmitted` here and is now told "device revoked".
    // Decided rather than inherited — see `SignedRequestGate` — and the one refusal on this path
    // whose wire answer changed.
    //
    // Every refusal on this path denies `cancel` as well as `report`, which is the one place they
    // preserve the refused caller's footprint rather than stopping it: they can no longer take
    // their own scout down, so it stays advertised until the relay TTL expires it (capped at an
    // hour). Consistent with leaving already-placed content alone, and self-limiting, but a
    // consequence rather than an oversight.
    this.games.assertAdmits(env.game);
    // The relay carries its own budget class, not the player one: a heartbeat is background traffic
    // whose rate follows how many scouts are deployed, and pooling it with player writes is what
    // makes an unrelated jar take fail when a relay loop runs away.
    //
    // It is charged LAST, after every structural refusal, exactly as the engine orders its four
    // (`isDenied` → `isAppDenied` → `isDeviceRevoked` → `isRateLimited`). That ordering is
    // load-bearing rather than tidy: a revoked device still presents its **owner's** account DID
    // and still passes `verifyOp`, because the device authorization is signed by the account root
    // and revocation is a separate registry consult. Charging before that check would let a stolen
    // phone spend the owner's relay budget with every report it makes, so revoking it would stop
    // the reports and still let the thief starve the owner's good phone of its own. The bracket
    // above keeps that property: it holds both identity consults, so both still precede this.
    if (!this.budgets.allowRelayWrite(owner)) {
      rateLimited("too many scout reports for this account");
    }

    // The server clock is authoritative for the report stamp below, and it is the same clock the
    // bracket just checked `issuedAt` against.
    const now = Date.now();

    if (env.op === REPORT.op) {
      const params = parseParams(REPORT.params, env.params);
      // Provenance (identity axis — VERIFIED): the scout's `mintedBy` must be a valid signature
      // over its birth set {unique, config}, so a peer/registry can trust it offline and a future
      // block-list can key on the minter (beacon.core `doc/spec/identity.md` §9). The minter is
      // deliberately NOT required to be the reporting owner — a minter may be a spawn pool, a
      // server, or another player (beacon.core `doc/spec/identity.md` §4.3); `owner` is
      // mutable/trusted and decoupled from the fixed provenance.
      if (
        !verifyScoutProvenance({ unique: params.unique, config: params.config }, params.mintedBy)
      ) {
        badRequest("scout provenance (mintedBy) is missing or does not match {unique, config}");
      }
      // Stamp reportedAt with the server clock — never trust the client's, so a future-pinned
      // value can't freeze a scout's position un-overwritably (the "keep freshest" guard). The
      // signed `issuedAt` goes along so the relay can read the lifetime the client asked for off
      // the client's own clock and run it on this one.
      const result = this.scouts.report(
        owner,
        params,
        { reportedAt: new Date(now).toISOString(), issuedAt: env.issuedAt },
        env.game,
      );
      if (!result.ok) {
        const status = result.error === "denied" ? HttpStatus.FORBIDDEN : HttpStatus.BAD_REQUEST;
        throw new HttpException({ ok: false, error: result.error }, status);
      }
      return { ok: true, id: params.unique };
    }

    if (env.op === CANCEL.op) {
      const params = parseParams(CANCEL.params, env.params);
      const result = this.scouts.cancel(owner, params.unique);
      if (!result.ok) {
        throw new HttpException({ ok: false, error: result.error }, HttpStatus.FORBIDDEN);
      }
      return { ok: true };
    }

    // Unreachable: the bracket already refused anything outside `SCOUT_OPS`, with this exact
    // message. Kept as the drift guard — adding a third op to `SCOUT_OPS` without a branch here
    // lands on a 400 rather than an implicit `undefined` body.
    badRequest(`expected op ${SCOUT_OPS.map((name) => `"${name}"`).join(" or ")}`);
  }
}
