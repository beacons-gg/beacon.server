/**
 * Challenges, the policy proof: a cooperative challenge in the ladder encoding.
 *
 * Proves the engine expresses a cooperative challenge: member cap, team progress from self-attested
 * claims, a hard deadline, instant settle on completion, and per-member reward grants from an
 * escrow pool. Built on the generic ladder (`../testing`): the engine's suites must not import a
 * game's builder. A shipped game's shape is run as-is in `shipped-policies.test.ts`, and a
 * builder's own naming (step-namespaced keys, pool names) is pinned in that game's suite. The room
 * `type` is a free string the engine never branches on.
 *
 * The load-bearing encoding is the **shrinking settle time**. Formulas cannot see the clock;
 * time enters only through lifecycle transitions, and phases are a strictly ORDERED walk
 * (`effectivePhase` stops at the first unfired timestamp). The one boundary timestamp derives
 * from the team's remaining total deficit:
 *
 *   r<k>Deficit  = max(0, TARGET - sum(contents, KEY))                      (derived, per rung)
 *   unlockAt     = min(DEADLINE, placedAt + totalDeficit * BIG)
 *   phases:        running → settled; contribute gated "running", `collect` UN-phase-gated
 *   grant rung k:  when max(0, 1 − Σ_{j≤k} r<j>Deficit), from the rung's pool, on collect
 *
 * Rungs pay AS THEY LAND: `collect` is the repeatable no-op op whose only effect is the grant
 * machinery — its rung `when`s are the whole gate, so a premature collect succeeds and pays
 * nothing, a mid-ladder collect pays exactly the rungs earned since the last one (per-actor-
 * per-pool idempotency), and a post-deadline collect pays whatever the freeze left complete.
 * (The multi-rung mid-ladder proofs live in grant-rules.test.ts; this suite proves the
 * single-rung flow.)
 *
 * `unlockAt` keeps its name so a settled challenge inherits the capsule sweep — but collect never
 * touches `claimed`, so the sweep reads the GRANT bookkeeping instead: a settled room closes once
 * no contributor could still draw from any pool whose rule passes, with `claimTtl` (measured from
 * settlement, not from `unlockAt`) as the backstop. The three cases are proven below.
 *
 * Progress claims are OpaqueItems of class "Progress": counters ride the unsigned
 * `match.levels` projection (self-attested, radical trust), provenance rides the signed birth.
 * Joining IS the first contribution (a zero-progress claim): it registers the member against
 * `maxContributors` and grants nothing by itself.
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

const CHALLENGE_ID = "chal1@beacon.example";
const PROGRESS_KEY = "progress" as const;
const TARGET = 5;
const WEEK = 7 * 86_400;

const T0_MS = Date.parse("2026-06-29T00:00:00Z");
const T0_SEC = Math.floor(T0_MS / 1000);
const DEADLINE = T0_SEC + WEEK;

/** The rung's escrow pool. */
const POOL = "rewards";

/** A one-rung ladder that admits only progress claims and pays each member two items from `POOL`. */
function challengePolicy(maxContributors: number, deadlineSec: number = DEADLINE): Policy {
  return ladderPolicy({
    rungs: [{ key: PROGRESS_KEY, target: TARGET, pool: POOL, count: 2 }],
    deadlineSec,
    maxContributors,
    accept: { class: ["Progress"] },
    // The "won LONG after placement" case needs a win that lands past the TTL from placement but
    // inside a month-long deadline, so the window is a week.
    claimTtl: "7d",
  });
}

/** A player-signed progress claim: counters ride the unsigned `match.levels`, provenance the birth. */
function progressClaim(
  wallet: ReturnType<typeof createWallet>,
  unique: string,
  levels: Record<string, number>,
): OpaqueItem {
  return token(unique, levels, { cls: "Progress", minter: walletMinter(wallet) });
}

type ClaimPayload = { granted?: OpaqueItem[] };
const grantedOf = (result: OpResult): OpaqueItem[] =>
  result.ok && result.result ? ((result.result as ClaimPayload).granted ?? []) : [];

describe("Challenge policy proof — the engine custodies a ladder encoding", () => {
  let clock: { ms: number };
  let engine: PolicyEngine;
  let alice: ReturnType<typeof createWallet>;
  let bob: ReturnType<typeof createWallet>;
  let carol: ReturnType<typeof createWallet>;
  let dave: ReturnType<typeof createWallet>;

  function op(
    wallet: ReturnType<typeof createWallet>,
    name: string,
    params: Record<string, unknown>,
  ): OpEnvelope {
    return signOpWithWallet(wallet, {
      game: TEST_GAME,
      op: name,
      room: CHALLENGE_ID,
      nonce: nonce(),
      issuedAt: new Date(clock.ms).toISOString(),
      params,
    });
  }

  async function place(maxContributors = 3, deadlineSec: number = DEADLINE): Promise<void> {
    const policy = challengePolicy(maxContributors, deadlineSec);
    // 3 members × rung count 2 = 6 escrowed re-mints in the single step's pool.
    const rewards = [1, 2, 3, 4, 5, 6].map((n) => reward(`rw${n}`));
    await engine.placeRoom({
      game: TEST_GAME,
      id: CHALLENGE_ID,
      type: "challenge",
      location: { lat: 47.61, lng: -122.34 }, // anchored at the organizer
      policy,
      placedBy: alice.account.did,
      mintedBy: roomMintedBy(CHALLENGE_ID, "challenge", policy, alice),
      state: { contents: [], [POOL]: rewards },
    });
  }

  const join = (
    w: ReturnType<typeof createWallet>,
    unique: string,
  ): Promise<{ result: OpResult }> =>
    engine.applyOp(op(w, "contribute", { item: progressClaim(w, unique, {}) })) as Promise<{
      result: OpResult;
    }>;

  const report = (
    w: ReturnType<typeof createWallet>,
    unique: string,
    count: number,
  ): Promise<{ result: OpResult }> =>
    engine.applyOp(
      op(w, "contribute", {
        item: progressClaim(w, unique, { [PROGRESS_KEY]: count }),
      }),
    ) as Promise<{ result: OpResult }>;

  beforeEach(() => {
    clock = { ms: T0_MS };
    engine = new PolicyEngine(new InMemoryStore(), {
      now: () => clock.ms,
      replayWindowMs: Number.MAX_SAFE_INTEGER,
    });
    alice = createWallet();
    bob = createWallet();
    carol = createWallet();
    dave = createWallet();
  });

  it("join is a zero-progress contribution, and the member cap is engine-enforced", async () => {
    await place(3);
    expect((await join(alice, "j-a")).result.ok).toBe(true);
    expect((await join(bob, "j-b")).result.ok).toBe(true);
    expect((await join(carol, "j-c")).result.ok).toBe(true);
    // 4th member: rejected by maxContributors — the cap is real, not etiquette.
    expect((await join(dave, "j-d")).result).toMatchObject({ ok: false, error: "full" });
    // An existing member may keep reporting (join-once, report-often).
    expect((await report(alice, "p-a1", 1)).result.ok).toBe(true);
  });

  it("the accept gate admits only progress claims", async () => {
    await place();
    const memory = token("mem1", { power: 10 }); // an ordinary item, not a progress claim
    const rejected = await engine.applyOp(op(alice, "contribute", { item: memory }));
    expect(rejected.result).toMatchObject({ ok: false, error: "denied" });
  });

  it("completing the target settles the room IMMEDIATELY and collects pay the rung", async () => {
    await place(3);
    await join(alice, "j-a");
    await join(bob, "j-b");
    await join(carol, "j-c");

    await report(alice, "p-a1", 2);
    await report(bob, "p-b1", 2);
    // 4 of 5: a premature collect succeeds but pays nothing (the rung `when` is the gate).
    const premature = (await engine.applyOp(op(alice, "collect", {}))).result;
    expect(premature.ok).toBe(true);
    expect(grantedOf(premature)).toHaveLength(0);

    // Carol's report reaches the target; the derived recompute collapses the settle time.
    clock.ms += 3_600_000; // an hour into the week — well before the deadline
    await report(carol, "p-c1", 1);

    // The rung pays NOW, not at the deadline: each member draws their count from the pool once.
    const aliceCollect = (await engine.applyOp(op(alice, "collect", {}))).result;
    expect(aliceCollect.ok).toBe(true);
    expect(grantedOf(aliceCollect)).toHaveLength(2);
    expect(grantedOf(aliceCollect).every((it) => it.owner === alice.account.did)).toBe(true);

    // Per-pool idempotent: a repeat collect succeeds and draws nothing more.
    const repeat = (await engine.applyOp(op(alice, "collect", {}))).result;
    expect(repeat.ok).toBe(true);
    expect(grantedOf(repeat)).toHaveLength(0);
    // A non-member cannot collect (role contributor).
    expect((await engine.applyOp(op(dave, "collect", {}))).result.ok).toBe(false);

    // The other members draw their own bundles from the shared pool.
    expect(grantedOf((await engine.applyOp(op(bob, "collect", {}))).result)).toHaveLength(2);
    expect(grantedOf((await engine.applyOp(op(carol, "collect", {}))).result)).toHaveLength(2);
  });

  it("an incomplete challenge dies at the deadline: no late progress, no payout", async () => {
    await place(3);
    await join(alice, "j-a");
    await join(bob, "j-b");
    await report(alice, "p-a1", 2); // 2 of 5 — short of the target

    clock.ms = (DEADLINE + 60) * 1000; // one minute past the deadline

    // The room settled: contribute (gated on "running") is rejected, so a late report cannot
    // zero the deficit and steal a win…
    expect((await report(bob, "p-late", 3)).result.ok).toBe(false);
    // …and a collect still succeeds but the rung's `when` sees the deficit: a failed
    // challenge pays nothing, engine-enforced.
    const collect = (await engine.applyOp(op(alice, "collect", {}))).result;
    expect(collect.ok).toBe(true);
    expect(grantedOf(collect)).toHaveLength(0);
  });

  it("a challenge won LONG after placement keeps its escrow until the claim window really starts", async () => {
    // The regression: winning collapses `unlockAt` to `placedAt` — that IS how a finished ladder
    // settles early — so a claim window measured from `unlockAt` is already spent the moment the
    // win registers, and the sweep deletes the room (with every escrowed reward in it) before a
    // single member can collect. Collect is a manual tap on the detail page; there is no race to
    // win. The window has to start when the room ENTERS `settled`.
    // A month-long challenge — both create surfaces allow up to a year.
    await place(3, T0_SEC + 30 * 86_400);
    await join(alice, "j-a");
    await join(bob, "j-b");

    // Win it on day 10: inside the deadline, but well past the claim TTL from PLACEMENT (7d).
    clock.ms = T0_MS + 10 * 86_400 * 1000;
    await report(alice, "p-a1", TARGET);

    // First tick: the room settles. It must NOT be closed in the same breath.
    const settle = await engine.advancePhase(CHALLENGE_ID, clock.ms);
    expect(settle.closed).toBe(false);
    expect(settle.room?.state["phase"]).toBe("settled");
    expect(settle.room?.state["settledAt"]).toBe(Math.floor(clock.ms / 1000));

    // A member can still collect what the ladder paid.
    const collect = (await engine.applyOp(op(bob, "collect", {}))).result;
    expect(collect.ok).toBe(true);
    expect(grantedOf(collect)).toHaveLength(2);

    // And the window runs from the WIN, not from placement.
    clock.ms += 6 * 86_400 * 1000; // 6 days after settling — still inside the 7d TTL
    expect((await engine.advancePhase(CHALLENGE_ID, clock.ms)).closed).toBe(false);
  });

  it("closes as soon as it owes nobody anything — `collect` never writes `claimed`", async () => {
    // Found in a playtest: a finished challenge sat in the operator console for days. The capsule
    // fast-close reads the `claimed` ledger, which the repeatable `collect` op never writes, so a
    // fully-paid challenge could only close by timing out.
    await place(3);
    await join(alice, "j-a");
    await join(bob, "j-b");

    clock.ms = T0_MS + 60_000;
    await report(alice, "p-a1", TARGET); // won
    await engine.advancePhase(CHALLENGE_ID, clock.ms); // settle (stamps settledAt)

    // One member collects: the other is still owed, so the room stays.
    expect(grantedOf((await engine.applyOp(op(alice, "collect", {}))).result)).toHaveLength(2);
    expect((await engine.advancePhase(CHALLENGE_ID, clock.ms)).closed).toBe(false);

    // The last member collects → nothing outstanding → the next tick closes it, days early.
    expect(grantedOf((await engine.applyOp(op(bob, "collect", {}))).result)).toHaveLength(2);
    const swept = await engine.advancePhase(CHALLENGE_ID, clock.ms);
    expect(swept.closed).toBe(true);
    expect(swept.changes).toEqual([{ type: "closed" }]);
  });

  it("a challenge that RAN OUT closes once its landed rungs are collected, not its unreachable ones", async () => {
    // The other half of the same report ("may only happen if the challenge didn't fill up"): a
    // rung the team never reached is owed to nobody, so it must not hold the room open.
    await place(3);
    await join(alice, "j-a");
    await report(alice, "p-a1", 2); // 2 of 5 — the ladder never lands

    clock.ms = (DEADLINE + 60) * 1000;
    await engine.advancePhase(CHALLENGE_ID, clock.ms); // settles at the deadline
    // Alice collects and is paid nothing (the rung's `when` sees the deficit).
    expect(grantedOf((await engine.applyOp(op(alice, "collect", {}))).result)).toHaveLength(0);
    // Nothing is owed to anyone, so the room goes rather than lingering for the whole TTL.
    expect((await engine.advancePhase(CHALLENGE_ID, clock.ms)).closed).toBe(true);
  });

  it("the derived state stays inside the safe-integer profile at every stage", async () => {
    await place(3);
    await join(alice, "j-a");
    const room = await engine.resolveRoom(CHALLENGE_ID);
    // Incomplete: the settle time holds at the configured deadline; the live deficit broadcasts.
    expect(room?.state["r1Deficit"]).toBe(TARGET);
    expect(room?.state["unlockAt"]).toBe(DEADLINE);
    expect(Number.isSafeInteger(room?.state["unlockAt"] as number)).toBe(true);
  });
});
