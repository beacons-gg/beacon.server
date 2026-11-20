/**
 * Policies a game shipped, frozen as JSON and run end to end. The files carry an example game's
 * name, `kites`.
 *
 * A placed room keeps the policy it was signed with, so the engine has to keep running a shipped
 * shape for as long as rooms placed with it can exist, whatever the game's builders write next.
 * That is why these are files rather than builder calls: the engine's suites must not import a
 * game's package, and a snapshot cannot drift under a test the way a builder can. Each is one
 * configuration of what the builders wrote on the date in its name, generated with the call the
 * game's app makes (see `shipped/README.md`). Add a file when a new shape ships; never rewrite one.
 * Older rooms differ in ways these do not cover, and `stored-rooms.test.ts` runs them as whole
 * stored rooms.
 *
 * The generic engine behaviour lives in the other suites, on `../testing`'s policies. These prove only
 * that the real shapes still place and still play.
 */
import { createWallet, signOpWithWallet, walletMinter, type Wallet } from "@beaconsgg/identity";
import {
  policyFeaturesOf,
  policySchema,
  ruleOperatorsOf,
  unsupportedPolicyFeatures,
  type OpaqueItem,
  type OpEnvelope,
  type Policy,
} from "@beaconsgg/protocol-types";
import { beforeEach, describe, expect, it } from "vitest";
import { getReactions, MAX_OP_LEDGER, PolicyEngine } from "../index";
import { InMemoryStore, nonce, reward, roomMintedBy, token, TEST_GAME } from "../testing";
import kitesCapsuleTagged from "./shipped/kites-capsule-medium-tagged.2026-09-23.json";
import kitesCapsule from "./shipped/kites-capsule-medium.2026-09-23.json";
import kitesChallengeUnmapped from "./shipped/kites-challenge-unmapped.2026-09-23.json";
import kitesChallenge from "./shipped/kites-challenge.2026-09-23.json";
import kitesJar from "./shipped/kites-jar.2026-09-23.json";

const SHIPPED: Record<string, unknown> = {
  "kites-jar.2026-09-23": kitesJar,
  "kites-capsule-medium.2026-09-23": kitesCapsule,
  "kites-capsule-medium-tagged.2026-09-23": kitesCapsuleTagged,
  "kites-challenge.2026-09-23": kitesChallenge,
  "kites-challenge-unmapped.2026-09-23": kitesChallengeUnmapped,
};

const ROOM_ID = "shipped1@beacon.example";
const DAY_MS = 86_400_000;

describe("every shipped policy is still a policy this build accepts", () => {
  it.each(Object.entries(SHIPPED))("%s parses as a wire policy", (_name, policy) => {
    // `policySchema` is strict, so a field the engine stopped knowing fails here first.
    expect(policySchema.safeParse(policy).success).toBe(true);
  });

  it.each(Object.entries(SHIPPED))(
    "%s uses only baseline features and rule operators",
    (_name, policy) => {
      // So every server places it, including one that advertises no marker at all.
      expect(policyFeaturesOf(policy).length).toBeGreaterThan(0);
      expect(unsupportedPolicyFeatures(undefined, policy)).toEqual([]);
    },
  );

  it("finds rule operators in the shipped rule bodies, so the check above is not vacuous", () => {
    const operators = Object.values(SHIPPED).flatMap((policy) => ruleOperatorsOf(policy));
    expect(operators.length).toBeGreaterThan(0);
  });
});

describe("the shipped policies still play", () => {
  let clock: { ms: number };
  let engine: PolicyEngine;
  let alice: Wallet;
  let bob: Wallet;

  beforeEach(() => {
    clock = { ms: Date.parse("2029-06-01T00:00:00Z") };
    engine = new PolicyEngine(new InMemoryStore(), {
      now: () => clock.ms,
      replayWindowMs: Number.MAX_SAFE_INTEGER,
    });
    alice = createWallet();
    bob = createWallet();
  });

  const op = (wallet: Wallet, name: string, params: Record<string, unknown>): OpEnvelope =>
    signOpWithWallet(wallet, {
      game: TEST_GAME,
      op: name,
      room: ROOM_ID,
      nonce: nonce(),
      issuedAt: new Date(clock.ms).toISOString(),
      params,
    });

  const place = (type: string, raw: unknown, state: Record<string, unknown> = {}) => {
    const policy = raw as Policy;
    return engine.placeRoom({
      game: TEST_GAME,
      id: ROOM_ID,
      type,
      location: { lat: 47.61, lng: -122.34 },
      policy,
      placedBy: alice.account.did,
      mintedBy: roomMintedBy(ROOM_ID, type, policy, alice),
      state,
    });
  };

  const run = async (wallet: Wallet, name: string, params: Record<string, unknown>) =>
    (await engine.applyOp(op(wallet, name, params))).result;

  it("kites-jar: add, then take, and it closes when emptied", async () => {
    await place("jar", kitesJar);
    expect(await run(alice, "add", { item: token("j1") })).toMatchObject({ ok: true });
    expect(await run(bob, "take", { item: "j1" })).toMatchObject({ ok: true });
    expect(await engine.resolveRoom(ROOM_ID)).toBeUndefined();
  });

  it("kites-capsule-medium: contribute moves its windows, react stays under the ledger bound, then a reward pays out once open", async () => {
    // The shipped reaction cap has to sit under what the engine will store, or every capsule this
    // build places is refused at the door. The game's own suite pins its side of the same number.
    expect((kitesCapsule as Policy).ops["react"]?.max).toBeLessThanOrEqual(MAX_OP_LEDGER);
    // Placing it at all proves the engine still accepts the shipped unlock transform: the server
    // validates every rule it stores, and this one is the game's own `set` formula.
    await place("capsule", kitesCapsule, { rewards: [reward("rw1"), reward("rw2")] });
    const placedAt = Math.floor(clock.ms / 1000);

    // The shipped formulas sum the game's projected keys, 9 s sooner per unit of `proceduralShared`
    // for the lock (3 h base) and 25 s per unit of `semanticShared` for the unlock (9 h base).
    const item = token("m1", { proceduralShared: 10, semanticShared: 10 });
    expect(await run(alice, "contribute", { item: item })).toMatchObject({ ok: true });
    const timers = (await engine.resolveRoom(ROOM_ID))!.state;
    expect(timers["lockAt"]).toBe(placedAt + 10_800 - 90);
    expect(timers["unlockAt"]).toBe((timers["lockAt"] as number) + 32_400 - 250);
    expect(await run(alice, "react", { target: "m1", kind: "love" })).toMatchObject({ ok: true });
    expect(getReactions((await engine.resolveRoom(ROOM_ID))!.state)).toHaveLength(1);
    // Contributors only: bob put nothing in.
    expect(await run(bob, "react", { target: "m1", kind: "clap" })).toMatchObject({
      ok: false,
      error: "denied",
    });

    clock.ms += DAY_MS; // past both windows (about 12 h in all)
    await engine.advancePhase(ROOM_ID);
    const claimed = await run(alice, "claim", {});
    expect(claimed).toMatchObject({ ok: true });
    const granted = (claimed as { result?: { granted?: OpaqueItem[] } }).result?.granted ?? [];
    expect(granted).toHaveLength(1);
  });

  it("kites-capsule-medium: refuses a stranger's contribution that would push its unlock past the transition horizon", async () => {
    // Levels may be negative, and the shipped unlock has a floor but no ceiling, so one item could push
    // it decades out. Left in, the capsule would be stranded once it locked and closed a claim window
    // later, taking Alice's contribution and the reward pool with it.
    await place("capsule", kitesCapsule, { rewards: [reward("rw1"), reward("rw2")] });
    expect(await run(alice, "contribute", { item: token("m1") })).toMatchObject({ ok: true });
    const before = (await engine.resolveRoom(ROOM_ID))!;
    const hostile = token("m2", { semanticShared: -20_000_000 });
    expect(await run(bob, "contribute", { item: hostile })).toMatchObject({
      ok: false,
      error: "invalid",
    });
    expect((await engine.resolveRoom(ROOM_ID))!.state).toEqual(before.state);
  });

  it("kites-capsule-medium-tagged: admits an item carrying the gated tag and refuses one without it", async () => {
    // The Store's tag-gated capsules (`accept.tags`, an empty list meaning any value). Placing one
    // proves the wire schema still takes `accept.tags`; the pair proves the engine still gates on it.
    await place("capsule", kitesCapsuleTagged, { rewards: [reward("rw1")] });
    const tagged = token("m1", {}, { tags: { color: ["teal"] } });
    expect(await run(alice, "contribute", { item: tagged })).toMatchObject({ ok: true });
    expect(await run(bob, "contribute", { item: token("m2") })).toMatchObject({
      ok: false,
      error: "denied",
    });
  });

  // Two generations of the challenge: the phone places the map-visible one (live phase `open`), the
  // admin console either (`mapped` is the operator's toggle), and a phase name is data the engine
  // never checks, so both are frozen because rooms of both exist.
  it.each([
    ["kites-challenge.2026-09-23", kitesChallenge],
    ["kites-challenge-unmapped.2026-09-23", kitesChallengeUnmapped],
  ])(
    "%s: each rung pays from its own pool, in order, on the repeatable collect",
    async (_name, policy) => {
      await place("challenge", policy, {
        rewards1: [reward("r1a"), reward("r1b")],
        rewards2: [reward("r2a"), reward("r2b")],
      });
      // A progress claim: the shape the game's reporter signs (a player-minted `ChallengeProgress`),
      // keyed by the step-namespaced event the shipped formulas sum.
      const progress = (unique: string, levels: Record<string, number>) =>
        token(unique, levels, { cls: "ChallengeProgress", minter: walletMinter(alice) });
      const granted = (result: unknown): string[] =>
        ((result as { result?: { granted?: OpaqueItem[] } }).result?.granted ?? []).map(
          (g) => g.unique,
        );

      // Step 2 progress alone pays nothing, from either pool: the ladder is cumulative.
      expect(
        await run(alice, "contribute", { item: progress("p2", { "s2:jar.placed": 3 }) }),
      ).toMatchObject({ ok: true });
      const early = await run(alice, "collect", {});
      expect(early).toMatchObject({ ok: true });
      expect(granted(early)).toEqual([]);

      // Finishing step 1 completes both rungs, so one collect pays each pool once.
      expect(
        await run(alice, "contribute", { item: progress("p1", { "s1:capsule.finished": 2 }) }),
      ).toMatchObject({ ok: true });
      expect(granted(await run(alice, "collect", {})).sort()).toEqual(["r1a", "r2a"]);
    },
  );
});
