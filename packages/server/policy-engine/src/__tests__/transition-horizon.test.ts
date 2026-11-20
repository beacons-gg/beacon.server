/**
 * The transition horizon: a transition past {@link TRANSITION_HORIZON_SEC} is never.
 *
 * Formulas cannot see the clock, so a policy says "never" by scheduling a transition decades out. A
 * room left waiting on one, in a phase that pays nobody, would sit in custody for decades. The engine
 * refuses to place such a room, refuses an op that would push a room there, and closes a room an
 * older build already left there a claim window after the phase it is stuck in began. Built on the
 * generic fixtures, so what is proven is the engine.
 */
import { createWallet, signOpWithWallet, type Wallet } from "@beaconsgg/identity";
import { type OpResult, type Policy, TRANSITION_HORIZON_SEC } from "@beaconsgg/protocol-types";
import { beforeEach, describe, expect, it } from "vitest";
import { DerivedRangeError, nextTransitionAt, PolicyEngine, recomputeDerived } from "../index";
import {
  InMemoryStore,
  nonce,
  reward,
  roomMintedBy,
  timedPotPolicy,
  token,
  TEST_GAME,
} from "../testing";

const DAY = 86_400;
const YEAR = 365 * DAY;
const T0 = Math.floor(Date.parse("2026-06-29T00:00:00Z") / 1000);
const POT = "pot1@beacon.example";

describe("the transition horizon", () => {
  const clock = { ms: T0 * 1000 };
  let store: InMemoryStore;
  let engine: PolicyEngine;
  let alice: Wallet;
  let mallory: Wallet;

  const at = (sec: number): void => {
    clock.ms = sec * 1000;
  };
  const read = async () => (await engine.resolveRoom(POT))!;
  const due = async () => nextTransitionAt(await read(), Math.floor(clock.ms / 1000));

  const place = (policy: Policy, state: Record<string, unknown> = {}) =>
    engine.placeRoom({
      game: TEST_GAME,
      id: POT,
      type: "pot",
      location: { lat: 47.61, lng: -122.34 },
      policy,
      placedBy: alice.account.did,
      mintedBy: roomMintedBy(POT, "pot", policy, alice),
      state: { contents: [], ...state },
    });

  const contribute = async (who: Wallet, levels: Record<string, number>): Promise<OpResult> =>
    (
      await engine.applyOp(
        signOpWithWallet(who, {
          game: TEST_GAME,
          op: "contribute",
          room: POT,
          nonce: nonce(),
          issuedAt: new Date(clock.ms).toISOString(),
          params: { item: token(nonce(), levels) },
        }),
      )
    ).result;

  /** A pot whose unlock (or lock) moves a year per unit of `far`: a contribution could push it out. */
  const drifting = (shift: "lockShift" | "unlockShift", options: { claimTtl?: string } = {}) =>
    timedPotPolicy({
      lockDelaySec: DAY,
      unlockDelaySec: DAY,
      [shift]: { key: "far", per: YEAR },
      ...options,
    });

  /**
   * The room an older build could have stored: Alice's contribution of `far: 11` already in it, and its
   * derived times recomputed past the horizon. No op can get a room there any more, so it is written
   * straight to the store, as a database row from before the rule would be.
   */
  async function storedFar(policy: Policy, state: Record<string, unknown> = {}): Promise<void> {
    await place(policy, state);
    const room = await read();
    const item = { ...token("old", { far: 11 }), owner: alice.account.did };
    const next = recomputeDerived(policy, {
      ...room.state,
      contents: [item],
      contributors: { [alice.account.did]: ["old"] },
    });
    await store.commit([{ kind: "putRoom", room: { ...room, state: next } }]);
  }

  beforeEach(() => {
    at(T0);
    store = new InMemoryStore();
    engine = new PolicyEngine(store, {
      now: () => clock.ms,
      replayWindowMs: Number.MAX_SAFE_INTEGER,
    });
    alice = createWallet();
    mallory = createWallet();
  });

  describe("no placement and no op can schedule a transition past it", () => {
    it("refuses to place a room that schedules one, naming the transition", async () => {
      const policy = timedPotPolicy({ lockDelaySec: DAY, unlockDelaySec: TRANSITION_HORIZON_SEC });
      await expect(place(policy)).rejects.toThrow(DerivedRangeError);
      await expect(place(policy)).rejects.toThrow(/open transition \(unlockAt\)/);
    });

    it("places one scheduled exactly at it", async () => {
      const policy = timedPotPolicy({
        lockDelaySec: DAY,
        unlockDelaySec: TRANSITION_HORIZON_SEC - DAY,
      });
      await expect(place(policy)).resolves.toBeDefined();
    });

    it("refuses a contribution that would push the unlock past it, and the room is untouched", async () => {
      // The griefing case: a stranger's item with a hostile level. Before this guard it would strand
      // the room, and a stranded room closes with everything in it.
      await place(drifting("unlockShift", { claimTtl: "7d" }));
      expect(await contribute(alice, { far: 1 })).toMatchObject({ ok: true });
      const before = await read();

      expect(await contribute(mallory, { far: 11 })).toMatchObject({
        ok: false,
        error: "invalid",
        message: expect.stringMatching(/open transition \(unlockAt\)/),
      });
      const after = await read();
      expect(after.state).toEqual(before.state);
      expect(after.version).toBe(before.version);
    });

    it("refuses one that would push the lock past it while the room is still filling", async () => {
      await place(drifting("lockShift"));
      expect(await contribute(mallory, { far: 11 })).toMatchObject({
        ok: false,
        error: "invalid",
        message: expect.stringMatching(/locked transition \(lockAt\)/),
      });
    });

    it("still takes a contribution that brings a stored far transition nearer", async () => {
      // A room an older build left far out may still be played: only moving a transition later and
      // past the horizon is refused, so progress that pulls it in goes through.
      await storedFar(drifting("lockShift"));
      const lockAt = (await read()).state["lockAt"] as number;
      expect(await contribute(alice, { far: -1 })).toMatchObject({ ok: true });
      const nearer = (await read()).state["lockAt"] as number;
      expect(nearer).toBe(lockAt - YEAR);
      expect(nearer).toBeGreaterThan(T0 + TRANSITION_HORIZON_SEC); // still far, and allowed
    });
  });

  describe("a room an older build left behind one closes once nothing can move it", () => {
    it("closes a claim window after its stuck phase began", async () => {
      await storedFar(drifting("unlockShift", { claimTtl: "7d" }));
      expect(await due()).toBe(T0 + DAY); // still filling: the lock is near, so it is not stranded

      at(T0 + DAY);
      expect((await engine.advancePhase(POT)).room?.state["phase"]).toBe("locked");
      expect(await due()).toBe(T0 + DAY + 7 * DAY);

      at(T0 + 8 * DAY - 1);
      expect((await engine.advancePhase(POT)).closed).toBe(false);
      at(T0 + 8 * DAY);
      expect((await engine.advancePhase(POT)).closed).toBe(true);
    });

    it("closes as soon as it is stranded when the policy has no claim window", async () => {
      await storedFar(drifting("unlockShift"));
      at(T0 + DAY);
      await engine.advancePhase(POT); // enters `locked`, and it is stranded from that instant
      expect((await engine.advancePhase(POT)).closed).toBe(true);
    });

    it("stays while its phase still takes contributions, however far its next transition", async () => {
      // A contribution could still bring the lock back, so it is not stranded.
      await storedFar(drifting("lockShift", { claimTtl: "7d" }));
      const lockAt = (await read()).state["lockAt"] as number;
      expect(lockAt).toBeGreaterThan(T0 + TRANSITION_HORIZON_SEC);
      expect(await due()).toBe(lockAt);
      at(T0 + 60 * DAY);
      expect((await engine.advancePhase(POT)).closed).toBe(false);
    });

    it("stays while its stuck phase can still pay someone", async () => {
      // An ungated `collect` pays from a pool in any phase: not stranded.
      const base = drifting("unlockShift", { claimTtl: "7d" });
      const policy: Policy = {
        ...base,
        ops: { ...base.ops, collect: { role: "contributor" } },
        grant: { op: "collect", from: "pool", count: 1 },
      };
      await storedFar(policy, { pool: [reward("p1")] });
      at(T0 + DAY);
      await engine.advancePhase(POT);
      expect(await due()).toBe((await read()).state["unlockAt"]);
      at(T0 + 30 * DAY);
      expect((await engine.advancePhase(POT)).closed).toBe(false);
    });
  });
});
