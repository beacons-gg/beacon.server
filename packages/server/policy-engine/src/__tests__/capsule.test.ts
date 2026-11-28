import { createWallet, signOpWithWallet, type Wallet } from "@beaconsgg/identity";
import type { OpaqueItem, OpEnvelope, Policy } from "@beaconsgg/protocol-types";
import { beforeEach, describe, expect, it } from "vitest";
import { DerivedRangeError, nextTransitionAt, PolicyEngine } from "../index";
import { InMemoryStore, nonce, roomMintedBy, timedPotPolicy, token, TEST_GAME } from "../testing";

const CAP_ID = "cap1@beacon.example";

function claimedItems(result: { result?: unknown }): OpaqueItem[] {
  return (result.result as { items: OpaqueItem[] }).items;
}

/** The suite's pot (`../testing`'s generic timed pot): filling → locked → open, locking 100 s
 * after placement and opening 200 s after that, with a one-day claim window. */
function pot(opts: Partial<Parameters<typeof timedPotPolicy>[0]> = {}): Policy {
  return timedPotPolicy({ lockDelaySec: 100, unlockDelaySec: 200, claimTtl: "1d", ...opts });
}

describe("PolicyEngine — Capsule lifecycle (contended recompute)", () => {
  let clock: { ms: number };
  let engine: PolicyEngine;
  let alice: Wallet;
  let bob: Wallet;

  const t = () => Math.floor(clock.ms / 1000);

  function op(wallet: Wallet, name: string, params: Record<string, unknown>): OpEnvelope {
    return signOpWithWallet(wallet, {
      game: TEST_GAME,
      op: name,
      room: CAP_ID,
      nonce: nonce(),
      issuedAt: new Date(clock.ms).toISOString(),
      params,
    });
  }
  function placeCapsule(
    opts: Partial<Parameters<typeof timedPotPolicy>[0]> = {},
  ): Promise<unknown> {
    const policy = pot(opts);
    return engine.placeRoom({
      game: TEST_GAME,
      id: CAP_ID,
      type: "capsule",
      location: { lat: 47.61, lng: -122.34 },
      policy,
      placedBy: alice.account.did,
      mintedBy: roomMintedBy(CAP_ID, "capsule", policy, alice),
    });
  }

  beforeEach(() => {
    clock = { ms: Date.parse("2026-06-29T00:00:00Z") };
    engine = new PolicyEngine(new InMemoryStore(), {
      now: () => clock.ms,
      replayWindowMs: Number.MAX_SAFE_INTEGER,
    });
    alice = createWallet();
    bob = createWallet();
  });

  it("places in its first phase with initial derived timers", async () => {
    const room = (await placeCapsule()) as { state: Record<string, unknown> };
    expect(room.state["phase"]).toBe("filling");
    expect(room.state["placedAt"]).toBe(t());
    expect(room.state["lockAt"]).toBe(t() + 100);
    expect(room.state["unlockAt"]).toBe(t() + 300);
  });

  it("registers an OWNED seeded contribution as its owner's — claimable, not treated as empty (a room placed pre-seeded)", async () => {
    // A room placed pre-seeded with the finder's OWN contribution (a room the finder seeds on
    // discovery): an `initialContents` item they own. buildRoom must register it in the
    // contributors ledger (the same structure a `contribute` op writes), so the finder can claim it
    // back and the capsule isn't seen as empty.
    const policy = pot();
    const seed = { ...token("seed", { procedural: 5, semantic: 5 }), owner: alice.account.did };
    const room = (await engine.placeRoom({
      game: TEST_GAME,
      id: CAP_ID,
      type: "capsule",
      location: { lat: 47.61, lng: -122.34 },
      policy,
      placedBy: alice.account.did,
      mintedBy: roomMintedBy(CAP_ID, "capsule", policy, alice),
      state: { contents: [seed] },
    })) as { state: Record<string, unknown> };

    // Registered as alice's contribution — the ledger a `contribute` op writes.
    expect(room.state["contributors"]).toEqual({ [alice.account.did]: ["seed"] });

    // …and claimable: advance to open, alice claims her seeded item back (proves she's a contributor).
    clock.ms += 400_000; // past unlockAt
    const claim = await engine.applyOp(op(alice, "claim", {}));
    expect(claim.result).toMatchObject({ ok: true });
    expect(claimedItems(claim.result as { result: unknown }).map((i) => i.unique)).toEqual([
      "seed",
    ]);
  });

  it("leaves an UN-owned seeded content unattributed (a jar's up-for-grabs items register no contributor)", async () => {
    // Symmetric guard: only OWNED seeded items register a contributor. An un-owned one (owner:null) seeds
    // contents without inventing a contributor, so the "owned = contribution" rule can't over-reach.
    const policy = pot();
    const room = (await engine.placeRoom({
      game: TEST_GAME,
      id: CAP_ID,
      type: "capsule",
      location: { lat: 47.61, lng: -122.34 },
      policy,
      placedBy: alice.account.did,
      mintedBy: roomMintedBy(CAP_ID, "capsule", policy, alice),
      state: { contents: [token("loose")] }, // token() → no owner
    })) as { state: Record<string, unknown> };
    expect(room.state["contributors"]).toBeUndefined();
  });

  it("rejects a place whose seeded contents overflow a derived aggregate (clean DerivedRangeError, not a 500)", async () => {
    // The pot's windows do not read the contents, so (like the applyOp overflow test) reach the
    // guard via a raw aggregate + two items whose summed match.levels exceed MAX_SAFE_INTEGER. The
    // applyOp/contribute path already guards this; buildRoom must too (untrusted numerics).
    const policy = pot();
    policy.derived = { ...policy.derived, total: { sum: [{ var: "contents" }, "procedural"] } };
    const big = Number.MAX_SAFE_INTEGER;
    await expect(
      engine.placeRoom({
        game: TEST_GAME,
        id: CAP_ID,
        type: "capsule",
        location: { lat: 47.61, lng: -122.34 },
        policy,
        placedBy: alice.account.did,
        mintedBy: roomMintedBy(CAP_ID, "capsule", policy, alice),
        state: {
          contents: [token("a", { procedural: big }), token("b", { procedural: big })],
        },
      }),
    ).rejects.toThrow(DerivedRangeError);
  });

  it("rejects a place whose unlockTransform carries an off-profile rule (the server never evaluates it, but it must not STORE it)", async () => {
    // The server doesn't run an unlock transform — a client does, at claim. That's exactly why the
    // server has to validate it: it is the only party that can stop a bad rule being persisted and
    // fanned out. Unvalidated, the place succeeds, every client is served the rule, and the whitelist
    // gate then throws inside applyUnlockTransform at claim — AFTER the claim op has already
    // transferred custody server-side, so the items move and never arrive. Reject the placement instead.
    for (const bad of [
      // an off-profile op in a rule's `when` predicate…
      [{ when: { if: [true, 1, 0] }, set: { episodic: { "+": [{ var: ["episodic", 0] }, 1] } } }],
      // …and in a rule's `set` formula.
      [{ set: { episodic: { "/": [{ var: ["episodic", 0] }, 2] } } }],
    ]) {
      const policy = pot();
      policy.unlockTransform = bad as typeof policy.unlockTransform;
      await expect(
        engine.placeRoom({
          game: TEST_GAME,
          id: CAP_ID,
          type: "capsule",
          location: { lat: 47.61, lng: -122.34 },
          policy,
          placedBy: alice.account.did,
          mintedBy: roomMintedBy(CAP_ID, "capsule", policy, alice),
        }),
      ).rejects.toThrow(/not allowed/);
    }
  });

  it("accepts a place whose unlockTransform is on-profile, `when` predicate and all", async () => {
    const policy = pot();
    policy.unlockTransform = [
      {
        when: { in: [{ var: "class" }, ["Relic"]] },
        set: { semantic: { "+": [{ var: ["semantic", 0] }, 5] } },
      },
    ];
    await expect(
      engine.placeRoom({
        game: TEST_GAME,
        id: CAP_ID,
        type: "capsule",
        location: { lat: 47.61, lng: -122.34 },
        policy,
        placedBy: alice.account.did,
        mintedBy: roomMintedBy(CAP_ID, "capsule", policy, alice),
      }),
    ).resolves.toBeDefined();
  });

  it("recomputes lockAt/unlockAt from the whole contents on each contribute (no lost update)", async () => {
    // `procedural` shifts lockAt and `semantic` shifts unlockAt, one second sooner per unit, so the
    // arithmetic is legible. The engine only sums what the items carry: what a game projects onto
    // those levels (a game's power curve) is the game's business and is tested there.
    await placeCapsule({
      lockShift: { key: "procedural", per: -1 },
      unlockShift: { key: "semantic", per: -1 },
    });
    const t0 = t();

    const a = await engine.applyOp(
      op(alice, "contribute", { item: token("a", { procedural: 10, semantic: 50 }) }),
    );
    expect(a.result).toMatchObject({ ok: true });
    expect(a.changes).toContainEqual(expect.objectContaining({ type: "derivedUpdated" }));

    const lockAt = t0 + 100 - 10;
    let room = (await engine.resolveRoom(CAP_ID))!;
    expect(room.state["lockAt"]).toBe(lockAt);
    expect(room.state["unlockAt"]).toBe(lockAt + 200 - 50);

    await engine.applyOp(
      op(bob, "contribute", { item: token("b", { procedural: 0, semantic: 40 }) }),
    );
    room = (await engine.resolveRoom(CAP_ID))!;
    expect(room.state["lockAt"]).toBe(lockAt); // b adds no procedural
    // The recompute reads the WHOLE contents, so both contributions' semantic counts (no lost update).
    expect(room.state["unlockAt"]).toBe(lockAt + 200 - (50 + 40));
  });

  it("takes the same item once, so a sum counts it once", async () => {
    await placeCapsule({ lockShift: { key: "procedural", per: -1 } });
    const t0 = t();
    const a = token("a", { procedural: 40 });
    const first = await engine.applyOp(op(alice, "contribute", { item: a }));
    expect(first.result).toMatchObject({ ok: true, version: 2, result: { contributed: "a" } });

    // Alice's retry under a fresh nonce confirms the custody she has, without a second write.
    const retry = await engine.applyOp(op(alice, "contribute", { item: a }));
    expect(retry.result).toMatchObject({ ok: true, version: 2, result: { contributed: "a" } });
    expect(retry.changes).toEqual([]);
    // Anyone else sending the same item is refused.
    expect((await engine.applyOp(op(bob, "contribute", { item: a }))).result).toMatchObject({
      ok: false,
      error: "invalid",
    });

    const room = (await engine.resolveRoom(CAP_ID))!;
    expect(room.state["contents"]).toHaveLength(1);
    expect(room.state["contributors"]).toEqual({ [alice.account.did]: ["a"] });
    expect(room.state["lockAt"]).toBe(t0 + 100 - 40); // summed once
  });

  it("gates contribute to the filling phase and claim to the open one (clock-driven)", async () => {
    await placeCapsule();
    await engine.applyOp(op(alice, "contribute", { item: token("a") }));

    clock.ms += 200_000; // -> Locked (past lockAt = T+100)
    expect((await engine.applyOp(op(bob, "contribute", { item: token("b") }))).result).toEqual({
      ok: false,
      error: "phase",
    });
    expect((await engine.applyOp(op(alice, "claim", {}))).result).toEqual({
      ok: false,
      error: "phase",
    });

    clock.ms += 200_000; // -> open (past unlockAt = T+300)
    const claim = await engine.applyOp(op(alice, "claim", {}));
    expect(claim.result).toMatchObject({ ok: true });
    expect(claimedItems(claim.result as { result: unknown }).map((i) => i.unique)).toEqual(["a"]);
  });

  it("claim returns contributor's items; double-claim is gone; closes when all claimed", async () => {
    await placeCapsule();
    await engine.applyOp(op(alice, "contribute", { item: token("a") }));
    await engine.applyOp(op(bob, "contribute", { item: token("b") }));
    clock.ms += 400_000; // past unlockAt

    expect((await engine.applyOp(op(alice, "claim", {}))).result).toMatchObject({ ok: true });
    expect((await engine.applyOp(op(alice, "claim", {}))).result).toEqual({
      ok: false,
      error: "gone",
    });

    const bobClaim = await engine.applyOp(op(bob, "claim", {}));
    expect(bobClaim.closed).toBe(true); // last claimant closes the capsule
    expect(await engine.resolveRoom(CAP_ID)).toBeUndefined();
  });

  it("claim broadcasts itemClaimed (not itemRemoved) and leaves contents frozen", async () => {
    await placeCapsule();
    await engine.applyOp(op(alice, "contribute", { item: token("a") }));
    await engine.applyOp(op(bob, "contribute", { item: token("b") }));
    clock.ms += 400_000; // past unlockAt

    const claim = await engine.applyOp(op(alice, "claim", {}));
    expect(claim.changes).toContainEqual({
      type: "itemClaimed",
      item: "a",
      by: alice.account.did,
    });
    expect(claim.changes).not.toContainEqual(expect.objectContaining({ type: "itemRemoved" }));
    // The claimed item stays in the shared contents (frozen once locked, so bob's claim set holds).
    expect((await engine.resolveRoom(CAP_ID))!.state["contents"] as OpaqueItem[]).toHaveLength(2);
  });

  it("advancePhase broadcasts transitions and closes after claimTtl", async () => {
    await placeCapsule();
    await engine.applyOp(op(alice, "contribute", { item: token("a") }));

    expect((await engine.advancePhase(CAP_ID)).changes).toEqual([]); // still filling

    clock.ms += 150_000; // past lockAt
    expect((await engine.advancePhase(CAP_ID)).changes).toContainEqual({
      type: "phaseChanged",
      phase: "locked",
    });

    clock.ms += 300_000; // past unlockAt
    expect((await engine.advancePhase(CAP_ID)).changes).toContainEqual({
      type: "phaseChanged",
      phase: "open",
    });

    clock.ms += (86400 + 10) * 1000; // past claimTtl, unclaimed
    const closed = await engine.advancePhase(CAP_ID);
    expect(closed.closed).toBe(true);
    expect(await engine.resolveRoom(CAP_ID)).toBeUndefined();
  });

  it("a derived aggregate overflow is a clean `invalid` rejection, not an uncaught 500", async () => {
    // The pot's windows do not read the contents, so to reach the engine's overflow guard we add a
    // raw derived aggregate, the shape a designer might add for display. The fixed windows keep the
    // phase in filling, so the overflow lands squarely in `total`.
    const policy = pot();
    policy.derived = { ...policy.derived, total: { sum: [{ var: "contents" }, "procedural"] } };
    await engine.placeRoom({
      game: TEST_GAME,
      id: CAP_ID,
      type: "capsule",
      location: { lat: 47.61, lng: -122.34 },
      policy,
      placedBy: alice.account.did,
      mintedBy: roomMintedBy(CAP_ID, "capsule", policy, alice),
    });
    const big = Number.MAX_SAFE_INTEGER;
    expect(
      (await engine.applyOp(op(alice, "contribute", { item: token("a", { procedural: big }) })))
        .result,
    ).toMatchObject({ ok: true }); // first contribution fits (total == MAX_SAFE_INTEGER)

    const overflowing = op(bob, "contribute", { item: token("b", { procedural: 1 }) });
    const rejected = await engine.applyOp(overflowing); // total -> MAX_SAFE_INTEGER + 1
    expect(rejected.result).toMatchObject({ ok: false, error: "invalid" });
    // the contribution is NOT applied — the capsule still holds only the first item…
    expect((await engine.resolveRoom(CAP_ID))!.state["contents"] as OpaqueItem[]).toHaveLength(1);
    // …and a retry returns the same recorded rejection (the nonce was finalized, no re-throw).
    const retry = await engine.applyOp(overflowing);
    expect(retry.replayed).toBe(true);
    expect(retry.result).toEqual(rejected.result);
  });

  it("advancePhase emits one monotonic version per phase entered", async () => {
    await placeCapsule();
    await engine.applyOp(op(alice, "contribute", { item: token("a") }));
    const v0 = (await engine.resolveRoom(CAP_ID))!.version;

    clock.ms += 500_000; // jump past BOTH lockAt (T+100) and unlockAt (T+300) in one tick
    const adv = await engine.advancePhase(CAP_ID);
    expect(adv.changes).toEqual([
      { type: "phaseChanged", phase: "locked" },
      { type: "phaseChanged", phase: "open" },
    ]);
    // each transition gets its own version (not one shared version for the jump)
    expect(adv.broadcasts.map((b) => b.version)).toEqual([v0 + 1, v0 + 2]);
    expect(adv.room?.version).toBe(v0 + 2);
  });

  it("nextTransitionAt schedules lockAt → unlockAt → claimTtl close (the timer-wheel key)", async () => {
    await placeCapsule(); // lockDelay 100, unlockDelay 200, claimTtl 1d
    const t0 = t();
    await engine.applyOp(op(alice, "contribute", { item: token("a") })); // a contributor

    let room = (await engine.resolveRoom(CAP_ID))!;
    expect(nextTransitionAt(room, t())).toBe(t0 + 100); // filling → next is lockAt

    clock.ms += 150_000; // past lockAt
    await engine.advancePhase(CAP_ID); // catch up to locked
    room = (await engine.resolveRoom(CAP_ID))!;
    expect(nextTransitionAt(room, t())).toBe(room.state["unlockAt"]); // locked → next is unlockAt

    clock.ms += 200_000; // past unlockAt
    await engine.advancePhase(CAP_ID); // → open (has a contributor, so it stays placed)
    room = (await engine.resolveRoom(CAP_ID))!;
    // open → next is the claimTtl close, measured from settlement: this tick landed 50 s after
    // unlockAt, and the schedule has to agree with the close check about that.
    expect(nextTransitionAt(room, t())).toBe((room.state["unlockAt"] as number) + 50 + 86400);

    clock.ms += (86400 + 10) * 1000; // past the claimTtl close
    room = (await engine.resolveRoom(CAP_ID))!;
    expect(nextTransitionAt(room, t())).toBe(t()); // due now (lifecycleRoomShouldClose)
  });

  it("nextTransitionAt returns 'due now' for an un-broadcast (overdue) transition", async () => {
    await placeCapsule();
    await engine.applyOp(op(alice, "contribute", { item: token("a") }));
    clock.ms += 150_000; // past lockAt, but the stored phase is still 'filling' (no tick yet)
    const room = (await engine.resolveRoom(CAP_ID))!;
    expect(room.state["phase"]).toBe("filling");
    expect(nextTransitionAt(room, t())).toBe(t()); // stored < effective → process immediately
  });

  it("a large negative shift can't push unlockAt before lockAt (a `max` floor holds)", async () => {
    // A policy protects a window with a `max` floor in its formula; the engine has to honour it
    // however far the inner term runs. The width of the floor is the game's choice, and its own
    // suite pins it, so this one says 50 s outright.
    await placeCapsule({ unlockShift: { key: "semantic", per: -1000, floorSec: 50 } });
    const t0 = t();
    await engine.applyOp(op(alice, "contribute", { item: token("a", { semantic: 100000 }) }));
    const room = (await engine.resolveRoom(CAP_ID))!;
    expect(room.state["lockAt"]).toBe(t0 + 100);
    // The inner unlockAt would land far before lockAt; the floor pins it to `lockAt + 50`, so unlock
    // never precedes lock and the window never collapses to zero (the "lock, then instant unlock" bug).
    expect(room.state["unlockAt"]).toBe((room.state["lockAt"] as number) + 50);
  });
});
