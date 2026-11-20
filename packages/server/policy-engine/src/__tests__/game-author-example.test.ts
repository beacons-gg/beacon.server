/**
 * The worked example in beacon.core's `doc/game-author.md` §10, placed and played step by step as
 * the document describes it. The policy is `@beaconsgg/protocol-types/examples`' `POT_POLICY`, the
 * same value the document shows (`scripts/check-doc-examples.mjs` holds that), so an author who
 * copies it copies something this engine has run.
 */
import { createWallet, signOpWithWallet, type Wallet } from "@beaconsgg/identity";
import type { OpEnvelope } from "@beaconsgg/protocol-types";
import { POT_POLICY } from "@beaconsgg/protocol-types/examples";
import { describe, expect, it } from "vitest";
import { PolicyEngine } from "../index";
import { InMemoryStore, nonce, roomMintedBy, token, TEST_GAME } from "../testing";

const ROOM_ID = "01K5A7Q3V9M8XH2B6T4R0N1ZGP@beacon.example";

describe("game-author.md §10: the pot", () => {
  it("places, admits stones, settles sooner for heavier ones, and closes once everyone claims", async () => {
    const policy = POT_POLICY;
    const clock = { ms: Date.parse("2026-09-24T12:00:00Z") };
    const engine = new PolicyEngine(new InMemoryStore(), { now: () => clock.ms });
    const alice = createWallet();
    const bob = createWallet();
    const send = (wallet: Wallet, op: string, params: Record<string, unknown> = {}): OpEnvelope =>
      signOpWithWallet(wallet, {
        game: TEST_GAME,
        op,
        room: ROOM_ID,
        nonce: nonce(),
        params,
        issuedAt: new Date(clock.ms).toISOString(),
      });
    const stone = (unique: string, weight: number) => token(unique, { weight }, { cls: "stone" });

    // 1. Placed: open, with settleAt an hour after placement.
    const room = await engine.placeRoom({
      game: TEST_GAME,
      id: ROOM_ID,
      type: "pot",
      location: { lat: 47.61, lng: -122.34 },
      policy,
      placedBy: alice.account.did,
      mintedBy: roomMintedBy(ROOM_ID, "pot", policy, alice),
    });
    const placedAt = room.state["placedAt"] as number;
    expect(room.state["phase"]).toBe("open");
    expect(room.state["settleAt"]).toBe(placedAt + 3600);

    // 2. A stone of weight 10 brings settleAt ten minutes nearer, and watchers see both changes.
    const first = await engine.applyOp(send(alice, "contribute", { item: stone("s1", 10) }));
    expect(first.result.ok).toBe(true);
    expect(first.changes.map((c) => c.type)).toEqual(["itemAdded", "derivedUpdated"]);
    expect(first.room?.state["settleAt"]).toBe(placedAt + 3600 - 600);

    // ...and however heavy the stones, never sooner than ten minutes in.
    const heavy = await engine.applyOp(send(bob, "contribute", { item: stone("s2", 100) }));
    expect(heavy.room?.state["settleAt"]).toBe(placedAt + 600);

    // 3. Anything that is not a stone is refused by `accept`.
    const leaf = token("l1", { weight: 1 }, { cls: "leaf" });
    const refused = await engine.applyOp(send(alice, "contribute", { item: leaf }));
    expect(refused.result).toMatchObject({ ok: false, error: "denied" });

    // 4. At settleAt the room settles: the tick moves it to `settled`, and contributing is over.
    clock.ms = (placedAt + 600) * 1000;
    const advanced = await engine.advancePhase(ROOM_ID);
    expect(advanced.changes).toEqual([{ type: "phaseChanged", phase: "settled" }]);
    const late = await engine.applyOp(send(alice, "contribute", { item: stone("s3", 1) }));
    expect(late.result).toMatchObject({ ok: false, error: "phase" });

    // 5. Each contributor claims their own stones; the last claim closes the room.
    const aliceClaim = await engine.applyOp(send(alice, "claim"));
    expect(aliceClaim.result.ok && aliceClaim.result.result).toMatchObject({
      items: [{ unique: "s1" }],
    });
    expect(aliceClaim.closed).toBe(false);
    const bobClaim = await engine.applyOp(send(bob, "claim"));
    expect(bobClaim.result.ok && bobClaim.result.result).toMatchObject({
      items: [{ unique: "s2" }],
    });
    expect(bobClaim.closed).toBe(true);
    expect(bobClaim.changes.at(-1)).toEqual({ type: "closed" });
  });
});
