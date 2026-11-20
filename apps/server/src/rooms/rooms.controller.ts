import { verifyRoomProvenance, verifyItemProvenance } from "@beaconsgg/identity";
import {
  assertValidPolicyRules,
  DerivedRangeError,
  grantRulesOf,
  PlaceConflictError,
} from "@beaconsgg/policy-engine";
import { opEnvelopeSchema } from "@beaconsgg/protocol-types";
import {
  Body,
  Controller,
  Get,
  HttpException,
  HttpStatus,
  Logger,
  Param,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import { badRequest, parseParams, rateLimited } from "../common/capability-http";
import { DidBudgets } from "../common/did-budgets";
import { gamesQueryParam } from "../common/query";
import { GameGate } from "../common/game-gate";
import { SignedRequestGate } from "../common/signed-request-gate";
import { opsOf, SIGNED_ROUTES } from "../common/signed-routes";
import { WriteRateLimitGuard } from "../common/rate-limit.guard";
import { PlayerReadRateLimitGuard } from "../common/read-rate-limit.guard";
import { statusForError } from "./http-status";
import { RoomsService } from "./rooms.service";

/** The op names `POST /rooms/:id/ops` takes: the engine's handlers, from the route table. */
const ROOM_OP_NAMES: ReadonlySet<string> = new Set(opsOf("rooms/:id/ops").map((op) => op.op));

/**
 * The rooms HTTP boundary (`doc/spec/room-operation.md` §2): `place` / `op` / `resolve`. It
 * verifies container/item provenance at the edge so the engine only ever sees authentic,
 * well-formed input, and maps would-be engine throws to clean 4xx (never a false 500). Logical op
 * rejections map to a status via {@link statusForError} while keeping the `{ok:false,error}` body
 * the client keys off.
 *
 * The two write routes verify in **different places**, and that is the asymmetry to hold onto:
 * `place` goes through `SignedRequestGate` here because it never reaches the engine as an op, while
 * `/ops` is verified and consulted inside `applyOp`. So this file holds a signed-request bracket for
 * one route and deliberately none for the other.
 */
@Controller()
export class RoomsController {
  private readonly logger = new Logger(RoomsController.name);

  constructor(
    private readonly rooms: RoomsService,
    private readonly signed: SignedRequestGate,
    private readonly games: GameGate,
    private readonly budgets: DidBudgets,
  ) {}

  /** Place a room: a signed `place` op -> mint `unique@host`, take custody (`doc/spec/room-operation.md` §9.1). */
  @Post("rooms")
  @UseGuards(WriteRateLimitGuard)
  async place(@Body() body: unknown) {
    // Parse, op name, verify, freshness, block, revocation: the bracket every signed request
    // shares. `place` hand-rolled four of the six and had **neither freshness nor revocation**,
    // which is how it ended up the one room write a revoked device could still make and the one
    // signed write with no replay window at all. Both gaps came from the same cause: this path
    // verifies its own signature and never reaches the engine as an op, so the engine's hooks — the
    // thing that covers every other room write — could not see it.
    //
    // **Freshness is new here**, and it is a behaviour change rather than an inherited one: it sits
    // ahead of `place()`'s two recovery branches, so a placement that committed and lost its reply
    // and is retried more than five minutes later answers 400 rather than re-reporting itself. No
    // client can construct that today — `placeContainer` signs and posts once, with no retry
    // wrapper and no offline queue — while without a window a captured `place` replays until the
    // device authorization expires, because the nonce log that would otherwise absorb it is pruned
    // at `BEACON_MAX_NONCES`.
    //
    // The block keeps the depth it had: the engine consults AFTER its replay check, so an op
    // applied before a block still recovers idempotently, while this one sits ahead of both
    // recovery branches, so a committed-then-blocked placement answers 403 rather than re-reporting
    // itself. A place is a custody transfer, and refusing it before N provenance verifies is worth
    // more than replaying one for someone the operator has just blocked; the recovery returns the
    // moment the block lifts, and the stranded room is what `admin.room.remove` is for
    // (`doc/spec/admin-api.md` §3, Moderation).
    const route = SIGNED_ROUTES.rooms;
    const { actor, env } = this.signed.verifyWrite(body, route.op);

    // Game admission: after the identity consults the bracket owns, and before the budget, so
    // a refused caller is not charged. The slug is inside the signed envelope, so it is as
    // established as the actor is — which is the rule that decides where both of these go.
    //
    // Not the engine's order, which asks the application BEFORE revocation. Deliberate, and argued
    // in `SignedRequestGate`: identity is settled at the boundary before any application question is
    // asked. The visible difference is a revoked device on an unadmitted game, which is told
    // "device revoked" here and `gameNotAdmitted` by the engine.
    this.games.assertAdmits(env.game);

    // Billed against the same player class the engine charges every room op. The rule both sites
    // follow is "charge at the first point where the actor is cryptographically established", which
    // is what produces the split: `place` verifies its signature here, ops verify inside
    // `applyOp`, and `place` is the one room write that never reaches the engine as an op. Landing
    // ahead of the provenance verifies below is a bonus this path happens to get, not the rule.
    // The engine's own charge deliberately sits after its nonce read and admission checks.
    //
    // It costs the same replay the block above costs, one step milder: sitting ahead of `place()`
    // means a placement that committed and lost its reply is billed again on retry, where a
    // replayed op is billed nothing. Accepted, because a place retry is human-paced and 120 a
    // minute is a lot of headroom for one.
    if (!this.budgets.allowPlayerWrite(actor, "place")) {
      rateLimited("too many writes for this account");
    }

    const params = parseParams(route.params, env.params);

    // Pre-validate every JSONLogic rule the policy carries (`derived` AND `unlockTransform`) at the
    // boundary. The engine's place() throws on an invalid rule; validating here turns that into a clean
    // 400, so any throw from place() below is a genuine infrastructure error — surfaced as a logged 500,
    // not a client mistake misreported as a permanent, non-retryable 400.
    try {
      assertValidPolicyRules(params.policy);
    } catch (err) {
      badRequest(`invalid policy rule: ${err instanceof Error ? err.message : String(err)}`);
    }

    // Pre-validate the container's provenance at the boundary: the room's `unique` is the container id,
    // so its `mintedBy` (signed at grant over {unique, kind, policy}) must verify against those same
    // fields. Clean 400 here; the engine's buildRoom enforces it too (throws).
    if (
      !verifyRoomProvenance(
        { unique: params.unique, kind: params.type, policy: params.policy },
        params.mintedBy,
      )
    ) {
      badRequest(
        "placement provenance (mintedBy) is missing or does not match the container identity {unique, kind, policy}",
      );
    }

    // The minter is NOT required to be the placing actor: a minter may be a spawn pool / server /
    // another player (beacon.core `doc/spec/identity.md` §4.3), and `placedBy` is mutable/trusted,
    // decoupled from the fixed provenance. The signature above is what a peer/block-list keys on
    // (beacon.core `doc/spec/identity.md` §9); who placed it is the op's concern, not the
    // provenance's.

    // Pre-validate seeded contents' + reward-pool provenance at the boundary (like the derived
    // rules above): a `place` may not smuggle unsigned/forged resources into the room (beacon.core
    // `doc/spec/identity.md` §5.1). These are opaque signed items (`doc/spec/room-operation.md`
    // §9.1), verified generically over {unique, ...birth}. The engine's buildRoom enforces this too
    // (throws), so an off-HTTP path can't smuggle one in either; pre-checking here just turns that
    // throw into a clean 400 instead of a logged 500.
    for (const item of params.initialContents ?? []) {
      if (!verifyItemProvenance({ unique: item.unique, birth: item.birth }, item.mintedBy)) {
        badRequest("initialContents include an item with missing or invalid provenance");
      }
    }
    for (const reward of params.initialRewards ?? []) {
      if (!verifyItemProvenance({ unique: reward.unique, birth: reward.birth }, reward.mintedBy)) {
        badRequest("initialRewards include an item with missing or invalid provenance");
      }
    }
    // Named pools: same provenance gate per item, plus one wire rule — a pool no grant rule draws
    // from is a client bug, rejected rather than silently dropped. (Reserved state keys need no
    // check here: a grant rule may not name one — a policy invariant `assertValidPolicyRules`
    // enforced above — so a reserved pool key always fails this membership test.)
    const grantFroms = grantRulesOf(params.policy).map((r) => r.from);
    for (const [key, items] of Object.entries(params.initialPools ?? {})) {
      if (!grantFroms.includes(key)) {
        badRequest(`initialPools key "${key}" is not a grant pool of this policy`);
      }
      for (const item of items) {
        if (!verifyItemProvenance({ unique: item.unique, birth: item.birth }, item.mintedBy)) {
          badRequest("initialPools include an item with missing or invalid provenance");
        }
      }
    }

    try {
      const placed = await this.rooms.place(actor, params, env.nonce, env.game);
      return { ok: true, id: placed.id, version: placed.version, room: placed.room };
    } catch (err) {
      // A different actor already holds this id (client-supplied `unique` collision) — a clean 409, not
      // a retryable 500. (The same-actor retry is idempotent inside place(), so it never reaches here.)
      if (err instanceof PlaceConflictError) {
        throw new HttpException(
          { ok: false, error: "conflict", message: err.message },
          HttpStatus.CONFLICT,
        );
      }
      // The initial derived state is out of range (an untrusted seeded numeric overflowed, or a phase
      // transition lands past the transition horizon): a clean 400 carrying the reason, not a 500.
      if (err instanceof DerivedRangeError) {
        badRequest(err.message);
      }
      // Rules were pre-validated, so a throw here is infrastructure (store/pool). Surface it as a 500
      // (Nest's default filter — no stack in the body) and log the cause, rather than a false 400.
      this.logger.error(
        "place failed after validation (infrastructure error)",
        err instanceof Error ? err.stack : String(err),
      );
      throw err;
    }
  }

  /** Apply a signed op to a room (`doc/spec/room-operation.md` §3). */
  @Post("rooms/:id/ops")
  @UseGuards(WriteRateLimitGuard)
  async op(@Param("id") id: string, @Body() body: unknown) {
    // The envelope is strict too, so a newer client's extra TOP-LEVEL key is named the same way.
    // Its `params` are a `z.record(z.unknown())` here, so this says nothing about those.
    const env = parseParams(opEnvelopeSchema, body);
    if (env.room !== id) badRequest("envelope room does not match the URL");
    // An op this route does not take is the request's fault, as on every other signed route: 400
    // `invalid` at the door, not the engine's 403 `denied`, which is for an op the room refuses.
    if (!ROOM_OP_NAMES.has(env.op)) {
      badRequest(`expected a room op, not "${env.op}"`);
    }

    // No per-op params check here, deliberately. `place` above parses `placeParamsSchema` because it
    // NEEDS the parsed value (provenance, grant pools, rule pre-validation); `op` would only be
    // re-spelling authority the handler already holds. It would not buy load either: an attacker
    // spams well-shaped params with a junk signature and pays for the verifies regardless, so the
    // only traffic a door check turns away is a client with its own bug, which the engine rejects
    // as the same `invalid` and the same 400, and records under the nonce like every other op.
    const applied = await this.rooms.applyOp(env);
    if (!applied.result.ok) {
      // Surface logical rejections with a meaningful status; body keeps {ok:false,error}.
      throw new HttpException(applied.result, statusForError(applied.result.error));
    }
    return applied.result;
  }

  /** Resolve a room by its `unique@host` id (the texted-Jar / share-by-ID case). */
  @Get("rooms/:id")
  @UseGuards(PlayerReadRateLimitGuard)
  async resolve(@Param("id") id: string, @Query("games") games?: string | string[]) {
    // Filtered like discovery: a room none of the listed games owns or may act on reads as unknown.
    const room = await this.rooms.resolve(id, gamesQueryParam(games));
    if (!room) {
      throw new HttpException({ ok: false, error: "unknownRoom" }, HttpStatus.NOT_FOUND);
    }
    return room;
  }
}
