import { createWallet, signOpWithWallet, type Wallet } from "@beaconsgg/identity";
import type { OpaqueItem, OpEnvelope, OpResult, Policy } from "@beaconsgg/protocol-types";
import { beforeEach, describe, expect, it } from "vitest";
import { PolicyEngine } from "../index";
import {
  InMemoryStore,
  nonce,
  reward,
  roomMintedBy,
  timedPotPolicy,
  token,
  TEST_GAME,
} from "../testing";

const CAP_ID = "cap1@beacon.example";

type Granted = { granted?: OpaqueItem[]; items?: OpaqueItem[] };
const payload = (result: OpResult): Granted =>
  result.ok && result.result ? (result.result as Granted) : {};

describe("PolicyEngine — reward pool + grant-on-op + contributor cap (room-operation.md §9.6)", () => {
  let clock: { ms: number };
  let engine: PolicyEngine;
  let alice: Wallet;
  let bob: Wallet;
  let carol: Wallet;

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

  /** A timed pot that hands out one reward from `from` per claim, capped at `maxContributors`. */
  function grantPolicy(maxContributors: number, from = "rewards"): Policy {
    return timedPotPolicy({
      lockDelaySec: 100,
      unlockDelaySec: 200,
      claimTtl: "1d",
      grant: { op: "claim", from, count: 1 },
      maxContributors,
    });
  }

  function place(policy: Policy, rewards: OpaqueItem[]): Promise<unknown> {
    return engine.placeRoom({
      game: TEST_GAME,
      id: CAP_ID,
      type: "capsule",
      location: { lat: 47.61, lng: -122.34 },
      policy,
      placedBy: alice.account.did,
      mintedBy: roomMintedBy(CAP_ID, "capsule", policy, alice),
      state: { contents: [], rewards },
    });
  }

  function unlock(): void {
    clock.ms += 400_000; // past unlockAt (lockAt = T+100, unlockAt = T+300)
  }

  beforeEach(() => {
    clock = { ms: Date.parse("2026-06-29T00:00:00Z") };
    engine = new PolicyEngine(new InMemoryStore(), {
      now: () => clock.ms,
      replayWindowMs: Number.MAX_SAFE_INTEGER,
    });
    alice = createWallet();
    bob = createWallet();
    carol = createWallet();
  });

  it("hands each claiming contributor one reward from the pool (result.granted + itemGranted delta)", async () => {
    await place(grantPolicy(2), [reward("rw-a"), reward("rw-b")]);
    await engine.applyOp(op(alice, "contribute", { item: token("a") }));
    await engine.applyOp(op(bob, "contribute", { item: token("b") }));
    unlock();

    const aClaim = await engine.applyOp(op(alice, "claim", {}));
    expect(aClaim.result).toMatchObject({ ok: true });
    const aGranted = payload(aClaim.result).granted ?? [];
    expect(aGranted).toHaveLength(1);
    expect(aGranted[0]!.owner).toBe(alice.account.did); // custody transferred to the claimant
    // The claim still returns the contributor's own frozen items alongside the reward.
    expect((payload(aClaim.result).items ?? []).map((i) => i.unique)).toEqual(["a"]);
    expect(aClaim.changes).toContainEqual({
      type: "itemGranted",
      item: aGranted[0]!.unique,
      by: alice.account.did,
    });

    // Bob gets the OTHER pooled reward (no double-hand-out of the same item).
    const bClaim = await engine.applyOp(op(bob, "claim", {}));
    const bGranted = payload(bClaim.result).granted ?? [];
    expect(bGranted).toHaveLength(1);
    expect(bGranted[0]!.unique).not.toBe(aGranted[0]!.unique);
  });

  it("does not re-grant on a repeat claim (idempotent per actor)", async () => {
    await place(grantPolicy(2), [reward("rw-a"), reward("rw-b")]);
    await engine.applyOp(op(alice, "contribute", { item: token("a") }));
    await engine.applyOp(op(bob, "contribute", { item: token("b") }));
    unlock();

    await engine.applyOp(op(alice, "claim", {}));
    // A second claim by alice is `gone` (the claim handler's own once-gate); no extra reward leaves the pool.
    const again = await engine.applyOp(op(alice, "claim", {}));
    expect(again.result).toEqual({ ok: false, error: "gone" });
    const bClaim = await engine.applyOp(op(bob, "claim", {}));
    expect(payload(bClaim.result).granted ?? []).toHaveLength(1); // bob's reward is still available
  });

  it("caps NEW contributors at maxContributors (a full capsule stops recruiting), pool never underflows", async () => {
    await place(grantPolicy(2), [reward("rw-a"), reward("rw-b")]);
    expect(
      (await engine.applyOp(op(alice, "contribute", { item: token("a") }))).result,
    ).toMatchObject({ ok: true });
    expect(
      (await engine.applyOp(op(bob, "contribute", { item: token("b") }))).result,
    ).toMatchObject({ ok: true });
    // Carol is a THIRD distinct contributor past the cap of 2 → rejected.
    const carolTry = await engine.applyOp(op(carol, "contribute", { item: token("c") }));
    expect(carolTry.result).toMatchObject({ ok: false, error: "full" });
    // An existing contributor may still add another item (the cap is on contributors, not items).
    expect(
      (await engine.applyOp(op(alice, "contribute", { item: token("a2") }))).result,
    ).toMatchObject({ ok: true });
  });

  it("claim still succeeds without a reward when the pool is exhausted (grant is a bonus, not a gate)", async () => {
    await place(grantPolicy(2), [reward("rw-a")]); // only ONE reward, but two contributors
    await engine.applyOp(op(alice, "contribute", { item: token("a") }));
    await engine.applyOp(op(bob, "contribute", { item: token("b") }));
    unlock();

    await engine.applyOp(op(alice, "claim", {})); // takes the sole reward
    const bClaim = await engine.applyOp(op(bob, "claim", {}));
    expect(bClaim.result).toMatchObject({ ok: true }); // bob still claims his own items…
    expect(payload(bClaim.result).granted).toBeUndefined(); // …just no bonus reward
    expect(bClaim.changes).not.toContainEqual(expect.objectContaining({ type: "itemGranted" }));
  });

  it("rejects a seeded reward with missing/invalid provenance at place", async () => {
    const policy = grantPolicy(1);
    const unsigned: OpaqueItem = { unique: "rw-x", birth: { class: "ColorResource" }, owner: null };
    await expect(
      engine.placeRoom({
        game: TEST_GAME,
        id: CAP_ID,
        type: "capsule",
        location: { lat: 47.61, lng: -122.34 },
        policy,
        placedBy: alice.account.did,
        mintedBy: roomMintedBy(CAP_ID, "capsule", policy, alice),
        state: { contents: [], rewards: [unsigned] },
      }),
    ).rejects.toThrow(/reward/i);
  });

  it("keys the provenance gate off grant.from (a custom pool key), not a literal 'rewards'", async () => {
    // The grant READ uses grant.from generically, so the place-time gate must too — otherwise a policy
    // whose grant.from names a different, unsigned pool could hand out forged items off the HTTP path.
    const policy = grantPolicy(1, "prizes");
    const unsigned: OpaqueItem = { unique: "pz-x", birth: { class: "Prize" }, owner: null };
    await expect(
      engine.placeRoom({
        game: TEST_GAME,
        id: CAP_ID,
        type: "capsule",
        location: { lat: 47.61, lng: -122.34 },
        policy,
        placedBy: alice.account.did,
        mintedBy: roomMintedBy(CAP_ID, "capsule", policy, alice),
        state: { contents: [], prizes: [unsigned] },
      }),
    ).rejects.toThrow(/reward/i);
  });

  it("threads a content-addressed media header onto the placed room", async () => {
    const policy = grantPolicy(1);
    const media = [{ type: "image", role: "full" as const, hash: "h", uris: ["h@a.example"] }];
    const room = (await engine.placeRoom({
      game: TEST_GAME,
      id: CAP_ID,
      type: "capsule",
      location: { lat: 47.61, lng: -122.34 },
      policy,
      placedBy: alice.account.did,
      mintedBy: roomMintedBy(CAP_ID, "capsule", policy, alice),
      media,
      state: { contents: [], rewards: [reward("rw-a")] },
    })) as { media?: unknown };
    expect(room.media).toEqual(media);
  });
});
