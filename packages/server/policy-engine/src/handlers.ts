import { accepts, withinCapacity, type AcceptCandidate } from "@beaconsgg/jsonlogic-profile";
import { verifyItemProvenance } from "@beaconsgg/identity";
import {
  opaqueItemSchema,
  reactParamsSchema,
  type DidKey,
  type OpaqueItem,
  type OpEnvelope,
  type Reaction,
  type Room,
  type RoomChange,
  type ErrorResult,
} from "@beaconsgg/protocol-types";
import { paramsRefusal } from "@beaconsgg/protocol-types/server";
import {
  claimsByContributor,
  getClaimed,
  getContributors,
  getReactions,
  grantRulesOf,
  poolOf,
  MAX_OP_LEDGER,
} from "./lifecycle";

/**
 * Op handlers (room-operation.md) — one per op: a pure structural/consistency check returning the next
 * state + deltas or a typed rejection. The engine owns verification, derived recompute, versioning, and
 * the single atomic commit; a handler reads only an opaque item's `unique`/`owner`/`match`, never its
 * game payload (radical trust).
 */

/**
 * Validate an item crossing into a room's shared contents (`add` / `contribute`): it must parse as
 * an OpaqueItem AND carry **valid, verified provenance** (beacon.core `doc/spec/identity.md` §5.1
 * and §3 — the VERIFIED axis): a `mintedBy` signature over `{unique, ...birth}`. Both are required
 * so no malformed, unsigned, or forged item ever enters shared state (provenance powers
 * client-local trust/block lists, §9). The engine never interprets the item's game payload — it
 * verifies the signature and reads only `unique`/`owner`/`match`. Returns the parsed item, or the
 * error result to return as-is.
 */
function parseIncomingItem(raw: unknown): { ok: true; item: OpaqueItem } | ErrorResult {
  const parsed = opaqueItemSchema.safeParse(raw);
  if (!parsed.success) {
    return paramsRefusal(parsed.error, ["item"], "params.item is not a valid item");
  }
  if (
    !verifyItemProvenance(
      { unique: parsed.data.unique, birth: parsed.data.birth },
      parsed.data.mintedBy,
    )
  ) {
    return {
      ok: false,
      error: "invalid",
      message: "item provenance (mintedBy) is missing or invalid",
    };
  }
  return { ok: true, item: parsed.data };
}

export interface OpContext {
  room: Room;
  env: OpEnvelope;
  actor: DidKey;
  /** The engine's clock in epoch seconds — the same `nowSec` the phase gate used for this op. */
  nowSec: number;
}

export type HandlerResult =
  | ErrorResult
  | {
      ok: true;
      state: Record<string, unknown>;
      result?: unknown;
      changes: RoomChange[];
      /**
       * "Applied, and there is nothing to persist": the op succeeded but left room state exactly as
       * it found it (a repeated `react`). The engine answers from the unchanged room instead of
       * re-writing it: without this, an idempotent success still re-serializes the whole room blob
       * and bumps the version, which costs the very per-op write {@link MAX_OP_LEDGER}'s ceiling is
       * argued from, and turns a racing `baseVersion` assertion `stale` over a gesture that changed
       * nothing. Set it only when `state` is returned by reference and `changes` is empty.
       *
       * It is a claim about THIS handler's step only. The engine still checks its own later steps
       * (a grant rule may fire on any op, including a repeated one) before it skips the write, and
       * records the nonce either way, so a retry is as stable as any other op's.
       */
      noop?: boolean;
    };

/** The room's contents (always an OpaqueItem[]: the engine controls every write). */
export function getContents(room: Room): OpaqueItem[] {
  const c = room.state["contents"];
  return Array.isArray(c) ? (c as OpaqueItem[]) : [];
}

/**
 * The accept candidate for an item — its generic `match` projection (`{class, levels, tags}`). The
 * accept gate is a structural/consistency gate, **not** anti-cheat: `match` is self-attested, so
 * under radical trust a dishonest client could spoof it either way (beacon.core
 * `doc/spec/identity.md` §3). An item with no `match` matches only an unconstrained accept.
 */
function toCandidate(item: OpaqueItem): AcceptCandidate {
  // `match` is the AcceptCandidate shape (class/levels/tags); the cast bridges the present-but-undefined
  // optionals (zod infers `?: T | undefined`) to AcceptCandidate's `?: T` — structurally identical.
  return (item.match ?? {}) as AcceptCandidate;
}

/** add(item): give an item away into custody; owner -> null (up for grabs). */
export function handleAdd(ctx: OpContext): HandlerResult {
  // Capacity first — a full room rejects cheaply, before the Ed25519 provenance verify inside
  // `parseIncomingItem` (so spamming a full room can't force signature checks). Precedence: full > invalid.
  const contents = getContents(ctx.room);
  if (!withinCapacity(contents.length, ctx.room.policy.accept?.capacity)) {
    return { ok: false, error: "full" };
  }
  const incoming = parseIncomingItem(ctx.env.params["item"]);
  if (!incoming.ok) return incoming;
  const item = incoming.item;

  if (ctx.room.policy.accept && !accepts(ctx.room.policy.accept, toCandidate(item))) {
    return { ok: false, error: "denied", message: "rejected by accept predicate" };
  }

  const placed: OpaqueItem = { ...item, owner: null };
  return {
    ok: true,
    state: { ...ctx.room.state, contents: [...contents, placed] },
    result: { added: placed.unique },
    changes: [{ type: "itemAdded", item: placed, by: ctx.actor }],
  };
}

/**
 * take(item): authority transfer (`doc/spec/room-operation.md` §7) — in one atomic step remove the
 * item, set its `owner` to the actor, and return it. `gone` if already taken.
 */
export function handleTake(ctx: OpContext): HandlerResult {
  const item = ctx.env.params["item"];
  if (typeof item !== "string") {
    return { ok: false, error: "invalid", message: "params.item must be a `unique` string" };
  }
  const contents = getContents(ctx.room);
  if (contents.length === 0) return { ok: false, error: "empty" };

  const index = contents.findIndex((r) => r.unique === item);
  if (index === -1) return { ok: false, error: "gone" };

  const owned: OpaqueItem = { ...(contents[index] as OpaqueItem), owner: ctx.actor };
  const remaining = contents.filter((_, i) => i !== index);
  return {
    ok: true,
    state: { ...ctx.room.state, contents: remaining },
    result: { item: owned },
    changes: [{ type: "itemRemoved", item: owned.unique, by: ctx.actor }],
  };
}

/** list: read contents (read-only — no mutation, no broadcast, no version bump). */
export function handleList(ctx: OpContext): HandlerResult {
  return {
    ok: true,
    state: ctx.room.state,
    result: { contents: getContents(ctx.room) },
    changes: [],
  };
}

/**
 * contribute(item): in the phases the policy allows it (a timed room's first phase,
 * `doc/spec/room-operation.md` §9.3). Append + record the contributor; the engine then recomputes
 * `lockAt`/`unlockAt` from the full contents (the contended-recompute fix). `owner` stays the
 * contributor while in the room (beacon.core `doc/spec/identity.md` §4.3). Intent only.
 */
export function handleContribute(ctx: OpContext): HandlerResult {
  // Capacity first — cheap reject before the Ed25519 provenance verify (see `handleAdd`).
  const contents = getContents(ctx.room);
  if (!withinCapacity(contents.length, ctx.room.policy.accept?.capacity)) {
    return { ok: false, error: "full" };
  }
  // Contributor cap (`doc/spec/room-operation.md` §9.6): a NEW contributor past `maxContributors`
  // is rejected (it sizes a reward pool); an existing contributor may keep adding within
  // `capacity`. A cheap count reject before the Ed25519 verify, like capacity above.
  const maxContributors = ctx.room.policy.maxContributors;
  if (maxContributors !== undefined) {
    const contributors = getContributors(ctx.room.state);
    if (!(ctx.actor in contributors) && Object.keys(contributors).length >= maxContributors) {
      return { ok: false, error: "full", message: "no contributor slots left" };
    }
  }
  const incoming = parseIncomingItem(ctx.env.params["item"]);
  if (!incoming.ok) return incoming;
  const item = incoming.item;

  if (ctx.room.policy.accept && !accepts(ctx.room.policy.accept, toCandidate(item))) {
    return { ok: false, error: "denied", message: "rejected by accept predicate" };
  }

  const placed: OpaqueItem = { ...item, owner: ctx.actor };
  const contributors = getContributors(ctx.room.state);
  const updatedContributors = {
    ...contributors,
    [ctx.actor]: [...(contributors[ctx.actor] ?? []), placed.unique],
  };
  return {
    ok: true,
    state: {
      ...ctx.room.state,
      contents: [...contents, placed],
      contributors: updatedContributors,
    },
    result: { contributed: placed.unique },
    changes: [{ type: "itemAdded", item: placed, by: ctx.actor }],
  };
}

/**
 * claim(): role contributor, in the phases the policy allows it (a capsule's Unlocked). Returns the
 * actor's frozen items (the client computes the upgrade via `unlockTransform`); marks the
 * contributor as claimed. The items deliberately STAY in `contents` (so a derived aggregate is
 * stable for the other claimants and the TTL tick can drop unclaimed ones) — hence the delta is
 * `itemClaimed`, **not** `itemRemoved`: the contributor took custody, but nothing leaves the shared
 * contents. Closing (all claimed) is handled by the engine; TTL by the tick.
 */
export function handleClaim(ctx: OpContext): HandlerResult {
  const claimed = getClaimed(ctx.room.state);
  if (claimed.includes(ctx.actor)) {
    return { ok: false, error: "gone" }; // already claimed
  }
  const items = claimsByContributor(ctx.room.state)[ctx.actor] ?? [];
  if (items.length === 0) {
    // Defensive: the role:"contributor" gate already rejects a non-contributor, and contents
    // freeze at lock, so a contributor's items can't vanish — this branch shouldn't be reachable.
    return { ok: false, error: "gone" };
  }
  return {
    ok: true,
    state: { ...ctx.room.state, claimed: [...claimed, ctx.actor] },
    result: { items },
    changes: items.map((it) => ({ type: "itemClaimed" as const, item: it.unique, by: ctx.actor })),
  };
}

/**
 * collect(): a deliberate no-op whose only effect is the engine's policy machinery — the derived
 * recompute and, above all, the `grant` rules its op name triggers (engine step 8b). Where `claim`
 * carries capsule semantics (return YOUR contributed items, once per actor, feed the all-claimed
 * close), collect carries none: repeatable, touches neither `claimed` nor `contents`, and grants
 * stay idempotent per actor PER POOL — so a policy staging pools behind `when` conditions (a
 * challenge ladder) can pay each rung as it completes, on a fresh collect. A collect that grants
 * nothing still succeeds (a grant is a bonus, never a gate); role/phase gating is the policy's,
 * like every op.
 */
export function handleCollect(ctx: OpContext): HandlerResult {
  return { ok: true, state: ctx.room.state, result: {}, changes: [] };
}

/** True when `target` names an item this room holds — its shared contents, or any grant pool. */
function holdsItem(room: Room, target: string): boolean {
  if (getContents(room).some((item) => item.unique === target)) return true;
  return grantRulesOf(room.policy).some((rule) =>
    poolOf(room.state, rule.from).some((item) => item.unique === target),
  );
}

/**
 * react({target, kind}): leave a small signed gesture on something in the room
 * (`doc/spec/room-operation.md` §9.6). Generic to the bone — the engine never learns what a `kind`
 * means, only that it is a short opaque string; what it DOES enforce is the consistency a room can
 * check:
 *
 *   - one reaction per player per target: the same one twice is an idempotent no-op (so a retry off
 *     a lost response is harmless), a DIFFERENT kind on a target you already reacted to is refused
 *     rather than replacing — it is what keeps the ledger from becoming an edit log;
 *   - the ledger's bound, `ops.react.max` (the place boundary already refused anything above
 *     {@link MAX_OP_LEDGER}, so this reads the policy straight rather than clamping per op);
 *   - the target is real: an item `unique` in `contents` or in a grant pool, or a recorded
 *     contributor's DID. Reacting into the void is `gone`, the same code a vanished item gets from
 *     `take` — the client picked the target off a render, so a miss means it left the room.
 *
 * The ledger is append-only ACROSS REMOVALS too, deliberately: nothing prunes an entry when its
 * target leaves the room (`take` drops an item from `contents` outright), so a reaction to a taken
 * item keeps its slot and keeps that `(actor, target)` pair spent. That is the engine's whole
 * story: a reader filters dangling targets at RENDER, and a room type whose contents churn by
 * design (the jar) should weigh that before it declares `ops.react`. A capsule freezes its
 * contents, so it never meets this.
 *
 * The checks run cheapest-first, the convention `handleAdd` sets ("capacity first"): the two O(1)
 * reads answer before the scan over contents and pools, so hammering a full room stays cheap and a
 * reaction to a PLAYER never walks the item side at all. Precedence follows suit: `full` before
 * `gone`, as it already does for `add`.
 *
 * Who may react and when is `ops.react`'s role/phase, gated by the engine before this runs — a room
 * whose policy has no `react` entry (everything placed before this shipped) refuses it as `denied`.
 */
export function handleReact(ctx: OpContext): HandlerResult {
  // The wire schema is the one spelling of what a react's params are; re-checking the fields here
  // by hand is how the boundary and the authority drift apart (`parseIncomingItem` above, likewise).
  const parsed = reactParamsSchema.safeParse(ctx.env.params);
  if (!parsed.success) return paramsRefusal(parsed.error);
  const { target, kind } = parsed.data;

  // Already reacted to this target? Idempotent when it is the same kind, refused when it is another
  // — checked before everything else so a retry stays a no-op even on a full room, or after the
  // target has left.
  const reactions = getReactions(ctx.room.state);
  const mine = reactions.find((r) => r.by === ctx.actor && r.target === target);
  if (mine) {
    if (mine.kind === kind) {
      // Nothing changed, so nothing is written: a double tap answers with the original id off the
      // unchanged room rather than re-persisting it at the room's next version.
      return {
        ok: true,
        state: ctx.room.state,
        result: { reaction: mine.unique },
        changes: [],
        noop: true,
      };
    }
    // `full` for both bounds, per the design decision. The client can tell the two apart without a
    // code of its own — it is rendering the ledger that holds its own reaction — and a new
    // ErrorCode would widen the protocol's shared rejection vocabulary for one op.
    return { ok: false, error: "full", message: "already reacted to this target" };
  }

  if (reactions.length >= (ctx.room.policy.ops[ctx.env.op]?.max ?? MAX_OP_LEDGER)) {
    return { ok: false, error: "full", message: "this room has taken all the reactions it holds" };
  }

  // A DID target answers from the contributor ledger in one lookup; only an item target pays the
  // scan. `hasOwn`, not `in`: `target` is an untrusted string, and `"toString" in {}` is true.
  if (!Object.hasOwn(getContributors(ctx.room.state), target) && !holdsItem(ctx.room, target)) {
    return { ok: false, error: "gone" };
  }

  // The op's nonce is the reaction's id: already a per-op ULID the engine dedupes on, so a replay
  // can't mint a second id for the same gesture. `at` is the engine's clock, never the client's.
  const reaction: Reaction = { unique: ctx.env.nonce, by: ctx.actor, at: ctx.nowSec, target, kind };
  return {
    ok: true,
    state: { ...ctx.room.state, reactions: [...reactions, reaction] },
    result: { reaction: reaction.unique },
    changes: [{ type: "reactionAdded", reaction }],
  };
}

export const READ_ONLY_OPS: ReadonlySet<string> = new Set(["list"]);

/**
 * Ops that write ONLY their own append-only ledger — they feed no `derived` formula and change
 * nothing an object summary shows (count, capacity, phase, media). The engine skips the derived
 * recompute and its delta for these, and the server skips the map upsert: a reaction is the first
 * op a player fires at tap frequency, and without this one tap would fan a no-change
 * `derivedUpdated` out to every room watcher and a byte-identical summary to every map watcher in
 * the cell. Membership is a claim about the handler, so it lives beside the handler table.
 *
 * Narrower than `OP_LEDGER_KEYS` (lifecycle.ts), which registers the ops that keep a ledger at all
 * and is what makes `ops.<op>.max` legal. An op could keep a bounded ledger and still feed a
 * derived formula; it would belong there and not here. Do not fold the two together.
 */
export const LEDGER_ONLY_OPS: ReadonlySet<string> = new Set(["react"]);

/**
 * The room op vocabulary: the platform's, and a game cannot add to it (`markers.ts` in
 * `@beaconsgg/protocol-types`). An entry beyond the baseline is advertised as `op:<name>`.
 */
export const HANDLERS: Record<string, (ctx: OpContext) => HandlerResult> = {
  add: handleAdd,
  take: handleTake,
  list: handleList,
  contribute: handleContribute,
  claim: handleClaim,
  collect: handleCollect,
  react: handleReact,
};
