import { verifyRoomProvenance, verifyItemProvenance, verifyOp } from "@beaconsgg/identity";
import { gameMayApply, opaqueItemSchema, parseGlobalId } from "@beaconsgg/protocol-types";
import { assertValidPolicyRules } from "./policy-rules";
import type {
  DidKey,
  ErrorCode,
  ErrorResult,
  GlobalId,
  LatLng,
  Media,
  MintedBy,
  OpaqueItem,
  OpEnvelope,
  OpResult,
  Policy,
  Room,
  RoomChange,
} from "@beaconsgg/protocol-types";
import { HANDLERS, LEDGER_ONLY_OPS, READ_ONLY_OPS } from "./handlers";
import {
  applyGrant,
  derivedSnapshot,
  effectivePhase,
  grantRulesOf,
  lifecycleRoomShouldClose,
  nowSeconds,
  recomputeDerived,
  roomFullyClaimed,
  horizonMessage,
  transitionPastHorizon,
} from "./lifecycle";
import { currentPhase, roleAllows } from "./roles";
import type { Mutation, Store } from "./store";

export interface PlaceRoomInput {
  id: GlobalId;
  type: string;
  location: LatLng;
  policy: Policy;
  placedBy: DidKey;
  /** The placing game's slug, from the `place` envelope: the room's `game` for good. */
  game: string;
  /** The container's signed provenance — verified at build against the room identity `{unique, kind}`. */
  mintedBy: MintedBy;
  /** The placer's custom display name for the container (display only; frozen once placed). */
  name?: string;
  /** Content-addressed preview media header → becomes the room's `media` (`doc/spec/mailbox-and-media.md` §5). */
  media?: Media[];
  /** Initial state; defaults to an empty container `{ contents: [] }`. May seed a `grant.from` reward pool. */
  state?: Record<string, unknown>;
  live?: string;
}

/** The full outcome of applying an op: client result + deltas to broadcast + new room state. */
export interface AppliedOp {
  result: OpResult;
  /** Live-channel deltas to broadcast (empty on rejection or idempotent replay). */
  changes: RoomChange[];
  /** The new room state (undefined if the room closed or the op was rejected). */
  room?: Room | undefined;
  closed: boolean;
  /** True when this was an idempotent nonce replay (do not re-broadcast). */
  replayed: boolean;
}

/** The outcome of a placement. Idempotent by `nonce` AND by the room id (a re-place by the same placer). */
export interface PlacedRoom {
  id: GlobalId;
  version: number;
  room?: Room | undefined;
  replayed: boolean;
}

/**
 * A placement collided with an existing room at the same id (the client-supplied `unique@host`), placed
 * by a **different** actor. Distinct from the same-actor retry, which is idempotent (returns the room).
 * The controller maps this to a clean 409, not the infrastructure-500 path — it's a client conflict, not
 * a server fault, and must not drive a retry loop.
 */
export class PlaceConflictError extends Error {
  constructor(readonly id: GlobalId) {
    super(`place: a different actor already placed a room at ${id}`);
    this.name = "PlaceConflictError";
  }
}

/**
 * A placement's initial derived state is out of range: an untrusted seeded `match.levels` pushed a
 * derived aggregate past MAX_SAFE_INTEGER, or a phase transition lands past the transition horizon
 * (`TRANSITION_HORIZON_SEC`). The controller maps this to a clean 400 carrying the message, not a
 * 500: like the applyOp overflow guard, an untrusted numeric input is a client error, never an
 * infrastructure fault.
 */
export class DerivedRangeError extends Error {
  constructor(message = "initial derived recompute out of range") {
    super(message);
    this.name = "DerivedRangeError";
  }
}

/** The result of a lifecycle tick on one room. */
export interface PhaseAdvance {
  room?: Room | undefined;
  /** The deltas in this advance (without versions; convenience for callers/tests). */
  changes: RoomChange[];
  /**
   * The same deltas paired with the **monotonic version** to broadcast each at: one increment per
   * phase transition (a multi-phase jump emits distinct versions), and on close the room's last
   * version (delete doesn't bump). A client ordering by version won't drop/merge them.
   */
  broadcasts: { version: number; change: RoomChange }[];
  closed: boolean;
}

export interface PolicyEngineOptions {
  /** Clock used for the `issuedAt` replay window. Defaults to `Date.now`. */
  now?: () => number;
  /** Accepted `issuedAt` skew (ms) in either direction. Defaults to 5 minutes. */
  replayWindowMs?: number;
  /**
   * Best-effort **admission** consult: given the **verified** actor, return true to refuse the op
   * as `denied`. The engine never learns what a blacklist is or who keeps one, which is also why
   * it rejects in its own words (`actor not admitted`) rather than the injector's: a server backs
   * this with an operator ban today, and nothing here should have to change if it backs it with
   * something else tomorrow. It asks exactly where it already asks about revocation, so a ban
   * reaches the room path without the HTTP boundary verifying the envelope twice.
   *
   * Consulted before revocation, so a banned actor is refused without a device lookup and without
   * charging a budget, and deliberately NOT recorded under the nonce, so a lifted ban takes effect
   * on the next attempt. Default: nobody is denied.
   */
  isDenied?: (actor: DidKey) => boolean;
  /**
   * Best-effort **membership** consult: given the **verified** actor of an op that changes a room,
   * return true to refuse it as `notMember`. A server backs it with its member list, which it
   * consults only when its `accessLevel` is `request` or `private`. A read-only op (`list`) is
   * never asked about, because membership gates writes and never reads.
   *
   * Consulted right after {@link isDenied}, before any budget is charged, and NOT recorded under
   * the nonce, so an op refused before the player was admitted succeeds on retry with the same
   * nonce. Default: everyone is a member.
   */
  isNotMember?: (actor: DidKey) => boolean;
  /**
   * Best-effort **game** admission consult: given the op's `game` slug (or `undefined` when it
   * names none), return true to refuse the op as `gameNotAdmitted`. The server's verdict on which
   * games it takes, and on a write that names none (`doc/spec/room-operation.md` §5).
   *
   * A sibling of {@link isDenied} rather than a widening of it, for two reasons. `isDenied` asks
   * "given a verified principal, may it act", and a game is not a principal — folding them would
   * mean handing that predicate the whole envelope. And keeping them separate keeps the two refusals
   * separately testable and separately loggable, which is exactly what an operator needs when
   * working out whether it is their game list or their ban list that is misconfigured.
   *
   * The engine is told nothing about what a game is: an opaque string in, a boolean out. Whether the
   * ROOM takes the op's game is the engine's own question, asked at step 6 (`gameNotAccepted`).
   *
   * Consulted after {@link isDenied} and before any budget is charged, so a banned actor is still
   * refused first and neither an unadmitted game nor a banned actor pays. Placed after replay and
   * deliberately NOT recorded under the nonce, so an op refused before an operator added its slug
   * succeeds on retry with the same nonce. Default: every game is admitted.
   *
   * It also currently runs **before** revocation, which is the engine's own order and no longer the
   * server's: every boundary path settles both identity consults first, because they share one
   * transport bracket and the app gate cannot live in it. Nothing here asserts app-before-revocation
   * and no argument requires it, so this is the side expected to move; until it does, a revoked
   * device on an unadmitted game is told `gameNotAdmitted` by the engine and `deviceRevoked`
   * everywhere else.
   */
  isAppDenied?: (app: string | undefined) => boolean;
  /**
   * Best-effort device-revocation consult (beacon.core `doc/spec/identity.md` §5.2). Given a
   * verified `(account, device)` pair, return true if that device key is currently revoked; the op
   * is then denied. The check is online + best-effort — the default (no consult) allows everything,
   * matching radical trust until a revocation source is wired in (the server backs it with a
   * published, rollback-resistant profile registry).
   */
  isDeviceRevoked?: (account: DidKey, device: DidKey) => boolean;
  /**
   * Best-effort abuse consult, the same shape as {@link isDeviceRevoked}: given the **verified**
   * actor and the op they are applying, return true to refuse it as `rateLimited`. The engine
   * never learns what a budget is or who keeps one — it asks, exactly where it already asks about
   * revocation, so a server can bound a tap-frequency op (`react`) without a second signature
   * verify at its own boundary. Consulted per attempt and deliberately NOT recorded under the
   * nonce, so a retry after the window succeeds. Default: nothing is limited.
   */
  isRateLimited?: (actor: DidKey, op: string) => boolean;
}

/**
 * The generic op/policy engine (`doc/spec/room-operation.md` §5). It knows nothing about "Jar" or
 * "Capsule"; it interprets the declarative policy carried on each room.
 *
 * Each public method is a **unit of work**: it `await`s its reads up front, computes the outcome
 * purely, then lands every write in a single atomic {@link Store.commit}. Because the Store is
 * async there are real await points between read and commit, so the server MUST hold the per-room
 * lock across the whole call — that lock is what keeps two ops on the same room from interleaving
 * (`doc/spec/room-operation.md` §6). The single commit also makes an op crash-atomic: the room
 * mutation and its nonce record land together, so a retry can't double-apply a half-written op.
 */
export class PolicyEngine {
  private readonly now: () => number;
  private readonly replayWindowMs: number;
  private readonly isDenied: (actor: DidKey) => boolean;
  private readonly isNotMember: (actor: DidKey) => boolean;
  private readonly isAppDenied: (app: string | undefined) => boolean;
  private readonly isDeviceRevoked: (account: DidKey, device: DidKey) => boolean;
  private readonly isRateLimited: (actor: DidKey, op: string) => boolean;
  /** Recently-closed room ids, so a racing op gets `expired` (not `unknownRoom`). */
  private readonly tombstones = new Set<GlobalId>();
  /** When this engine started, which bounds how long it reads a build's unscoped nonce keys. */
  private readonly startedAt: number;
  private readonly maxTombstones = 1024;

  constructor(
    private readonly store: Store,
    options: PolicyEngineOptions = {},
  ) {
    this.now = options.now ?? (() => Date.now());
    this.replayWindowMs = options.replayWindowMs ?? 5 * 60_000;
    this.isDenied = options.isDenied ?? (() => false);
    this.isNotMember = options.isNotMember ?? (() => false);
    this.isAppDenied = options.isAppDenied ?? (() => false);
    this.isDeviceRevoked = options.isDeviceRevoked ?? (() => false);
    this.isRateLimited = options.isRateLimited ?? (() => false);
    this.startedAt = this.now();
  }

  /**
   * Build the initial room from a placement — **pure** (validation + initial derived state, no
   * store access), so `placeRoom` and `place` can each commit their own atomic batch. Throws on any
   * invalid policy rule (`assertValidPolicyRules`) or an out-of-range initial derived value.
   */
  private buildRoom(input: PlaceRoomInput): Room {
    assertValidPolicyRules(input.policy);

    // The container's provenance must verify against the room's identity {unique, kind, policy}
    // (beacon.core `doc/spec/identity.md` §5.1) — signed at grant over its id (= unique) + kind (=
    // type) + policy (frozen), so it re-verifies here and from any discovered room. Required;
    // throws like an invalid derived rule (the controller pre-validates for a clean 400, so this
    // fires only off the HTTP path).
    if (
      !verifyRoomProvenance(
        { unique: parseGlobalId(input.id).unique, kind: input.type, policy: input.policy },
        input.mintedBy,
      )
    ) {
      throw new Error(
        "placement provenance (mintedBy) is missing or does not match the room identity {unique, kind, policy}",
      );
    }

    // The minter is deliberately decoupled from the placer (beacon.core `doc/spec/identity.md`
    // §4.3): a minter may be a spawn pool / server / another player, and `placedBy` is
    // mutable/trusted. We verify the provenance *signature* (above) so a peer/block-list can key on
    // the minter (identity §9); we do NOT require minter === placer. The signed scope already
    // covers `policy`, so a placer can't wrap a foreign `mintedBy` in a different policy — the
    // signature wouldn't verify.

    let state = cloneInitialState(input.state);
    // Every item entering shared state (seeded contents + a reward pool) gets the same
    // VERIFIED-axis gate as add/contribute (beacon.core `doc/spec/identity.md` §5.1), verified
    // generically over the opaque item (`doc/spec/room-operation.md` §9.1), otherwise a `place`
    // could smuggle unsigned/forged items into circulation (they'd leak out via take/claim/grant).
    // Throws like an invalid derived rule; the controller pre-validates for a clean 400, so this
    // fires only off the HTTP path. Key the reward gate off the pool the policy will actually grant
    // from (NOT a literal), so a policy whose `grant.from` names some other, unsigned pool can't
    // slip past.
    assertSeededItems(
      state["contents"],
      "placement contents include an item with missing or invalid provenance",
    );
    for (const rule of grantRulesOf(input.policy)) {
      assertSeededItems(
        state[rule.from],
        "placement rewards include an item with missing or invalid provenance",
      );
    }
    if (input.policy.lifecycle) {
      // Start in the first phase; stamp placedAt (epoch seconds) so the derived timers resolve.
      const initialPhase = input.policy.lifecycle.phases[0] ?? "";
      const placedAt =
        typeof state["placedAt"] === "number" ? state["placedAt"] : nowSeconds(this.now());
      state = { ...state, phase: initialPhase, placedAt };
      // A placement may seed the placer's OWN contribution — an `initialContents` item they own (a
      // scanner-found capsule seeds the finder's contribution at place). Register each owned seeded item in
      // the contributors ledger (the same `did -> uniques` structure a `contribute` op writes), so it's
      // claimable and the room isn't treated as empty (lifecycle.ts). Un-owned seeded contents register
      // nobody; provenance was already verified above.
      const seededContributors = contributorsFromSeed(state["contents"]);
      if (Object.keys(seededContributors).length > 0) {
        state = { ...state, contributors: seededContributors };
      }
    }
    if (input.policy.derived) {
      // A place seeding contents whose (untrusted) match.levels overflow the derived math must be a
      // clean client rejection, not a 500 — mirror the applyOp overflow guard (untrusted numerics).
      try {
        state = recomputeDerived(input.policy, state); // initial lockAt/unlockAt before any contribution
      } catch {
        throw new DerivedRangeError();
      }
    }

    // A transition past the horizon is never, and a room waiting on never closes as stranded, so a
    // placement may not schedule one (a clean 400 naming the transition).
    const pastHorizon = transitionPastHorizon(input.policy, state);
    if (pastHorizon) throw new DerivedRangeError(horizonMessage(pastHorizon));

    return {
      id: input.id,
      type: input.type,
      version: 1,
      location: input.location,
      state,
      policy: input.policy,
      placedBy: input.placedBy,
      game: input.game,
      mintedBy: input.mintedBy,
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.media !== undefined ? { media: input.media } : {}),
      ...(input.live !== undefined ? { live: input.live } : {}),
    };
  }

  /**
   * Place (create) a room — takes custody (`doc/spec/room-operation.md` §9.1). Caller supplies the
   * id. Rejects if a room already exists at that id (the public API has no other dup protection).
   */
  async placeRoom(input: PlaceRoomInput): Promise<Room> {
    if (await this.store.getRoom(input.id)) {
      throw new Error(`placeRoom: a room already exists at ${input.id}`);
    }
    const room = this.buildRoom(input);
    await this.store.commit([{ kind: "putRoom", room }]);
    return room;
  }

  /**
   * Place a room idempotently (`doc/spec/room-operation.md` §6.2). The room id is the
   * client-supplied `unique@host`, **stable** across retries, so idempotency keys on it — not just
   * the per-call nonce:
   *   - a repeated nonce returns the recorded placement (the classic same-nonce retry), and
   *   - a room already at `input.id` placed by the **same** actor returns that room (a
   *     lost-response retry that minted a *fresh* nonce — without this it would collide and
   *     500-loop, bricking the container), while a **different** actor at that id is a real
   *     conflict (caught by the `placedBy` check below → `PlaceConflictError`; the minter/placer
   *     decoupling means `buildRoom` no longer gates on minter==placer, so this check is the sole
   *     guard).
   * The caller MUST hold the per-`id` lock across this call so two concurrent placements of the same id
   * can't both pass the existence check and clobber. The room write and nonce record commit
   * together, so a crash mid-place leaves neither.
   */
  async place(input: PlaceRoomInput, nonce: string): Promise<PlacedRoom> {
    const prior = await this.priorResult(this.placeKey(input.placedBy, nonce), `place:${nonce}`);
    if (prior?.ok) {
      const placedId = (prior.result as { placedId?: GlobalId } | undefined)?.placedId;
      if (placedId) {
        const room = await this.store.getRoom(placedId);
        return { id: placedId, version: room?.version ?? 1, room, replayed: true };
      }
    }
    const existing = await this.store.getRoom(input.id);
    if (existing) {
      // Same placer re-placing the same container: idempotent (replayed → no re-broadcast/reschedule),
      // so the client's post-place consume runs and the container isn't stranded. Anyone else: conflict.
      if (existing.placedBy === input.placedBy) {
        return { id: existing.id, version: existing.version, room: existing, replayed: true };
      }
      throw new PlaceConflictError(input.id);
    }
    const room = this.buildRoom(input);
    await this.store.commit([
      { kind: "putRoom", room },
      {
        kind: "putNonce",
        nonce: this.placeKey(input.placedBy, nonce),
        result: { ok: true, version: 1, result: { placedId: room.id } },
      },
    ]);
    return { id: room.id, version: room.version, room, replayed: false };
  }

  resolveRoom(id: GlobalId): Promise<Room | undefined> {
    return this.store.getRoom(id);
  }

  /**
   * Recovery query (§6.2): "what was the result of this actor's `op` under `nonce`?" A `place`
   * reads the place namespace and every other op the op namespace, which share a nonce store but
   * never each other's keys.
   */
  recoverResult(actor: DidKey, op: string, nonce: string): Promise<OpResult | undefined> {
    return this.store.getNonceResult(
      op === "place" ? this.placeKey(actor, nonce) : this.opKey(actor, op, nonce),
    );
  }

  /**
   * Nonce keys are namespaced by operation kind, and scoped to the actor and the op, so one
   * request's record can only ever answer that request's retry (`doc/spec/room-operation.md` §6.2).
   * Keyed on the nonce alone, a later op reusing another op's nonce was read as a replay and got
   * that op's result without executing, and one account could spend a nonce another had used. A
   * captured envelope still meets its own record, since the actor and the op are both signed.
   */
  private opKey(actor: DidKey, op: string, nonce: string): string {
    return JSON.stringify(["op", actor, op, nonce]);
  }
  private placeKey(actor: DidKey, nonce: string): string {
    return JSON.stringify(["place", actor, nonce]);
  }

  /**
   * The recorded result under `key`, or under `legacy`, the nonce-only key a build before the
   * scoping wrote (`op:<nonce>`, `place:<nonce>`). The fallback is read only for the first two
   * replay windows after this engine starts: an envelope older than one window is refused before
   * this lookup, so a record from the build before an upgrade can only matter to a retry that
   * spans the restart, and that retry must not apply twice.
   */
  private async priorResult(key: string, legacy: string): Promise<OpResult | undefined> {
    const prior = await this.store.getNonceResult(key);
    if (prior !== undefined || this.now() - this.startedAt >= 2 * this.replayWindowMs) return prior;
    return this.store.getNonceResult(legacy);
  }

  /**
   * Advance a lifecycle room's stored phase to the clock-effective phase — emitting
   * `phaseChanged` for each newly-entered phase — and close it when the tick close condition
   * is met (fully claimed / nothing left to grant anyone / empty / `claimTtl` past settlement).
   * Driven by the server's periodic tick; op-gating uses the clock directly, so this is purely for
   * broadcasting + the close. Entering the terminal phase stamps `settledAt` — see the note there.
   */
  async advancePhase(roomId: GlobalId, nowMs: number = this.now()): Promise<PhaseAdvance> {
    const room = await this.store.getRoom(roomId);
    if (!room?.policy.lifecycle) return { room, changes: [], broadcasts: [], closed: false };
    const nowSec = nowSeconds(nowMs);

    if (lifecycleRoomShouldClose(room, nowSec)) return this.closeRoom(room);

    const phases = room.policy.lifecycle.phases;
    const stored = currentPhase(room) ?? phases[0] ?? "";
    const target = effectivePhase(room, nowSec) ?? stored;
    if (target === stored) return { room, changes: [], broadcasts: [], closed: false };

    const from = phases.indexOf(stored);
    const to = phases.indexOf(target);
    const changes: RoomChange[] = [];
    const broadcasts: { version: number; change: RoomChange }[] = [];
    let version = room.version;
    for (let i = from + 1; i <= to; i++) {
      version += 1; // one monotonic version per phase entered
      const change: RoomChange = { type: "phaseChanged", phase: phases[i] as string };
      changes.push(change);
      broadcasts.push({ version, change });
    }

    // Stamp when the room ENTERS its terminal phase: that instant, not `unlockAt`, is when the
    // claim window starts (see `lifecycleRoomShouldClose` — a won challenge's `unlockAt` is in the past
    // by construction, so anchoring on it would sweep the escrow before anyone could collect).
    const settling = target === phases[phases.length - 1] && room.state["settledAt"] === undefined;
    const updated: Room = {
      ...room,
      state: { ...room.state, phase: target, ...(settling ? { settledAt: nowSec } : {}) },
      version,
    };
    await this.store.commit([{ kind: "putRoom", room: updated }]);
    return { room: updated, changes, broadcasts, closed: false };
  }

  /**
   * Custodian force-removal (admin moderation — `doc/spec/admin-api.md` §3): delete any room
   * outright through the same close mechanics a lifecycle close uses, so watchers can't tell the
   * difference and a racing op gets `expired`, not `unknownRoom`. Authorization is the caller's
   * concern (the server's admin gate) — the engine stays policy-agnostic and never asks *why*.
   * `closed: false` with no broadcasts means the room didn't exist (nothing to remove).
   */
  async removeRoom(roomId: GlobalId): Promise<PhaseAdvance> {
    const room = await this.store.getRoom(roomId);
    if (!room) return { room: undefined, changes: [], broadcasts: [], closed: false };
    return this.closeRoom(room);
  }

  /**
   * The one close path (shared by the lifecycle close and admin removal): atomic delete, then the
   * tombstone (so a racing op sees `expired`), then the `closed` broadcast — at the room's **last
   * seen version**, since a delete doesn't bump it.
   */
  private async closeRoom(room: Room): Promise<PhaseAdvance> {
    await this.store.commit([{ kind: "deleteRoom", id: room.id }]);
    this.tombstone(room.id);
    const change: RoomChange = { type: "closed" };
    return {
      room: undefined,
      changes: [change],
      broadcasts: [{ version: room.version, change }],
      closed: true,
    };
  }

  async applyOp(env: OpEnvelope): Promise<AppliedOp> {
    // 1. verify signature / attribution (offline; device-auth expiry uses the engine clock).
    const verification = verifyOp(env, this.now());
    if (!verification.ok) {
      // `malformed`: the envelope fails the schema or has no canonical form (a `1e400`, or nesting
      // too deep to walk). A request fault, not a bad signature.
      const code = verification.reason === "malformed" ? "invalid" : "badsig";
      return reject(code, `attribution failed: ${verification.reason}`);
    }
    const actor = verification.actor;

    // 2. freshness: reject ops whose issuedAt is outside the replay window, *before* trusting
    //    nonce-only dedup (a captured op must not replay forever).
    const issuedAt = Date.parse(env.issuedAt);
    if (Number.isNaN(issuedAt) || Math.abs(this.now() - issuedAt) > this.replayWindowMs) {
      return reject("clockSkew", "issuedAt outside the replay window"); // the boundary's code too
    }

    // 3. nonce replay -> return the prior result; do NOT re-apply or re-broadcast (§6.2).
    const key = this.opKey(actor, env.op, env.nonce);
    const prior = await this.priorResult(key, `op:${env.nonce}`);
    if (prior) {
      return {
        result: prior,
        changes: [],
        room: env.room ? await this.store.getRoom(env.room) : undefined,
        closed: false,
        replayed: true,
      };
    }

    // 3b. admission (best-effort, injected): an operator-banned actor is refused outright, before
    //     the device lookup and before any budget is charged. Placed after replay for the same
    //     reason as the two checks below, and not finalized under this nonce, so a lifted ban lets
    //     the same op through on its next attempt.
    if (this.isDenied(actor)) {
      return reject("denied", "actor not admitted");
    }

    // 3b-i. membership (best-effort, injected): a server that takes writes from members only refuses
    //     anyone else, on the same terms as the ban above. Reads are never gated.
    if (!READ_ONLY_OPS.has(env.op) && this.isNotMember(actor)) {
      return reject("notMember", "not a member");
    }

    // 3b-ii. game admission (best-effort, injected): an op from a game the operator does not take,
    //     or naming none, is refused here, on the same terms as the ban above — after replay and
    //     before any budget is charged. Separate from 3b because the two answer different
    //     questions about the same op: who is acting, and what they are acting through.
    //
    //     Sitting ahead of 3c is the engine's order alone; the boundary settles identity first.
    //     See `isAppDenied`.
    if (this.isAppDenied(env.game)) {
      return reject("gameNotAdmitted", "game not admitted");
    }

    // 3c. device revocation (best-effort, online): deny a NEW op from a revoked device. Placed
    //     after replay so an already-applied op still recovers idempotently; not finalized, so the
    //     verdict is re-evaluated each attempt rather than frozen under this nonce.
    if (this.isDeviceRevoked(actor, env.device)) {
      return reject("deviceRevoked", "device revoked"); // the boundary's code too
    }

    // 3d. per-actor budget (best-effort, injected): the actor is verified by now, which is the whole
    //     reason the check lives here — a boundary that wanted to charge a budget would have to
    //     verify the envelope itself, and an unverified `env.actor` is a claim anyone can wear.
    //     Placed after replay for the same reason as revocation: an applied op still recovers, and
    //     the verdict is not finalized under this nonce.
    if (this.isRateLimited(actor, env.op)) {
      return reject("rateLimited", `too many ${env.op} ops`);
    }

    // 4. load room (a recently-closed room reports `expired`, not `unknownRoom`).
    if (!env.room) return this.finalize(key, reject("invalid", "op requires a room"));
    const room = await this.store.getRoom(env.room);
    if (!room) {
      const code: ErrorCode = this.tombstones.has(env.room) ? "expired" : "unknownRoom";
      return this.finalize(key, reject(code));
    }

    // 5. optimistic concurrency: if the op asserts a baseVersion, it must still match (§6.3).
    if (env.baseVersion !== undefined && env.baseVersion !== room.version) {
      return this.finalize(key, reject("stale"));
    }

    // 6. policy: op allowed? (role + clock-driven phase)
    const nowSec = nowSeconds(this.now());
    // Own keys only, here and for the handler below: both are plain objects, and an op named after
    // an `Object.prototype` member (`toString`, `hasOwnProperty`) would otherwise find a function.
    const opRule = Object.hasOwn(room.policy.ops, env.op) ? room.policy.ops[env.op] : undefined;
    if (!opRule) return this.finalize(key, reject("denied", `op not permitted: ${env.op}`));
    // Which game, beside who (`role`) and when (`phase`): the room's own game, or one its policy
    // opens this op to (`doc/spec/room-operation.md` §8.2).
    if (!gameMayApply(room, env.op, env.game)) {
      return this.finalize(key, reject("gameNotAccepted", `op not open to this game: ${env.op}`));
    }
    if (!roleAllows(opRule.role, actor, room)) {
      return this.finalize(key, reject("denied"));
    }
    if (opRule.phase !== undefined && effectivePhase(room, nowSec) !== opRule.phase) {
      return this.finalize(key, reject("phase"));
    }

    const handler = Object.hasOwn(HANDLERS, env.op) ? HANDLERS[env.op] : undefined;
    if (!handler) return this.finalize(key, reject("denied", `unsupported op: ${env.op}`));

    // Read-only ops (list): return state without mutating, recording, or broadcasting.
    if (READ_ONLY_OPS.has(env.op)) {
      const ro = handler({ room, env, actor, nowSec });
      if (!ro.ok) return reject(ro.error, ro.message);
      return {
        result: { ok: true, version: room.version, result: ro.result },
        changes: [],
        room,
        closed: false,
        replayed: false,
      };
    }

    // 7. structural check + apply intent
    const outcome = handler({ room, env, actor, nowSec });
    if (!outcome.ok) return this.finalize(key, refused(outcome));

    // 8. recompute contended derived state (a lifecycle room's lockAt/unlockAt); a room without
    //    `derived` has none. Under radical trust the client sets `levels`, so a derived sum can
    //    overflow MAX_SAFE_INTEGER (evaluateFormula throws). Catch it as a clean `invalid`
    //    rejection rather than a 500 — and finalize() records it, so a retry can't re-throw past
    //    the un-recorded nonce.
    let nextState = outcome.state;
    const changes = [...outcome.changes];
    if (room.policy.derived && !LEDGER_ONLY_OPS.has(env.op)) {
      try {
        nextState = recomputeDerived(room.policy, nextState);
      } catch {
        return this.finalize(key, reject("invalid", "derived recompute out of range"));
      }
      // The same horizon the place boundary holds: an op may not push a transition later and past it.
      // Otherwise one contribution with a hostile level (levels may be negative) could strand a live
      // room, and a stranded room closes, dropping everything in it.
      const pushed = transitionPastHorizon(room.policy, nextState, room.state);
      if (pushed) return this.finalize(key, reject("invalid", horizonMessage(pushed)));
      changes.push({ type: "derivedUpdated", derived: derivedSnapshot(room.policy, nextState) });
    }

    // 8b. generic reward grants (`doc/spec/room-operation.md` §9.6): every rule this op triggers
    //     hands the actor items from its own pool as custody transfer of opaque signed items — the
    //     engine never interprets them. `applyGrant` owns the whole rule: the `when` gate (over the
    //     post-op state, freshly recomputed above so derived deficits are current),
    //     per-actor-per-pool idempotency, and pool exhaustion — all "grant nothing", never an op
    //     failure (a grant is a bonus, never a gate). The granted items ride back in the result and
    //     as `itemGranted` deltas.
    let grantedItems: OpaqueItem[] | undefined;
    for (const rule of grantRulesOf(room.policy)) {
      if (rule.op !== env.op) continue;
      const granted = applyGrant(nextState, rule, actor);
      if (granted) {
        nextState = granted.state;
        (grantedItems ??= []).push(...granted.granted);
        for (const it of granted.granted) {
          changes.push({ type: "itemGranted", item: it.unique, by: actor });
        }
      }
    }

    // 9. bump version; persist the room mutation and the nonce record in ONE atomic commit, so a
    //    crash can't apply the op without recording it (a retry would re-apply) or vice-versa.
    //    Close per policy (emptied, for a room with no lifecycle; all claimed, for a lifecycle room).
    //
    //    Unless nothing was applied: a handler that reported `noop` (a repeated `react`) AND no
    //    grant fired above leaves the room exactly as it was read, so there is no write to make and
    //    no version to burn. A room persists as ONE JSON blob, so re-writing it for a gesture that
    //    changed nothing pays the whole per-op serialize cost MAX_OP_LEDGER is sized against, and
    //    the version bump would additionally turn any concurrent op holding a `baseVersion`
    //    (step 5) `stale` over a no-change. The two terms are two different scopes: `noop` is the
    //    handler's claim about step 7, `grantedItems` is this engine's own step 8b, which runs
    //    after it. Closure is not re-evaluated either: state the room already persisted under
    //    cannot newly satisfy a close condition. The nonce is still recorded below, so a retry
    //    is unchanged.
    const noop = outcome.noop === true && grantedItems === undefined;
    const version = noop ? room.version : room.version + 1;
    let updated: Room | undefined = noop ? room : { ...room, state: nextState, version };
    let closed = false;
    const mutations: Mutation[] = [];

    if (!noop) {
      if (shouldClose(room.policy, updated)) {
        mutations.push({ kind: "deleteRoom", id: room.id });
        updated = undefined;
        closed = true;
        changes.push({ type: "closed" });
      } else {
        mutations.push({ kind: "putRoom", room: updated });
      }
    }

    // Fold any granted reward items into the op result payload (alongside e.g. a claim's `items`),
    // so the actor receives them in the REST response even if this op also closes the room. A
    // distinct `granted` key keeps contributed items and pool rewards separable.
    let resultPayload = outcome.result;
    if (grantedItems) {
      // outcome.result is always an object or undefined here (every mutating handler returns an object
      // literal or leaves it unset), so a plain `?? {}` is enough — no primitive to guard against.
      const base = (resultPayload as Record<string, unknown> | undefined) ?? {};
      resultPayload = { ...base, granted: grantedItems };
    }
    const result: OpResult =
      resultPayload === undefined
        ? { ok: true, version }
        : { ok: true, version, result: resultPayload };
    mutations.push({ kind: "putNonce", nonce: key, result });
    await this.store.commit(mutations);
    if (closed) this.tombstone(room.id); // tombstone only once the delete has committed
    return { result, changes, room: updated, closed, replayed: false };
  }

  /** Record a stable rejection so a retry with the same nonce returns the same outcome. */
  private async finalize(key: string, applied: AppliedOp): Promise<AppliedOp> {
    await this.store.commit([{ kind: "putNonce", nonce: key, result: applied.result }]);
    return applied;
  }

  /** Remember a closed room id (bounded, FIFO) so racing ops get `expired`. */
  private tombstone(id: GlobalId): void {
    this.tombstones.add(id);
    if (this.tombstones.size > this.maxTombstones) {
      const oldest = this.tombstones.values().next().value;
      if (oldest !== undefined) this.tombstones.delete(oldest);
    }
  }
}

/** Copy the caller's initial state so placement can't alias it — the object plus each seeded array. */
function cloneInitialState(state: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!state) return { contents: [] };
  const copy = { ...state };
  // Deep-copy every seeded array (contents, any reward pool), not just the top-level object.
  for (const key of Object.keys(copy)) {
    const value = copy[key];
    if (Array.isArray(value)) copy[key] = [...value];
  }
  return copy;
}

/**
 * Throw `label` if any element of `items` fails `validate` — the shared place-time VERIFIED-axis
 * gate (beacon.core `doc/spec/identity.md` §5.1): every item entering shared state must parse AND
 * carry verified provenance, so no malformed/unsigned/forged item ever leaks back out via
 * take/claim/grant.
 */
function assertSeeded(items: unknown, validate: (raw: unknown) => boolean, label: string): void {
  if (!Array.isArray(items)) return;
  for (const raw of items) {
    if (!validate(raw)) throw new Error(label);
  }
}

/**
 * Seeded items (contents or a reward pool) must be opaque items with verified provenance — verified
 * generically over `{unique, ...birth}`, so the engine never interprets the game payload.
 */
function assertSeededItems(items: unknown, label: string): void {
  assertSeeded(
    items,
    (raw) => {
      const parsed = opaqueItemSchema.safeParse(raw);
      return (
        parsed.success &&
        verifyItemProvenance(
          { unique: parsed.data.unique, birth: parsed.data.birth },
          parsed.data.mintedBy,
        )
      );
    },
    label,
  );
}

/**
 * Build the contributor ledger from seeded `initialContents`: an item carrying an `owner` is that owner's
 * contribution (a scanner-found capsule seeds the finder's own at place), so it registers as `owner ->
 * [unique]` — the same shape `handleContribute` writes. Un-owned seeded items (a jar's up-for-grabs
 * contents) register nobody. Provenance is verified by the caller before this runs.
 *
 * Unlike `handleContribute` this is NOT `maxContributors`-gated: a placer seeds their OWN room, so
 * the real case is a single self-contribution. A crafted multi-owner seed could register more than
 * the cap, but it's bounded and non-exploitable — `owner` is trusted mutable custody (beacon.core
 * `doc/spec/identity.md` §4.3; the item's provenance is still verified above), and pool grants only
 * ever drain the placer's own finite pool.
 */
function contributorsFromSeed(contents: unknown): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  if (!Array.isArray(contents)) return out;
  for (const item of contents as OpaqueItem[]) {
    if (item.owner != null) (out[item.owner] ??= []).push(item.unique);
  }
  return out;
}

function reject(error: ErrorCode, message?: string): AppliedOp {
  return refused(message === undefined ? { ok: false, error } : { ok: false, error, message });
}

/** A rejection as the engine records and answers it: the result as given, nothing applied. */
function refused(result: ErrorResult): AppliedOp {
  return {
    result,
    changes: [],
    closed: false,
    replayed: false,
  };
}

function shouldClose(policy: Policy, room: Room): boolean {
  if (policy.onEmpty !== "close") return false;
  // A lifecycle room closes at op time once every contributor has claimed; the tick handles the
  // rest (claim window, nobody contributed, grants all paid). A room with no lifecycle closes when
  // its contents are empty.
  if (policy.lifecycle) return roomFullyClaimed(room.state);
  const contents = room.state["contents"];
  return Array.isArray(contents) && contents.length === 0;
}
