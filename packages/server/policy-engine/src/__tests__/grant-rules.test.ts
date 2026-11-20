/**
 * Grant rules (`doc/spec/room-operation.md` §9.6): `grant` as an ARRAY of rules, each with its own
 * pool, per-actor-per-pool idempotency, and an optional `when` condition evaluated over the post-op
 * recomputed state (a number >= 1 passes, and a comparison's boolean counts as 1 or 0).
 *
 * The end-to-end suite runs the shared two-rung ladder (`../testing`'s `ladderPolicy`, the shape a
 * game's multi-step challenge takes): two ordered steps as a `when` ladder over per-step derived
 * deficits, two phases (`running → settled` on `unlockAt = min(DEADLINE, placedAt + totalDeficit*BIG)`) —
 * and proves the three behaviors that make it a ladder:
 *
 *   - a full early win pays every rung in ONE claim (and settles the room immediately),
 *   - a deadline that catches the team mid-ladder pays exactly the rungs already complete,
 *   - step-2 progress without step 1 pays NOTHING (the cumulative `when` enforces order
 *     server-side, whatever a client reports).
 *
 * Single-rule policies (every capsule, stage-3 challenges) are untouched — their suites are the
 * regression proof; `applyGrant`'s legacy-state normalization is unit-tested here.
 */
import { createWallet, signOpWithWallet, walletMinter } from "@beaconsgg/identity";
import type { OpaqueItem, OpEnvelope, OpResult, Policy } from "@beaconsgg/protocol-types";
import { beforeEach, describe, expect, it } from "vitest";
import { PolicyEngine } from "../index";
import {
  InMemoryStore,
  ladderPolicy,
  nonce,
  reward,
  roomMintedBy,
  token,
  TEST_GAME,
} from "../testing";
import { applyGrant, grantConditionPasses, grantedPools, grantsOutstanding } from "../lifecycle";

const ROOM_ID = "chal2@beacon.example";
const S1_EVENT = "step1";
const S2_EVENT = "step2";
const S1_TARGET = 2;
const S2_TARGET = 3;
const BIG = 1_000_000_000;
const WEEK = 7 * 86_400;

const T0_MS = Date.parse("2026-06-29T00:00:00Z");
const DEADLINE = Math.floor(T0_MS / 1000) + WEEK;

/**
 * The two-rung ladder under test: rung 1 pays 1 from `rewards1`, rung 2 pays 2 from `rewards2`, each
 * once every rung below it is met. Rungs pay on `claim` once the room settles, or on the repeatable
 * `collect` (the spelling a challenge builder ships).
 */
function twoStepPolicy(payOp: "claim" | "collect" = "claim"): Policy {
  return ladderPolicy({
    rungs: [
      { key: S1_EVENT, target: S1_TARGET, pool: "rewards1" },
      { key: S2_EVENT, target: S2_TARGET, pool: "rewards2", count: 2 },
    ],
    deadlineSec: DEADLINE,
    claimTtl: "7d",
    payOp,
    accept: { class: ["Progress"] },
    maxContributors: 2,
  });
}

type ClaimPayload = { granted?: OpaqueItem[] };
const grantedOf = (result: OpResult): OpaqueItem[] =>
  result.ok && result.result ? ((result.result as ClaimPayload).granted ?? []) : [];

describe("grant rules as a when-gated ladder (the multi-step engine change)", () => {
  let clock: { ms: number };
  let engine: PolicyEngine;
  let alice: ReturnType<typeof createWallet>;
  let bob: ReturnType<typeof createWallet>;

  function op(
    wallet: ReturnType<typeof createWallet>,
    name: string,
    params: Record<string, unknown>,
  ): OpEnvelope {
    return signOpWithWallet(wallet, {
      game: TEST_GAME,
      op: name,
      room: ROOM_ID,
      nonce: nonce(),
      issuedAt: new Date(clock.ms).toISOString(),
      params,
    });
  }

  async function place(policy = twoStepPolicy()): Promise<void> {
    await engine.placeRoom({
      game: TEST_GAME,
      id: ROOM_ID,
      type: "challenge",
      location: { lat: 47.61, lng: -122.34 },
      policy,
      placedBy: alice.account.did,
      mintedBy: roomMintedBy(ROOM_ID, "challenge", policy, alice),
      state: {
        contents: [],
        // 2 members: step 1 pays 1 each (pool of 2), step 2 pays 2 each (pool of 4).
        rewards1: [reward("s1a"), reward("s1b")],
        rewards2: [reward("s2a"), reward("s2b"), reward("s2c"), reward("s2d")],
      },
    });
  }

  const progress = (
    w: ReturnType<typeof createWallet>,
    unique: string,
    levels: Record<string, number>,
  ): Promise<{ result: OpResult }> =>
    engine.applyOp(
      op(w, "contribute", {
        // A player-signed progress item: the class the policy's `accept` admits, its counters as levels.
        item: token(unique, levels, { cls: "Progress", minter: walletMinter(w) }),
      }),
    ) as Promise<{ result: OpResult }>;

  const claim = async (w: ReturnType<typeof createWallet>): Promise<OpResult> =>
    (await engine.applyOp(op(w, "claim", {}))).result;

  beforeEach(() => {
    clock = { ms: T0_MS };
    engine = new PolicyEngine(new InMemoryStore(), {
      now: () => clock.ms,
      replayWindowMs: Number.MAX_SAFE_INTEGER,
    });
    alice = createWallet();
    bob = createWallet();
  });

  it("a full early win settles immediately and ONE claim pays every rung", async () => {
    await place();
    await progress(alice, "j-a", {});
    await progress(bob, "j-b", {});
    await progress(alice, "p-a1", { [S1_EVENT]: S1_TARGET });
    await progress(bob, "p-b1", { [S2_EVENT]: S2_TARGET });

    // Both deficits are zero → unlockAt collapsed to placedAt → settled NOW, weeks early.
    expect((await progress(alice, "p-late", { [S1_EVENT]: 1 })).result.ok).toBe(false);

    const paid = await claim(alice);
    expect(paid.ok).toBe(true);
    const items = grantedOf(paid);
    expect(items).toHaveLength(3); // rung 1 pays 1 + rung 2 pays 2, in one op
    expect(items.every((it) => it.owner === alice.account.did)).toBe(true);

    // Per-pool tracking recorded both rungs; the claim handler makes a second claim `gone`.
    const room = await engine.resolveRoom(ROOM_ID);
    const pools = grantedPools(
      (room?.state["granted"] as Record<string, never>)?.[alice.account.did],
      "rewards1",
    );
    expect(Object.keys(pools).sort()).toEqual(["rewards1", "rewards2"]);
    expect((await claim(alice)).ok).toBe(false);

    // The other member draws their own bundles from the same pools.
    expect(grantedOf(await claim(bob))).toHaveLength(3);
  });

  it("a deadline mid-ladder pays exactly the rungs already complete", async () => {
    await place();
    await progress(alice, "j-a", {});
    await progress(alice, "p-a1", { [S1_EVENT]: S1_TARGET }); // step 1 done, step 2 untouched

    clock.ms = (DEADLINE + 60) * 1000;

    // Settled by the deadline: no late progress…
    expect((await progress(alice, "p-late", { [S2_EVENT]: S2_TARGET })).result.ok).toBe(false);
    // …and the claim pays rung 1 only (rung 2's cumulative `when` still sees a deficit).
    const paid = await claim(alice);
    expect(paid.ok).toBe(true);
    expect(grantedOf(paid)).toHaveLength(1);
  });

  it("step-2 progress without step 1 pays NOTHING — order is server-enforced", async () => {
    await place();
    await progress(alice, "j-a", {});
    await progress(alice, "p-a1", { [S2_EVENT]: S2_TARGET }); // banked ahead, step 1 skipped

    clock.ms = (DEADLINE + 60) * 1000;

    const paid = await claim(alice);
    expect(paid.ok).toBe(true); // the op succeeds (a grant is a bonus, never a gate)…
    expect(grantedOf(paid)).toHaveLength(0); // …but no rung's cumulative condition passes
  });

  it("a `when` that throws at runtime skips the rule instead of failing the op", async () => {
    const policy = twoStepPolicy();
    // Structurally valid for the profile, but overflows the safe-integer guard when evaluated.
    (policy.grant as { when?: unknown }[])[0]!.when = {
      "*": [{ "*": [BIG, BIG] }, BIG],
    };
    await place(policy);
    await progress(alice, "j-a", {});
    await progress(alice, "p-a1", { [S1_EVENT]: S1_TARGET, [S2_EVENT]: S2_TARGET });

    const paid = await claim(alice);
    expect(paid.ok).toBe(true);
    expect(grantedOf(paid)).toHaveLength(2); // rung 2 pays; the throwing rung 1 just doesn't
  });

  it("collect pays each rung AS IT LANDS — repeatable, mid-ladder, idempotent per pool", async () => {
    // The spelling a challenge builder ships: rungs pay on the un-phase-gated, no-op `collect`.
    const policy = twoStepPolicy("collect");
    await place(policy);
    await progress(alice, "j-a", {});

    // Nothing earned yet: collect succeeds (a grant is a bonus) and pays nothing.
    const early = (await engine.applyOp(op(alice, "collect", {}))).result;
    expect(early.ok).toBe(true);
    expect(grantedOf(early)).toHaveLength(0);

    // Step 1 lands → collect pays rung 1 immediately, mid-ladder, while contribute stays open.
    await progress(alice, "p-a1", { [S1_EVENT]: S1_TARGET });
    const rung1 = (await engine.applyOp(op(alice, "collect", {}))).result;
    expect(grantedOf(rung1)).toHaveLength(1);
    // A second collect grants nothing more (per-pool idempotency), but never fails the op.
    expect(grantedOf((await engine.applyOp(op(alice, "collect", {}))).result)).toHaveLength(0);
    expect((await progress(alice, "p-a2", { [S2_EVENT]: 1 })).result.ok).toBe(true);

    // Step 2 lands (settling the room) → a fresh collect pays exactly rung 2.
    await progress(alice, "p-a3", { [S2_EVENT]: S2_TARGET - 1 });
    const rung2 = (await engine.applyOp(op(alice, "collect", {}))).result;
    expect(grantedOf(rung2)).toHaveLength(2); // rung 2's count — rung 1 already drawn
    // A non-member never collects (role contributor).
    expect((await engine.applyOp(op(bob, "collect", {}))).result.ok).toBe(false);
  });

  it("a WON collect ladder is swept once it owes nobody — collect never closes, the sweep does", async () => {
    // The stage-0 finding was "lost challenges linger in ended". `collect` never touches `claimed`
    // (unlike the legacy terminal `claim`, whose all-claimed path closes the room itself), so the
    // sweep reads the GRANT bookkeeping instead: once every contributor has drawn every pool whose
    // rule passes, the room has nothing left to be open for. This pins that for the WIN path.
    const policy = twoStepPolicy("collect");
    await place(policy);
    await progress(alice, "j-a", {});
    await progress(alice, "p-a1", { [S1_EVENT]: S1_TARGET, [S2_EVENT]: S2_TARGET });

    // Won → unlockAt collapsed to placedAt → effectively settled now; the sweep records the
    // transition without closing (the collect window is open).
    clock.ms += 3_600_000;
    const settled = await engine.advancePhase(ROOM_ID);
    expect(settled.closed).toBe(false);
    expect(settled.changes).toContainEqual({ type: "phaseChanged", phase: "settled" });

    // A member draws every rung, and the room survives the op itself (collect never closes).
    const paid = (await engine.applyOp(op(alice, "collect", {}))).result;
    expect(grantedOf(paid)).toHaveLength(3);
    expect(await engine.resolveRoom(ROOM_ID)).toBeDefined();

    // The sole member has now been paid everything the ladder can pay, so the very next tick
    // sweeps it — no waiting out the claimTtl, which is only the backstop for a member who never
    // comes to collect.
    expect(clock.ms).toBeLessThan(T0_MS + WEEK * 1000); // still well inside the window
    expect((await engine.advancePhase(ROOM_ID)).closed).toBe(true);
    expect(await engine.resolveRoom(ROOM_ID)).toBeUndefined();
  });

  it("a DEAD ladder is swept the moment it settles — failed rooms don't linger", async () => {
    await place();
    await progress(alice, "j-a", {});
    await progress(alice, "p-a1", { [S1_EVENT]: 1 }); // short of step 1 — the run fails

    // Settled at the deadline. The first tick records the transition without closing — a room is
    // never deleted before its watchers have seen it settle (and that stamp anchors the TTL).
    clock.ms = (DEADLINE + 60) * 1000;
    expect((await engine.advancePhase(ROOM_ID)).closed).toBe(false);

    // The rung never landed, so its `when` owes nobody anything — the very next tick sweeps it,
    // without waiting out the claimTtl. This is the failed-run half of "challenges don't linger":
    // a challenge that ran out of time and paid nothing has nothing to stay open for.
    expect((await engine.advancePhase(ROOM_ID)).closed).toBe(true);
    expect(await engine.resolveRoom(ROOM_ID)).toBeUndefined();
  });

  it("applyGrant pays what a short pool has left, and the draw still consumes the actor's turn", () => {
    const rule = { op: "claim", from: "rewards", count: 2 };
    // One free item beside one already-owned: the draw takes up to `count` of the FREE ones.
    const state = { rewards: [reward("r1"), { ...reward("r2"), owner: "did:key:zEarlier" }] };
    const out = applyGrant(state, rule, "did:key:zA" as never);
    expect(out?.granted).toHaveLength(1);
    expect(out?.granted[0]?.owner).toBe("did:key:zA");
    // Consumed per pool even though the count wasn't met — a later restock never double-pays.
    expect(applyGrant(out!.state, rule, "did:key:zA" as never)).toBeUndefined();
  });

  it("draws the FIRST free items in pool order — the contract an interleaved multi-reward pool relies on", () => {
    // A game client seeds a step's pool member-slot-major (interleaving its reward runs) BECAUSE
    // this draw is first-N of the un-granted items: two rewards laid run-after-run ([t1a, t1b, t2a,
    // t2b]) would pay a member two copies of ONE reward (the playtest bug). Interleaved, every
    // member's draw crosses one copy of each, in any collect order.
    const rule = { op: "collect", from: "step1Rewards", count: 2 };
    const state = {
      step1Rewards: [reward("t1-a"), reward("t2-a"), reward("t1-b"), reward("t2-b")],
    };
    const first = applyGrant(state, rule, "did:key:zA" as never);
    expect(first?.granted.map((it) => it.unique)).toEqual(["t1-a", "t2-a"]);
    const second = applyGrant(first!.state, rule, "did:key:zB" as never);
    expect(second?.granted.map((it) => it.unique)).toEqual(["t1-b", "t2-b"]);
  });

  it("rejects a policy whose grant rule draws from a reserved state key", async () => {
    const policy = twoStepPolicy();
    (policy.grant as { from: string }[])[0]!.from = "contributors"; // would forge the ledger
    await expect(place(policy)).rejects.toThrow(/reserved state key/);
  });

  it("applyGrant's when gate: >= 1 passes, below refuses, a throw refuses", () => {
    const state = { rewards: [reward("r1")], step1Deficit: 1 };
    const base = { op: "claim", from: "rewards", count: 1 };
    const rung = { ...base, when: { max: [0, { "-": [1, { var: "step1Deficit" }] }] } };
    expect(applyGrant(state, rung, "did:key:zA" as never)).toBeUndefined(); // deficit 1 → 0 < 1
    const met = applyGrant({ ...state, step1Deficit: 0 }, rung, "did:key:zA" as never);
    expect(met?.granted).toHaveLength(1);
    const throwing = { ...base, when: { "*": [{ "*": [BIG, BIG] }, BIG] } }; // overflows the guard
    expect(
      applyGrant({ ...state, step1Deficit: 0 }, throwing, "did:key:zA" as never),
    ).toBeUndefined();
  });

  it("a comparison `when` pays when true and not when false (beacon.server#78)", () => {
    const state = { rewards: [reward("r1")], step1Deficit: 1 };
    const base = { op: "claim", from: "rewards", count: 1 };
    const rung = { ...base, when: { "<=": [{ var: "step1Deficit" }, 0] } };
    expect(applyGrant(state, rung, "did:key:zA" as never)).toBeUndefined();
    const met = applyGrant({ ...state, step1Deficit: 0 }, rung, "did:key:zA" as never);
    expect(met?.granted).toHaveLength(1);
  });

  it("grantConditionPasses reads numbers by threshold and booleans as 1 or 0", () => {
    const state = { score: 12, none: 0 };
    expect(grantConditionPasses(undefined, state)).toBe(true);
    expect(grantConditionPasses({ var: "score" }, state)).toBe(true);
    expect(grantConditionPasses({ var: "none" }, state)).toBe(false);
    expect(grantConditionPasses({ ">=": [{ var: "score" }, 10] }, state)).toBe(true);
    expect(grantConditionPasses({ ">=": [{ var: "score" }, 20] }, state)).toBe(false);
    expect(grantConditionPasses({ "!": [{ var: "none" }] }, state)).toBe(true);
    expect(
      grantConditionPasses(
        { and: [{ ">": [{ var: "score" }, 1] }, { "==": [{ var: "none" }, 0] }] },
        state,
      ),
    ).toBe(true);
    // Not a number or a boolean, an unsafe integer, and a throw all refuse.
    expect(grantConditionPasses({ var: "missing" }, state)).toBe(false);
    expect(grantConditionPasses({ "*": [{ "*": [BIG, BIG] }, BIG] }, state)).toBe(false);
    expect(grantConditionPasses({ "/": [4, 2] }, state)).toBe(false); // off-profile throws
  });

  it("grantsOutstanding owes a rung whose comparison is true, and none whose comparison is false", () => {
    const policy = {
      ...twoStepPolicy("collect"),
      grant: [{ op: "collect", from: "rewards", count: 1, when: { ">=": [{ var: "score" }, 10] } }],
    } as Policy;
    const state = {
      rewards: [reward("r1")],
      contributors: { "did:key:zA": ["j-a"] },
      score: 10,
    };
    expect(grantsOutstanding(policy, state)).toBe(true);
    expect(grantsOutstanding(policy, { ...state, score: 9 })).toBe(false);
  });

  it("a ladder written as comparisons pays each rung through the engine", async () => {
    const policy = twoStepPolicy("collect");
    // The same ladder an author writes without the clamp: "step 1 done" as a comparison.
    (policy.grant as { when?: unknown }[])[0]!.when = { "<=": [{ var: "r1Deficit" }, 0] };
    (policy.grant as { when?: unknown }[])[1]!.when = {
      "<=": [{ "+": [{ var: "r1Deficit" }, { var: "r2Deficit" }] }, 0],
    };
    await place(policy);
    await progress(alice, "j-a", {});
    expect(grantedOf((await engine.applyOp(op(alice, "collect", {}))).result)).toHaveLength(0);

    await progress(alice, "p-a1", { [S1_EVENT]: S1_TARGET });
    expect(grantedOf((await engine.applyOp(op(alice, "collect", {}))).result)).toHaveLength(1);

    await progress(alice, "p-a2", { [S2_EVENT]: S2_TARGET });
    expect(grantedOf((await engine.applyOp(op(alice, "collect", {}))).result)).toHaveLength(2);
  });

  it("applyGrant normalizes a legacy flat granted entry as that rule's consumed pool", () => {
    const rule = { op: "claim", from: "rewards", count: 1 };
    const state = {
      rewards: [reward("r1")],
      granted: { "did:key:zLegacy": ["old1"] }, // the pre-array shape
    };
    // Legacy actor: already consumed for this pool.
    expect(applyGrant(state, rule, "did:key:zLegacy" as never)).toBeUndefined();
    // A different actor draws normally, and the write uses the per-pool shape.
    const fresh = applyGrant(state, rule, "did:key:zFresh" as never);
    expect(fresh?.granted).toHaveLength(1);
    expect(fresh?.state["granted"]).toMatchObject({
      "did:key:zLegacy": ["old1"],
      "did:key:zFresh": { rewards: ["r1"] },
    });
  });

  it("grantedPools reads both stored shapes", () => {
    expect(grantedPools(undefined, "rewards")).toEqual({});
    expect(grantedPools(["a"], "rewards")).toEqual({ rewards: ["a"] });
    expect(grantedPools({ pool2: ["b"] }, "rewards")).toEqual({ pool2: ["b"] });
  });
});
