import { evaluate, evaluateFormula } from "@beaconsgg/jsonlogic-profile";
import { currentPhase } from "./roles";
import {
  type DidKey,
  type GrantRule,
  type JsonLogicRule,
  type Levels,
  type OpaqueItem,
  parseDuration,
  type Policy,
  type Reaction,
  type Room,
  TRANSITION_HORIZON_SEC,
} from "@beaconsgg/protocol-types";

const NO_RULES: GrantRule[] = [];

/**
 * The room lifecycle + contended derived state (beacon.core `doc/spec/item-properties.md` §5;
 * `doc/spec/room-operation.md` §9.3). Phases are driven by the **server clock** vs the derived
 * `lockAt` / `unlockAt`; the derived block is recomputed from the *whole* contents on each
 * contribution (the lost-update fix). Timeline values are epoch **seconds**, so the engine compares
 * `floor(now_ms / 1000)` against them.
 */

export function nowSeconds(nowMs: number): number {
  return Math.floor(nowMs / 1000);
}

/** Recorded contributors: contributor did -> the `unique`s they put in. */
export function getContributors(state: Record<string, unknown>): Record<string, string[]> {
  const c = state["contributors"];
  return typeof c === "object" && c !== null ? (c as Record<string, string[]>) : {};
}

/** Contributor dids who have already claimed their items. */
export function getClaimed(state: Record<string, unknown>): string[] {
  const c = state["claimed"];
  return Array.isArray(c) ? c.filter((x): x is string => typeof x === "string") : [];
}

/**
 * The room's reaction ledger (`doc/spec/room-operation.md` §9.6): append-only, written only by
 * `react`. Defensive like every state reader: anything that is not an array reads as none.
 */
export function getReactions(state: Record<string, unknown>): Reaction[] {
  const r = state["reactions"];
  return Array.isArray(r) ? (r as Reaction[]) : [];
}

/**
 * Actor dids who have already received pool grants. Two stored shapes: the current per-pool
 * record (`{ [actor]: { [pool]: uniques[] } }`) and the legacy flat array (`{ [actor]:
 * uniques[] }`) written when policies carried at most one grant rule — policies are frozen, so
 * the shapes never mix meaningfully inside one room. Readers normalize via {@link grantedPools}.
 */
export function getGranted(
  state: Record<string, unknown>,
): Record<string, string[] | Record<string, string[]>> {
  const g = state["granted"];
  return typeof g === "object" && g !== null
    ? (g as Record<string, string[] | Record<string, string[]>>)
    : {};
}

/**
 * One actor's granted map, normalized to per-pool: a legacy flat array reads as consumed for
 * `legacyPool` (the single pool the room's one rule draws from).
 */
export function grantedPools(
  entry: string[] | Record<string, string[]> | undefined,
  legacyPool: string,
): Record<string, string[]> {
  if (entry === undefined) return {};
  return Array.isArray(entry) ? { [legacyPool]: entry } : entry;
}

/** The policy's grant rules as a list (the schema admits one rule or an array). Called on the
 *  per-op hot path, so the grant-less common case returns a shared constant, not a fresh array. */
export function grantRulesOf(policy: Policy): GrantRule[] {
  const g = policy.grant;
  if (!g) return NO_RULES;
  return Array.isArray(g) ? g : [g];
}

/**
 * The most entries ONE op's own append-only state ledger may hold, whatever a (client-authored)
 * policy asks for in `ops.<op>.max`. The number is set by how a room is stored, not by taste: a
 * room persists and re-parses as a single JSON blob on **every** op it takes, so an unbounded
 * ledger would tax `take`, `contribute` and the lifecycle tick for reactions none of them read.
 *
 * What 500 costs, priced against the schemas that bound an entry rather than against the happy
 * case: a typical reaction (a ULID target, a short kind) serializes to ~170 bytes, so a full
 * ledger is ~85 KB. At the bounds a hostile client can actually reach (`MAX_REACTION_TARGET_LEN`
 * and `MAX_REACTION_KIND_LEN`, with a DID at its own regex ceiling) an entry is ~320 bytes and a
 * full ledger ~160 KB. That is the number this ceiling is chosen against; keep the two in step
 * if either string bound moves.
 *
 * The place boundary refuses a policy asking for more, so nothing is ever silently clamped.
 */
export const MAX_OP_LEDGER = 500;

/**
 * The ops that keep their OWN append-only ledger in room state, and the state key each one writes.
 * One entry is the whole declaration: it is what makes `ops.<op>.max` meaningful (the place
 * boundary refuses the bound on any op not named here), and the ledger's key joins
 * {@link RESERVED_STATE_KEYS} below by derivation rather than by a second hand-written string.
 *
 * Deliberately NOT `LEDGER_ONLY_OPS`, which sits beside the handlers and means something narrower:
 * that an op ALSO touches no derived formula and no object summary, so its broadcasts can be
 * skipped. The two coincide today because `react` is the only member of either. An op that kept a
 * bounded ledger and still fed a derived formula would belong here and not there, and folding the
 * two together would make it choose between a valid `max` and its own recompute.
 */
export const OP_LEDGER_KEYS: ReadonlyMap<string, string> = new Map([["react", "reactions"]]);

/**
 * State keys the engine itself writes — a seeded reward pool may not claim one (a pool named
 * `contributors` would forge the ledger; `granted` would pre-consume grants), and neither may a
 * `derived` formula (it would overwrite the key with a number on every recompute). The place
 * boundary rejects these as pool names and as derived keys.
 */
export const RESERVED_STATE_KEYS: ReadonlySet<string> = new Set([
  "contents",
  "contributors",
  "claimed",
  "granted",
  ...OP_LEDGER_KEYS.values(),
  "phase",
  "placedAt",
  "settledAt",
]);

/**
 * Does a grant rule's `when` pass over `state`? Absent passes. A number passes at 1 or more, which
 * is how a ladder's clamped deficits read. A boolean counts as 1 or 0, so a comparison such as
 * `{">=": [{"var": "score"}, 10]}` pays when true, as an author writing one expects
 * (beacons-gg/beacon.server#78; before, the integer guard threw on it and the rule never paid).
 * Anything else, and any throw (hostile levels overflowing the profile guard), doesn't pass.
 */
export function grantConditionPasses(
  when: JsonLogicRule | undefined,
  state: Record<string, unknown>,
): boolean {
  if (when === undefined) return true;
  let result: unknown;
  try {
    result = evaluate(when, state);
  } catch {
    return false;
  }
  if (typeof result === "boolean") return result;
  return typeof result === "number" && Number.isSafeInteger(result) && result >= 1;
}

/** A named reward pool in room state (always an OpaqueItem[] — the engine controls every write). */
export function poolOf(state: Record<string, unknown>, key: string): OpaqueItem[] {
  const p = state[key];
  return Array.isArray(p) ? (p as OpaqueItem[]) : [];
}

/**
 * Apply one policy `grant` rule for `actor` (`doc/spec/room-operation.md` §9.6): hand them up to
 * `count` un-granted items from the rule's pool as **custody transfer** (set `owner = actor`) — the
 * same primitive as a jar `take`, so the engine never interprets the opaque items. Idempotent per
 * actor **per pool** (recorded in `state.granted`; a legacy flat entry reads as this rule's pool).
 * Returns the new state + the granted items, or `undefined` when the rule's `when` condition
 * doesn't pass, the actor already drew from this pool, or it is exhausted (the triggering op still
 * succeeds — a grant is a bonus, never a gate).
 *
 * `when` is evaluated over `state` (the engine hands in the post-op, freshly recomputed state, so
 * derived deficits are current) by {@link grantConditionPasses}.
 */
export function applyGrant(
  state: Record<string, unknown>,
  grant: GrantRule,
  actor: DidKey,
): { state: Record<string, unknown>; granted: OpaqueItem[] } | undefined {
  if (!grantConditionPasses(grant.when, state)) return undefined;
  const already = getGranted(state);
  const actorPools = grantedPools(already[actor], grant.from);
  if (actorPools[grant.from]) return undefined; // this actor already drew from this rule's pool
  const pool = poolOf(state, grant.from);
  const available = pool.filter((it) => it.owner == null);
  if (available.length === 0) return undefined; // pool exhausted
  const take = available.slice(0, grant.count);
  const takenUniques = take.map((it) => it.unique);
  const taken = new Set(takenUniques);
  const nextPool = pool.map((it) => (taken.has(it.unique) ? { ...it, owner: actor } : it));
  // The granted items ARE the pool entries whose owner we just flipped — reuse them (no second spread).
  const granted = nextPool.filter((it) => taken.has(it.unique));
  return {
    state: {
      ...state,
      [grant.from]: nextPool,
      granted: { ...already, [actor]: { ...actorPools, [grant.from]: takenUniques } },
    },
    granted,
  };
}

function contentsOf(state: Record<string, unknown>): OpaqueItem[] {
  const c = state["contents"];
  return Array.isArray(c) ? (c as OpaqueItem[]) : [];
}

/**
 * The phase a room *should* be in at `nowSec`, from its lifecycle + derived timestamps.
 * Clock-authoritative — used to gate ops, so a contribution can't sneak in after `lockAt`
 * even if the broadcast tick hasn't fired yet. Non-lifecycle rooms return their stored phase.
 */
export function effectivePhase(room: Room, nowSec: number): string | undefined {
  const lc = room.policy.lifecycle;
  if (!lc) {
    const p = room.state["phase"];
    return typeof p === "string" ? p : undefined;
  }
  let phase = lc.phases[0] ?? "";
  for (let i = 1; i < lc.phases.length; i++) {
    const next = lc.phases[i] as string;
    const key = lc.transitions[next];
    const at = key !== undefined ? room.state[key] : undefined;
    if (typeof at === "number" && nowSec >= at) phase = next;
    else break; // phases are ordered; stop at the first transition that hasn't fired
  }
  return phase;
}

export function lastPhase(room: Room): string | undefined {
  const phases = room.policy.lifecycle?.phases;
  return phases ? phases[phases.length - 1] : undefined;
}

/**
 * Recompute the policy's `derived` block from the current state, in declaration order so a formula
 * can reference an earlier-derived value (e.g. `unlockAt` reads `lockAt`). Server-run for contended
 * state (beacon.core `doc/spec/item-properties.md` §5).
 */
export function recomputeDerived(
  policy: Policy,
  state: Record<string, unknown>,
): Record<string, unknown> {
  if (!policy.derived) return state;
  const out: Record<string, unknown> = { ...state };
  for (const [key, rule] of Object.entries(policy.derived)) {
    out[key] = evaluateFormula(rule, out);
  }
  return out;
}

/** Snapshot the integer-valued derived keys, for a `derivedUpdated` live event. */
export function derivedSnapshot(policy: Policy, state: Record<string, unknown>): Levels {
  const out: Levels = {};
  for (const key of Object.keys(policy.derived ?? {})) {
    const value = state[key];
    if (typeof value === "number") out[key] = value;
  }
  return out;
}

/**
 * The frozen per-contributor claim set, computed deterministically from contents + the
 * contributor map. Once `Locked`, contents no longer change, so this is stable — there is no
 * separate freeze step; `claimed` tracks who has taken theirs.
 */
export function claimsByContributor(state: Record<string, unknown>): Record<string, OpaqueItem[]> {
  const contributors = getContributors(state);
  const byUnique = new Map(contentsOf(state).map((r) => [r.unique, r]));
  const out: Record<string, OpaqueItem[]> = {};
  for (const [did, uniques] of Object.entries(contributors)) {
    out[did] = uniques.map((u) => byUnique.get(u)).filter((r): r is OpaqueItem => r !== undefined);
  }
  return out;
}

/** True once every contributor has claimed (the in-op close condition). */
export function roomFullyClaimed(state: Record<string, unknown>): boolean {
  const contributors = Object.keys(getContributors(state));
  if (contributors.length === 0) return false;
  const claimed = getClaimed(state);
  return contributors.every((d) => claimed.includes(d));
}

/**
 * The first phase transition `state` schedules past core's {@link TRANSITION_HORIZON_SEC} (10 years)
 * after placement, as the phase and its transition key. Formulas cannot see the clock, so a policy
 * that means "never" writes a transition decades out: an early challenge policy wrote a lost one's
 * `won` about 30 years past its deadline per missing unit. The place boundary refuses a room that
 * schedules one, an op that would schedule one is refused, and a stored room left waiting on one
 * closes ({@link strandedClosesAt}).
 *
 * Given `before`, only one that also moved later than it stood there:
 * a stored room whose own formulas already wrote "never" may still take an op that brings it nearer.
 * The place boundary asks without `before`; `applyOp` asks with the state the op started from.
 */
export function transitionPastHorizon(
  policy: Policy,
  state: Record<string, unknown>,
  before?: Record<string, unknown>,
): { phase: string; key: string } | undefined {
  const placedAt = state["placedAt"];
  if (!policy.lifecycle || typeof placedAt !== "number") return undefined;
  for (const [phase, key] of Object.entries(policy.lifecycle.transitions)) {
    const at = state[key];
    if (typeof at !== "number" || at <= placedAt + TRANSITION_HORIZON_SEC) continue;
    const was = before?.[key];
    if (before === undefined || typeof was !== "number" || at > was) return { phase, key };
  }
  return undefined;
}

/** The refusal {@link transitionPastHorizon} backs, in one wording for the place boundary and for ops. */
export function horizonMessage(found: { phase: string; key: string }): string {
  return `the ${found.phase} transition (${found.key}) would be more than ${TRANSITION_HORIZON_SEC / (365 * 86_400)} years after placement`;
}

/**
 * Ops that can neither hand items out nor change what a room holds or computes: reading it (`list`,
 * the handlers' one read-only op) and the ops that only append to their own ledger
 * ({@link OP_LEDGER_KEYS}). Every other op counts as able to move a room, including one a later build
 * adds, which is the safe way round for {@link strandedClosesAt}.
 */
const INERT_OPS: ReadonlySet<string> = new Set(["list", ...OP_LEDGER_KEYS.keys()]);

/** Whether every op the policy allows in `phase` is inert: nothing done there can move the room. */
function idleIn(policy: Policy, phase: string): boolean {
  return Object.entries(policy.ops).every(
    ([op, rule]) => INERT_OPS.has(op) || (rule.phase !== undefined && rule.phase !== phase),
  );
}

/**
 * When a room stranded short of its last phase closes, or `undefined` if it is not stranded.
 * Stranded: its next transition is past {@link TRANSITION_HORIZON_SEC} (so never), and nothing its
 * current phase allows can move it (only reads and reactions, {@link idleIn}): nothing can pay anyone,
 * and no contribution can bring that transition back. A lost stage-3 challenge is one: parked in
 * `ended`, which allows no op at all, waiting on a `won` decades out. It closes `claimTtl` after the
 * time its current phase was scheduled to begin, or at that time with no `claimTtl`. Read from the
 * stored phase, so watchers have seen the room enter it before it goes.
 */
function strandedClosesAt(room: Room): number | undefined {
  const lc = room.policy.lifecycle;
  if (room.policy.onEmpty !== "close" || !lc) return undefined;
  const phase = currentPhase(room) ?? lc.phases[0] ?? "";
  const i = lc.phases.indexOf(phase);
  if (i < 0 || i === lc.phases.length - 1) return undefined; // a settled room has its own window
  const placedAt = room.state["placedAt"];
  const nextKey = lc.transitions[lc.phases[i + 1] as string];
  const next = nextKey !== undefined ? room.state[nextKey] : undefined;
  if (typeof placedAt !== "number" || typeof next !== "number") return undefined;
  if (next <= placedAt + TRANSITION_HORIZON_SEC || !idleIn(room.policy, phase)) return undefined;
  const enteredKey = i === 0 ? "placedAt" : lc.transitions[phase];
  const entered = enteredKey !== undefined ? room.state[enteredKey] : undefined;
  if (typeof entered !== "number") return undefined;
  return entered + (claimWindowSec(room.policy) ?? 0);
}

/**
 * The policy's `claimTtl` in seconds, or `undefined` for no window: none set, or one core's
 * `parseDuration` does not read. Placement refuses an unreadable one, so only a room stored before
 * that rule can hold one.
 */
function claimWindowSec(policy: Policy): number | undefined {
  return policy.claimTtl === undefined ? undefined : parseDuration(policy.claimTtl);
}

/**
 * Does this room still owe somebody an un-drawn grant? True while ANY contributor could still
 * collect from ANY pool whose rule currently passes and still holds an un-granted item.
 *
 * This is the general form of {@link roomFullyClaimed}, which reads the `claimed` ledger the
 * `claim` op writes. A repeatable grant op (a challenge's `collect`, which pays each
 * rung as it lands and so must stay callable) never marks a room "claimed", so that ledger stays
 * empty forever and the fast close never fires — the room lingers for its whole TTL even once
 * every member has been paid everything they earned. Asking the grant bookkeeping directly works
 * for both shapes, because `granted` is what every payout actually records.
 *
 * A rung the team never reached has a `when` that doesn't pass, so it is owed to nobody: a
 * challenge that ran out of time closes once its LANDED rungs are collected, not once its
 * unreachable ones are.
 */
export function grantsOutstanding(policy: Room["policy"], state: Record<string, unknown>): boolean {
  const contributors = Object.keys(getContributors(state));
  if (contributors.length === 0) return false;
  const already = getGranted(state);
  for (const rule of grantRulesOf(policy)) {
    if (!poolOf(state, rule.from).some((it) => it.owner == null)) continue; // nothing left in it
    if (!grantConditionPasses(rule.when, state)) continue; // the same gate `applyGrant` applies
    if (contributors.some((actor) => !grantedPools(already[actor], rule.from)[rule.from]))
      return true;
  }
  return false;
}

/**
 * Whether the **tick** should close a settled room: it's fully claimed, owes nobody anything, had
 * no contributors, or its claim window has ended ({@link claimWindowClosesAt}; undrawn items dropped).
 * Or a room that will never settle: stranded behind a transition past the horizon
 * ({@link strandedClosesAt}).
 */
export function lifecycleRoomShouldClose(room: Room, nowSec: number): boolean {
  if (room.policy.onEmpty !== "close" || !room.policy.lifecycle) return false;
  const stranded = strandedClosesAt(room);
  if (stranded !== undefined) return nowSec >= stranded;
  if (effectivePhase(room, nowSec) !== lastPhase(room)) return false; // not unlocked yet
  // Wait for the stored phase to catch up, so the room is never deleted before its watchers have
  // seen it settle — and so `settledAt` is always stamped before it anchors anything.
  if ((currentPhase(room) ?? room.policy.lifecycle.phases[0]) !== lastPhase(room)) return false;

  if (roomFullyClaimed(room.state)) return true;
  if (Object.keys(getContributors(room.state)).length === 0) return true; // nobody contributed
  // Everyone has been paid everything the room can still pay them.
  if (grantRulesOf(room.policy).length > 0 && !grantsOutstanding(room.policy, room.state))
    return true;

  const closesAt = claimWindowClosesAt(room);
  return closesAt !== undefined && nowSec >= closesAt;
}

/**
 * When a room's claim window ends: `claimTtl` after it ENTERED its terminal phase (`settledAt`, stamped
 * by `advancePhase`), or after `unlockAt` for a room placed before that stamp existed, which is the
 * behaviour it was placed under. `undefined` when the policy has no usable `claimTtl`, when the room
 * has no anchor yet, or when it never closes on its own (no lifecycle, or no `onEmpty: "close"`): the
 * close check refuses those, so a window for them would schedule a wake with nothing to do.
 *
 * Settlement, not `unlockAt`: winning a challenge collapses `unlockAt` to `placedAt` (that collapse
 * IS how a completed ladder settles early), and a timed room settles on the first tick after it
 * unlocks, later still if the server was down. A window measured from `unlockAt` could already be
 * spent, and the escrow swept before anyone could collect. {@link lifecycleRoomShouldClose} and
 * {@link nextTransitionAt} both read this, so the close and its schedule cannot disagree.
 */
function claimWindowClosesAt(room: Room): number | undefined {
  if (room.policy.onEmpty !== "close" || !room.policy.lifecycle) return undefined;
  const ttl = claimWindowSec(room.policy);
  if (ttl === undefined) return undefined;
  const settledAt = room.state["settledAt"];
  const anchor = typeof settledAt === "number" ? settledAt : room.state["unlockAt"];
  return typeof anchor === "number" ? anchor + ttl : undefined;
}

/**
 * The next epoch-**second** at which the lifecycle tick has work for this room — its effective
 * phase advances, or it should close — or `undefined` when the tick has nothing more to do (a
 * non-lifecycle room, or one caught up to its terminal phase with no pending close). This is the
 * scheduling key for the server's timer-wheel: a room is processed only when this time arrives,
 * instead of scanning every room each tick (`doc/spec/room-operation.md` §8.4). It mirrors exactly
 * the conditions under which `advancePhase` produces a change.
 *
 * A value `<= nowSec` means work is due **right now** — an un-broadcast/overdue transition (e.g.
 * after a restart) or a close that has come due. Re-evaluate it after each `advancePhase`: once a
 * room is caught up, it returns the soonest future boundary (or `undefined` to stop scheduling it).
 */
export function nextTransitionAt(room: Room, nowSec: number): number | undefined {
  const lc = room.policy.lifecycle;
  if (!lc) return undefined;

  // Pending right now: a stored phase behind the effective phase (an un-broadcast advance), or a
  // close that's already due — either means "process immediately".
  const stored = typeof room.state["phase"] === "string" ? room.state["phase"] : lc.phases[0];
  if (effectivePhase(room, nowSec) !== stored) return nowSec;
  if (lifecycleRoomShouldClose(room, nowSec)) return nowSec;

  // Otherwise the soonest future boundary: a phase-entry time, or the claim window's close.
  let next: number | undefined;
  const consider = (t: unknown): void => {
    if (typeof t === "number" && t > nowSec && (next === undefined || t < next)) next = t;
  };
  for (let i = 1; i < lc.phases.length; i++) {
    const key = lc.transitions[lc.phases[i] as string];
    consider(key !== undefined ? room.state[key] : undefined);
  }
  consider(claimWindowClosesAt(room));
  consider(strandedClosesAt(room));
  return next;
}
