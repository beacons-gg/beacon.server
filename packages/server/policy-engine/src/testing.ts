/**
 * `@beaconsgg/policy-engine/testing`: generic policies and signed items for tests of the engine and
 * of anything built on it.
 *
 * No game nouns and no game builder. A test built on these proves the ENGINE, which is also why the
 * server's suites need no game package. It is also how an engine assumption gets caught at all:
 * tested only against one game's shapes, a game-specific name such as the old `capsuleShouldClose`,
 * or a bug in which time anchors an unlock, goes unnoticed.
 *
 * Three shapes, each small enough to read in one sitting, and each with the options the suites need:
 * - {@link bagPolicy}: public add / take / list, closing when emptied.
 * - {@link timedPotPolicy}: a three-phase lifecycle whose windows can move with what is contributed.
 * - {@link ladderPolicy}: rungs of targets, each paying from its own pool, with an early-settle deadline.
 *
 * Published as a subpath, like `@beaconsgg/identity/conformance`, so the server app's suites share these
 * rather than keeping a drifting copy. Not imported by anything outside tests.
 *
 * {@link InMemoryStore} lives here too: the engine's own suites run on it, and no server can.
 */
import {
  accountMinter,
  createAccount,
  signRoomProvenance,
  signItemProvenance,
  walletMinter,
  type Minter,
  type Wallet,
} from "@beaconsgg/identity";
import {
  parseGlobalId,
  type AcceptPredicate,
  type GrantRule,
  type MintedBy,
  type OpaqueItem,
  type OpResult,
  type Policy,
} from "@beaconsgg/protocol-types";

export { InMemoryStore } from "./memory-store";

const DAY = 86_400;

/**
 * The game the engine's suites place and act as. Every room belongs to the game that placed it, and
 * only that game's ops apply unless the policy opens one (`doc/spec/room-operation.md` §8.2).
 */
export const TEST_GAME = "test-game";

const CROCK = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
let nonceCounter = 0;
/** A fresh valid ULID-shaped nonce (Crockford base32, 26 chars). */
export function nonce(): string {
  nonceCounter += 1;
  let n = nonceCounter;
  let out = "";
  while (n > 0) {
    out = CROCK[n % 32] + out;
    n = Math.floor(n / 32);
  }
  return out.padStart(26, "0");
}

/** The default item minter: add/contribute and reward pools require verified `mintedBy` provenance. */
const MINTER = createAccount();

/**
 * A container `mintedBy` that verifies against the room's birth set {unique, kind, policy} AND is signed
 * by the placer (first-party mint): sign as `placer` over the same `policy` the room is built with.
 */
export function roomMintedBy(id: string, type: string, policy: Policy, placer: Wallet): MintedBy {
  return signRoomProvenance(
    { unique: parseGlobalId(id).unique, kind: type, policy },
    walletMinter(placer),
  );
}

/**
 * A pre-minted, signed reward-pool item (`owner: null` = not yet granted to anyone). `minter` signs
 * it, {@link MINTER} unless a test needs a player to have escrowed it.
 */
export function reward(
  unique: string,
  { minter = accountMinter(MINTER) }: { minter?: Minter } = {},
): OpaqueItem {
  const birth = { class: "Prize", baseLevels: { hue: 200 } };
  return { unique, birth, owner: null, mintedBy: signItemProvenance({ unique, birth }, minter) };
}

/**
 * A signed item whose `match.levels` are what the policies' formulas sum. `cls` and `tags` are what an
 * `accept` gate reads; `minter` signs it, {@link MINTER} unless a test needs a player to have made it.
 */
export function token(
  unique: string,
  levels: Record<string, number> = {},
  {
    cls = "Token",
    tags,
    minter = accountMinter(MINTER),
  }: { cls?: string; tags?: Record<string, string[]>; minter?: Minter } = {},
): OpaqueItem {
  const birth = { class: cls };
  return {
    unique,
    birth,
    match: { class: cls, levels, ...(tags ? { tags } : {}) },
    mintedBy: signItemProvenance({ unique, birth }, minter),
  };
}

/**
 * The items an op's grant rules paid, `[]` when it paid nothing. Throws on a refused op, so a test
 * asserting "nothing more to pay" cannot pass on a refusal.
 */
export function grantedOf(result: OpResult): OpaqueItem[] {
  if (!result.ok) throw new Error(`op refused: ${result.error}`);
  return (result.result as { granted?: OpaqueItem[] } | undefined)?.granted ?? [];
}

/** A **bag**: anyone adds, takes and lists, optionally gated by an accept predicate; it closes when emptied. */
export function bagPolicy(options: { capacity?: number; accept?: AcceptPredicate } = {}): Policy {
  const accept: AcceptPredicate = { ...options.accept };
  if (options.capacity !== undefined) accept.capacity = options.capacity;
  return {
    type: "bag",
    ops: { add: { role: "public" }, take: { role: "public" }, list: { role: "public" } },
    onEmpty: "close",
    ...(Object.keys(accept).length > 0 ? { accept } : {}),
  };
}

/** One window of a {@link timedPotPolicy} that moves with what is contributed. */
export interface PotShift {
  /** The `match.levels` key summed across contents. */
  key: string;
  /** Seconds the window moves per unit of that sum (negative = sooner). */
  per: number;
  /** The narrowest the window may get, however much is contributed: a `max` floor in the formula. */
  floorSec?: number;
}

/**
 * A **timed pot**: anyone contributes while it fills, it locks `lockDelaySec` after placement, and it
 * opens `unlockDelaySec` after that for contributors to claim. It closes once every contributor has
 * claimed, or when its claim window ends.
 *
 * Fixed windows by default. `lockShift` / `unlockShift` make a window move with a sum over contents,
 * the contended recompute a contribution triggers, with an optional floor so a large contribution can
 * narrow a window but never collapse it.
 */
export function timedPotPolicy(options: {
  lockDelaySec: number;
  unlockDelaySec: number;
  claimTtl?: string;
  lockShift?: PotShift;
  unlockShift?: PotShift;
  maxContributors?: number;
  grant?: GrantRule | GrantRule[];
  /** Adds a contributors-only `react` op. */
  react?: boolean;
}): Policy {
  const window = (from: unknown, delay: number, shift: PotShift | undefined): unknown => {
    if (!shift) return { "+": [from, delay] };
    const moved = {
      "+": [from, delay, { "*": [{ sum: [{ var: "contents" }, shift.key] }, shift.per] }],
    };
    return shift.floorSec === undefined ? moved : { max: [{ "+": [from, shift.floorSec] }, moved] };
  };
  const policy: Policy = {
    type: "pot",
    ops: {
      contribute: { role: "public", phase: "filling" },
      claim: { role: "contributor", phase: "open" },
      ...(options.react ? { react: { role: "contributor" as const } } : {}),
    },
    lifecycle: {
      phases: ["filling", "locked", "open"],
      transitions: { locked: "lockAt", open: "unlockAt" },
    },
    derived: {
      lockAt: window({ var: "placedAt" }, options.lockDelaySec, options.lockShift),
      unlockAt: window({ var: "lockAt" }, options.unlockDelaySec, options.unlockShift),
    },
    onEmpty: "close",
  };
  if (options.claimTtl !== undefined) policy.claimTtl = options.claimTtl;
  if (options.maxContributors !== undefined) policy.maxContributors = options.maxContributors;
  if (options.grant) policy.grant = options.grant;
  return policy;
}

/** One rung of a {@link ladderPolicy}: a target summed over `key`, paying `count` from `pool`. */
export interface LadderRung {
  key: string;
  target: number;
  pool: string;
  count?: number;
}

/** Any span a ladder's deadline can take is shorter than this, so an unmet target never settles it. */
const LADDER_BIG = 400 * DAY;

/**
 * A **ladder**: members contribute toward each rung's target, and each member may take a rung's pay
 * once that rung and every rung below it are met (a cumulative `when`, so order is enforced
 * server-side). One rung by default: `target` summed over `hue`, paying one item from `pool`.
 *
 * Formulas cannot see the clock, so the settle time derives from the remaining deficit:
 * `unlockAt = min(deadline, placedAt + totalDeficit × BIG)`. Meeting every target collapses
 * `unlockAt` to `placedAt`, so a ladder that is won settles AFTER its own `unlockAt`, by construction.
 */
export function ladderPolicy(options: {
  deadlineSec: number;
  claimTtl?: string;
  target?: number;
  rungs?: readonly LadderRung[];
  /** The op that pays a rung: a repeatable `collect` (default), or `claim` in the settled phase. */
  payOp?: "collect" | "claim";
  accept?: AcceptPredicate;
  maxContributors?: number;
}): Policy {
  const rungs = options.rungs ?? [{ key: "hue", target: options.target ?? 1, pool: "pool" }];
  const deficit = (i: number) => `r${i + 1}Deficit`;
  const upTo = (i: number): unknown =>
    i === 0
      ? { var: deficit(0) }
      : { "+": rungs.slice(0, i + 1).map((_, j) => ({ var: deficit(j) })) };
  const payOp = options.payOp ?? "collect";
  const policy: Policy = {
    type: "ladder",
    ops: {
      contribute: { role: "public", phase: "running" },
      [payOp]:
        payOp === "claim" ? { role: "contributor", phase: "settled" } : { role: "contributor" },
    },
    lifecycle: { phases: ["running", "settled"], transitions: { settled: "unlockAt" } },
    derived: {
      ...Object.fromEntries(
        rungs.map((rung, i) => [
          deficit(i),
          { max: [0, { "-": [rung.target, { sum: [{ var: "contents" }, rung.key] }] }] },
        ]),
      ),
      unlockAt: {
        min: [
          options.deadlineSec,
          { "+": [{ var: "placedAt" }, { "*": [upTo(rungs.length - 1), LADDER_BIG] }] },
        ],
      },
    },
    grant: rungs.map((rung, i) => ({
      op: payOp,
      from: rung.pool,
      count: rung.count ?? 1,
      when: { max: [0, { "-": [1, upTo(i)] }] },
    })),
    onEmpty: "close",
  };
  if (options.claimTtl !== undefined) policy.claimTtl = options.claimTtl;
  if (options.accept) policy.accept = options.accept;
  if (options.maxContributors !== undefined) policy.maxContributors = options.maxContributors;
  return policy;
}
