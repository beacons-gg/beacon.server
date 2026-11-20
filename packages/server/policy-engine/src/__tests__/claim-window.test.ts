/**
 * The claim window, as the timer wheel sees it.
 *
 * `lifecycleRoomShouldClose` measures `claimTtl` from settlement, but `nextTransitionAt`, the time the
 * server schedules a room at and persists as `lifecycle_due_at`, used to measure it from `unlockAt`
 * and to drop a time already in the past. For any room that settles after its `unlockAt` the two
 * disagreed: a won ladder was scheduled for a close that had not come due, woke to find nothing to
 * do, and fell off the wheel; one won later than `claimTtl` after placement got no schedule at all.
 * Built on the generic fixtures, so what is proven is the engine.
 */
import { createWallet, signOpWithWallet, type Wallet } from "@beaconsgg/identity";
import type { OpaqueItem, Policy } from "@beaconsgg/protocol-types";
import { beforeEach, describe, expect, it } from "vitest";
import { nextTransitionAt, PolicyEngine } from "../index";
import {
  InMemoryStore,
  ladderPolicy,
  nonce,
  reward,
  roomMintedBy,
  timedPotPolicy,
  token,
  TEST_GAME,
} from "../testing";

const DAY = 86_400;
const TTL = 7 * DAY;
const T0 = Math.floor(Date.parse("2026-06-29T00:00:00Z") / 1000);

describe("claim window: the scheduler measures from settlement, as the close check does", () => {
  const clock = { ms: T0 * 1000 };
  let engine: PolicyEngine;
  let alice: Wallet;
  let bob: Wallet;

  const now = (): number => Math.floor(clock.ms / 1000);
  const at = (sec: number): void => {
    clock.ms = sec * 1000;
  };
  const tick = (id: string) => engine.advancePhase(id, clock.ms);
  const read = async (id: string) => (await engine.resolveRoom(id))!;

  async function contribute(wallet: Wallet, room: string, item: OpaqueItem): Promise<void> {
    const envelope = signOpWithWallet(wallet, {
      game: TEST_GAME,
      op: "contribute",
      room,
      nonce: nonce(),
      issuedAt: new Date(clock.ms).toISOString(),
      params: { item },
    });
    expect((await engine.applyOp(envelope)).result.ok).toBe(true);
  }

  async function place(
    id: string,
    type: string,
    policy: Policy,
    state: Record<string, unknown> = {},
  ): Promise<void> {
    await engine.placeRoom({
      game: TEST_GAME,
      id,
      type,
      location: { lat: 47.61, lng: -122.34 },
      policy,
      placedBy: alice.account.did,
      mintedBy: roomMintedBy(id, type, policy, alice),
      state: { contents: [], ...state },
    });
  }

  beforeEach(() => {
    at(T0);
    engine = new PolicyEngine(new InMemoryStore(), {
      now: () => clock.ms,
      replayWindowMs: Number.MAX_SAFE_INTEGER,
    });
    alice = createWallet();
    bob = createWallet();
  });

  describe("a ladder won early (it settles after its own unlockAt)", () => {
    const LADDER = "ladder1@beacon.example";

    /** Placed at T0 with a 30-day deadline; alice adds the first token of two straight away. */
    async function startLadder(): Promise<void> {
      const policy = ladderPolicy({ target: 2, deadlineSec: T0 + 30 * DAY, claimTtl: "7d" });
      await place(LADDER, "ladder", policy, { pool: [reward("p1"), reward("p2")] });
      await contribute(alice, LADDER, token("t-alice", { hue: 1 }));
    }

    it("won inside the TTL from placement: stays scheduled past placedAt + ttl, closes at settledAt + ttl", async () => {
      await startLadder();
      at(T0 + 2 * DAY);
      await contribute(bob, LADDER, token("t-bob", { hue: 1 })); // the target: unlockAt collapses to placedAt

      const settle = await tick(LADDER);
      expect(settle.closed).toBe(false);
      expect(settle.room!.state["settledAt"]).toBe(now());
      expect(nextTransitionAt(settle.room!, now())).toBe(now() + TTL);

      // The old schedule woke here (placedAt + ttl), found nothing due, and dropped the room.
      at(T0 + TTL + DAY);
      expect(nextTransitionAt(await read(LADDER), now())).toBe(T0 + 2 * DAY + TTL);
      expect((await tick(LADDER)).closed).toBe(false);

      at(T0 + 2 * DAY + TTL);
      expect((await tick(LADDER)).closed).toBe(true);
    });

    it("won after the TTL from placement: still scheduled (this used to be no schedule at all)", async () => {
      await startLadder();
      at(T0 + 10 * DAY); // past placedAt + ttl, inside the deadline
      await contribute(bob, LADDER, token("t-bob", { hue: 1 }));

      const settle = await tick(LADDER);
      expect(settle.closed).toBe(false);
      expect(nextTransitionAt(settle.room!, now())).toBe(now() + TTL);

      at(now() + TTL - 1);
      expect((await tick(LADDER)).closed).toBe(false);
      at(now() + 1);
      expect((await tick(LADDER)).closed).toBe(true);
    });
  });

  it("a timed pot the server slept through keeps its whole window from settlement, not from unlockAt", async () => {
    const POT = "pot1@beacon.example";
    await place(
      POT,
      "pot",
      timedPotPolicy({ lockDelaySec: DAY, unlockDelaySec: DAY, claimTtl: "7d" }),
    );
    await contribute(alice, POT, token("t-alice"));

    // Down from before the lock until a day past unlockAt + ttl: the first tick back settles it late.
    at(T0 + 2 * DAY + TTL + DAY);
    const settle = await tick(POT);
    expect(settle.closed).toBe(false);
    expect(settle.room!.state["phase"]).toBe("open");
    expect(nextTransitionAt(settle.room!, now())).toBe(now() + TTL);

    at(now() + TTL);
    expect((await tick(POT)).closed).toBe(true);
  });

  it("a room that never closes on its own gets no claim-window wake, since the close check would refuse it", async () => {
    // `onEmpty` is optional in the schema, and a policy without it is never swept by the tick. A
    // window for it would schedule a wake that finds nothing to do, which is the mismatch this
    // suite exists to catch.
    const POT = "pot2@beacon.example";
    const { onEmpty: _neverCloses, ...policy } = timedPotPolicy({
      lockDelaySec: DAY,
      unlockDelaySec: DAY,
      claimTtl: "7d",
    });
    await place(POT, "pot", policy);
    await contribute(alice, POT, token("t-alice"));

    at(T0 + 3 * DAY); // past unlockAt: the first tick settles it
    const settle = await tick(POT);
    expect(settle.room!.state["phase"]).toBe("open");
    expect(nextTransitionAt(settle.room!, now())).toBeUndefined();

    at(now() + TTL + DAY); // well past where a window would have ended
    expect((await tick(POT)).closed).toBe(false);
  });
});
