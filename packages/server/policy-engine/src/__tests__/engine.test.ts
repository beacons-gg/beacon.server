import { createWallet, signOpWithWallet, type Wallet } from "@beaconsgg/identity";
import {
  ANY_GAME,
  type OpaqueItem,
  type OpEnvelope,
  type Policy,
  type Room,
} from "@beaconsgg/protocol-types";
import { beforeEach, describe, expect, it } from "vitest";
import { nextTransitionAt, PlaceConflictError, PolicyEngine } from "../index";
import { bagPolicy, InMemoryStore, nonce, roomMintedBy, token, TEST_GAME } from "../testing";

// ── Test helpers ── (the generic policies and signed items come from `../testing`)

/** A signed content item for op params, of class `cls` when an accept gate needs one. */
const item = (unique: string, cls = "Token"): OpaqueItem => token(unique, {}, { cls });

const JAR_ID = "jar1@beacon.example";

function placeJar(
  engine: PolicyEngine,
  owner: Wallet,
  options: Parameters<typeof bagPolicy>[0] = {},
  policy: Policy = bagPolicy(options),
): Promise<unknown> {
  return engine.placeRoom({
    game: TEST_GAME,
    id: JAR_ID,
    type: "jar",
    location: { lat: 47.61, lng: -122.34 },
    policy,
    placedBy: owner.account.did,
    mintedBy: roomMintedBy(JAR_ID, "jar", policy, owner),
    live: "wss://beacon.example/rooms/jar1",
  });
}

/** A jar policy whose `add` every game may run: for suites about the server's admission, not the room's. */
function addOpenToEveryGame(): Policy {
  const policy = bagPolicy();
  return { ...policy, ops: { ...policy.ops, add: { role: "public", games: [ANY_GAME] } } };
}

function op(
  wallet: Wallet,
  name: string,
  params: Record<string, unknown>,
  n = nonce(),
): OpEnvelope {
  return signOpWithWallet(wallet, { game: TEST_GAME, op: name, room: JAR_ID, nonce: n, params });
}

describe("PolicyEngine — Jar lifecycle", () => {
  let engine: PolicyEngine;
  let alice: Wallet;
  let bob: Wallet;

  beforeEach(() => {
    engine = new PolicyEngine(new InMemoryStore());
    alice = createWallet();
    bob = createWallet();
  });

  it("place -> add -> list -> take, with atomic ownership transfer", async () => {
    await placeJar(engine, alice);

    const add = await engine.applyOp(op(alice, "add", { item: item("r1") }));
    expect(add.result).toMatchObject({ ok: true, version: 2 });
    expect(add.changes).toEqual([
      {
        type: "itemAdded",
        item: expect.objectContaining({ unique: "r1", owner: null }),
        by: alice.account.did,
      },
    ]);

    const list = await engine.applyOp(op(alice, "list", {}));
    expect(list.result).toMatchObject({ ok: true });
    expect((list.result as { result: { contents: OpaqueItem[] } }).result.contents).toHaveLength(1);

    const take = await engine.applyOp(op(bob, "take", { item: "r1" }));
    expect(take.result).toMatchObject({ ok: true });
    const taken = (take.result as { result: { item: OpaqueItem } }).result.item;
    expect(taken.unique).toBe("r1");
    expect(taken.owner).toBe(bob.account.did); // authority transferred to the taker
  });

  describe("provenance gate — add requires verified mintedBy (beacon.core `doc/spec/identity.md` §5.1)", () => {
    const unsigned = (unique: string): OpaqueItem => {
      const { mintedBy: _mintedBy, ...rest } = item(unique);
      return rest;
    };

    it("accepts a resource with valid signed provenance", async () => {
      await placeJar(engine, alice);
      const add = await engine.applyOp(op(alice, "add", { item: item("r1") }));
      expect(add.result).toMatchObject({ ok: true });
    });

    it("rejects a resource with NO mintedBy (provenance is required, not optional)", async () => {
      await placeJar(engine, alice);
      const add = await engine.applyOp(op(alice, "add", { item: unsigned("r1") }));
      expect(add.result).toMatchObject({ ok: false, error: "invalid" });
    });

    it("names a top-level item field it does not know, placed inside the params", async () => {
      await placeJar(engine, alice);
      const add = await engine.applyOp(op(alice, "add", { item: { ...item("r1"), tint: "blue" } }));
      expect(add.result).toMatchObject({ ok: false, error: "invalid", fields: ["item.tint"] });
      // Nested, the prefix leads the path: `item.match.x`, not `match.item.x`.
      const nested = await engine.applyOp(
        op(alice, "add", { item: { ...item("r3"), match: { class: "c", rarity: 2 } } }),
      );
      expect(nested.result).toMatchObject({ fields: ["item.match.rarity"] });
      // A resource that is simply malformed keeps the old answer.
      const junk = await engine.applyOp(op(alice, "add", { item: { unique: "r2" } }));
      expect(junk.result).toEqual({
        ok: false,
        error: "invalid",
        message: "params.item is not a valid item",
      });
    });

    it("rejects a resource whose signed birth fields were tampered", async () => {
      await placeJar(engine, alice);
      // Mutating a signed birth field invalidates the item's mintedBy signature.
      const signed = item("r1");
      const tampered = { ...signed, birth: { ...signed.birth, class: "Contraband" } };
      const add = await engine.applyOp(op(alice, "add", { item: tampered }));
      expect(add.result).toMatchObject({ ok: false, error: "invalid" });
    });

    it("rejects a PLACEMENT seeded with an unsigned resource (the place-time gate — no bypass)", async () => {
      await expect(
        engine.placeRoom({
          game: TEST_GAME,
          id: "jar-seed@beacon.example",
          type: "jar",
          location: { lat: 47.61, lng: -122.34 },
          policy: bagPolicy(),
          placedBy: alice.account.did,
          mintedBy: roomMintedBy("jar-seed@beacon.example", "jar", bagPolicy(), alice),
          state: { contents: [unsigned("seed")] },
        }),
      ).rejects.toThrow(/provenance/);
    });

    it("accepts a placement seeded with a validly signed resource", async () => {
      const room = await engine.placeRoom({
        game: TEST_GAME,
        id: "jar-seed2@beacon.example",
        type: "jar",
        location: { lat: 47.61, lng: -122.34 },
        policy: bagPolicy(),
        placedBy: alice.account.did,
        mintedBy: roomMintedBy("jar-seed2@beacon.example", "jar", bagPolicy(), alice),
        state: { contents: [item("seed")] },
      });
      expect((room.state["contents"] as OpaqueItem[]).map((r) => r.unique)).toEqual(["seed"]);
    });

    it("rejects a PLACEMENT whose container mintedBy doesn't match the room identity {unique, kind}", async () => {
      await expect(
        engine.placeRoom({
          game: TEST_GAME,
          id: "jar-mismatch@beacon.example",
          type: "jar",
          location: { lat: 47.61, lng: -122.34 },
          policy: bagPolicy(),
          placedBy: alice.account.did,
          mintedBy: roomMintedBy("a-different-id@beacon.example", "jar", bagPolicy(), alice), // signed for another unique
        }),
      ).rejects.toThrow(/provenance/);
    });

    it("accepts a placement whose mintedBy is signed by a party other than the placer (minter is decoupled)", async () => {
      // Minter is decoupled from placer (beacon.core `doc/spec/identity.md` §4.3): a valid
      // `mintedBy` signed by another key is accepted and stamped verbatim — the signature (not
      // minter===placer) is what a block-list keys on.
      const room = await engine.placeRoom({
        game: TEST_GAME,
        id: "jar-notmine@beacon.example",
        type: "jar",
        location: { lat: 47.61, lng: -122.34 },
        policy: bagPolicy(),
        placedBy: alice.account.did,
        mintedBy: roomMintedBy("jar-notmine@beacon.example", "jar", bagPolicy(), bob), // valid sig by bob, not the placer
      });
      expect(room.mintedBy?.id).toBe(bob.account.did);
    });
  });

  it("concurrent grabs never double-spend the same item (one wins, one gets `gone`)", async () => {
    await placeJar(engine, alice);
    // A filler item keeps the jar open after the contested item is taken, so the loser
    // gets `gone` (not `unknownRoom` from onEmpty-close).
    await engine.applyOp(op(alice, "add", { item: item("contested") }));
    await engine.applyOp(op(alice, "add", { item: item("filler") }));

    const first = await engine.applyOp(op(bob, "take", { item: "contested" }));
    const second = await engine.applyOp(op(alice, "take", { item: "contested" }));

    expect(first.result).toMatchObject({ ok: true });
    expect(second.result).toEqual({ ok: false, error: "gone" });
  });

  it("the jar vanishes when emptied (onEmpty: close)", async () => {
    await placeJar(engine, alice);
    await engine.applyOp(op(alice, "add", { item: item("r1") }));

    const take = await engine.applyOp(op(bob, "take", { item: "r1" }));
    expect(take.closed).toBe(true);
    expect(take.changes).toContainEqual({ type: "closed" });
    expect(await engine.resolveRoom(JAR_ID)).toBeUndefined();
  });

  it("a dropped op recovers via the same nonce — no dupe, no loss", async () => {
    await placeJar(engine, alice);
    await engine.applyOp(op(alice, "add", { item: item("r1") }));

    const sharedNonce = nonce();
    const takeOp = op(bob, "take", { item: "r1" }, sharedNonce);

    const firstTry = await engine.applyOp(takeOp); // succeeds server-side
    const retry = await engine.applyOp(takeOp); // reply was "lost" — client retries same nonce

    expect(firstTry.result).toMatchObject({ ok: true });
    expect(retry.replayed).toBe(true);
    expect(retry.result).toEqual(firstTry.result); // identical recovered result
    expect(retry.changes).toEqual([]); // not re-broadcast
  });

  it("take from an empty jar -> `empty`", async () => {
    await placeJar(engine, alice);
    expect((await engine.applyOp(op(bob, "take", { item: "x" }))).result).toEqual({
      ok: false,
      error: "empty",
    });
  });
});

describe("PolicyEngine — structural & policy checks", () => {
  let engine: PolicyEngine;
  let alice: Wallet;

  beforeEach(() => {
    engine = new PolicyEngine(new InMemoryStore());
    alice = createWallet();
  });

  it("enforces capacity (`full`)", async () => {
    await placeJar(engine, alice, { capacity: 1 });
    expect((await engine.applyOp(op(alice, "add", { item: item("a") }))).result).toMatchObject({
      ok: true,
    });
    expect((await engine.applyOp(op(alice, "add", { item: item("b") }))).result).toEqual({
      ok: false,
      error: "full",
    });
  });

  it("enforces the accept predicate (`denied`)", async () => {
    await placeJar(engine, alice, { accept: { class: ["Coin"] } });
    const bad = await engine.applyOp(op(alice, "add", { item: item("r1", "Token") }));
    expect(bad.result).toMatchObject({ ok: false, error: "denied" });
    const good = await engine.applyOp(op(alice, "add", { item: item("r2", "Coin") }));
    expect(good.result).toMatchObject({ ok: true });
  });

  it("rejects an op on a missing room (`unknownRoom`)", async () => {
    expect((await engine.applyOp(op(alice, "take", { item: "x" }))).result).toEqual({
      ok: false,
      error: "unknownRoom",
    });
  });

  it("rejects an op not in the policy (`denied`)", async () => {
    await placeJar(engine, alice);
    expect(
      (await engine.applyOp(op(alice, "contribute", { item: item("r1") }))).result,
    ).toMatchObject({ ok: false, error: "denied" });
  });

  it("rejects a tampered signature (`badsig`)", async () => {
    await placeJar(engine, alice);
    const signed = op(alice, "add", { item: item("r1") });
    const tampered = { ...signed, params: { item: item("EVIL") } };
    expect((await engine.applyOp(tampered)).result).toMatchObject({ ok: false, error: "badsig" });
  });

  it("refuses a value canonical JSON has no form for as `invalid`, not a throw", async () => {
    await placeJar(engine, alice);
    const signed = op(alice, "take", { item: "x", k: 1 });
    // Only JSON.parse writes it: `1e400` parses to Infinity, which the verifier cannot canonicalize.
    const bad = JSON.parse(JSON.stringify(signed).replace('"k":1', '"k":1e400')) as typeof signed;
    expect((await engine.applyOp(bad)).result).toMatchObject({
      ok: false,
      error: "invalid",
      message: "attribution failed: malformed",
    });
  });

  it("recoverResult returns a prior op's result by actor, op and nonce", async () => {
    const bob = createWallet();
    await placeJar(engine, alice);
    const n = nonce();
    await engine.applyOp(op(alice, "add", { item: item("r1") }, n));
    expect(await engine.recoverResult(alice.account.did, "add", n)).toMatchObject({
      ok: true,
      version: 2,
    });
    expect(await engine.recoverResult(bob.account.did, "add", n)).toBeUndefined();
    expect(await engine.recoverResult(alice.account.did, "take", n)).toBeUndefined();
  });

  it("keeps a nonce to its actor and op: reusing it under another op or by another account applies", async () => {
    const bob = createWallet();
    await placeJar(engine, alice);
    const n = nonce();
    await engine.applyOp(op(alice, "add", { item: item("r1") }, n));

    // Another account's op under the same nonce is its own request, not a replay of alice's.
    const bobs = await engine.applyOp(op(bob, "add", { item: item("r2") }, n));
    expect(bobs).toMatchObject({ replayed: false, result: { ok: true, version: 3 } });
    // So is another op of alice's under it.
    const take = await engine.applyOp(op(alice, "take", { item: "r2" }, n));
    expect(take).toMatchObject({ replayed: false, result: { ok: true, version: 4 } });
    // Each still replays its own record.
    expect(await engine.applyOp(op(bob, "add", { item: item("r2") }, n))).toMatchObject({
      replayed: true,
      result: { ok: true, version: 3 },
    });
  });

  it("answers a retry that spans the upgrade from the unscoped record, for two replay windows only", async () => {
    let now = Date.now();
    const store = new InMemoryStore();
    const started = new PolicyEngine(store, { now: () => now });
    await placeJar(started, alice);
    // What the build before the scoping recorded for an op it applied.
    const n = nonce();
    await store.commit([{ kind: "putNonce", nonce: `op:${n}`, result: { ok: true, version: 7 } }]);

    const retry = op(alice, "add", { item: item("r1") }, n);
    expect(await started.applyOp(retry)).toMatchObject({ replayed: true, result: { version: 7 } });

    // Past two windows no envelope from before the restart is fresh, so the old key is not read.
    now += 10 * 60_000 + 1;
    const later = op(alice, "add", { item: item("r1") }, n);
    expect(await new PolicyEngine(store, { now: () => now }).applyOp(later)).toMatchObject({
      replayed: false,
    });
  });

  it("nextTransitionAt is undefined for a non-lifecycle room (a Jar is never on the timer-wheel)", async () => {
    await placeJar(engine, alice);
    const room = (await engine.resolveRoom(JAR_ID))!;
    expect(nextTransitionAt(room, Math.floor(Date.now() / 1000))).toBeUndefined();
  });
});

describe("PolicyEngine — idempotent place, optimistic concurrency, freshness", () => {
  let engine: PolicyEngine;
  let alice: Wallet;
  let bob: Wallet;

  beforeEach(() => {
    engine = new PolicyEngine(new InMemoryStore());
    alice = createWallet();
    bob = createWallet();
  });

  const placeInput = (id: string) => ({
    game: TEST_GAME,
    id,
    type: "jar",
    location: { lat: 47.61, lng: -122.34 },
    policy: bagPolicy(),
    placedBy: alice.account.did,
    mintedBy: roomMintedBy(id, "jar", bagPolicy(), alice),
  });

  it("place is idempotent by nonce — a retry returns the original id, no duplicate", async () => {
    const n = nonce();
    const first = await engine.place(placeInput("a@h"), n);
    const retry = await engine.place(placeInput("b@h"), n); // same nonce, different minted id
    expect(first.replayed).toBe(false);
    expect(retry.replayed).toBe(true);
    expect(retry.id).toBe(first.id); // original id, not "b@h"
    expect(await engine.resolveRoom("b@h")).toBeUndefined();
  });

  it("place is idempotent by room id — a same-actor re-place with a FRESH nonce returns the existing room (lost-response retry)", async () => {
    // The lost-response case: the server committed the room but the HTTP reply dropped, so the client
    // retries with a *fresh* nonce and the same container id. Must return the existing room (no 500 loop
    // that would strand the container), not create/clobber a rival.
    const first = await engine.place(placeInput("stable@h"), nonce());
    expect(first.replayed).toBe(false);
    const retry = await engine.place(placeInput("stable@h"), nonce()); // different nonce, same id + placer
    expect(retry.replayed).toBe(true);
    expect(retry.id).toBe("stable@h");
    expect(retry.version).toBe(1); // the original room, not re-created
  });

  it("place rejects a DIFFERENT actor claiming an already-placed id (conflict, not a silent clobber)", async () => {
    await engine.place(placeInput("shared@h"), nonce()); // placed by alice
    const bobInput = {
      ...placeInput("shared@h"),
      placedBy: bob.account.did,
      mintedBy: roomMintedBy("shared@h", "jar", bagPolicy(), bob),
    };
    await expect(engine.place(bobInput, nonce())).rejects.toBeInstanceOf(PlaceConflictError);
    // Alice's room is intact — the second placement did not overwrite it.
    expect((await engine.resolveRoom("shared@h"))?.placedBy).toBe(alice.account.did);
  });

  it("placeRoom rejects a duplicate id", async () => {
    await engine.placeRoom(placeInput("dup@h"));
    await expect(engine.placeRoom(placeInput("dup@h"))).rejects.toThrow();
  });

  it("a place nonce and an op nonce in the same namespace don't collide", async () => {
    const n = nonce();
    const placed = await engine.place(placeInput(JAR_ID), n); // records place:n
    expect(placed.replayed).toBe(false);
    // An op reusing the same nonce must EXECUTE, not be swallowed as a `place` replay.
    const added = await engine.applyOp(op(alice, "add", { item: item("r1") }, n));
    expect(added.replayed).toBe(false);
    expect(added.result).toMatchObject({ ok: true, version: 2 });
  });

  it("enforces baseVersion (stale) optimistic concurrency", async () => {
    await placeJar(engine, alice);
    await engine.applyOp(op(alice, "add", { item: item("r1") })); // version -> 2
    const stale = signOpWithWallet(bob, {
      game: TEST_GAME,
      op: "take",
      room: JAR_ID,
      nonce: nonce(),
      params: { item: "r1" },
      baseVersion: 1,
    });
    expect((await engine.applyOp(stale)).result).toEqual({ ok: false, error: "stale" });
    const fresh = signOpWithWallet(bob, {
      game: TEST_GAME,
      op: "take",
      room: JAR_ID,
      nonce: nonce(),
      params: { item: "r1" },
      baseVersion: 2,
    });
    expect((await engine.applyOp(fresh)).result).toMatchObject({ ok: true });
  });

  it("a closed room reports `expired`, not `unknownRoom`", async () => {
    await placeJar(engine, alice);
    await engine.applyOp(op(alice, "add", { item: item("r1") }));
    await engine.applyOp(op(bob, "take", { item: "r1" })); // empties -> closes
    expect((await engine.applyOp(op(bob, "take", { item: "r1" }))).result).toEqual({
      ok: false,
      error: "expired",
    });
  });

  it("rejects an op whose issuedAt is outside the replay window", async () => {
    await placeJar(engine, alice);
    const old = signOpWithWallet(alice, {
      game: TEST_GAME,
      op: "add",
      room: JAR_ID,
      nonce: nonce(),
      issuedAt: "2020-01-01T00:00:00Z",
      params: { item: item("r1") },
    });
    // Its own code: the fix is the device clock, and the boundary sends the same one.
    expect((await engine.applyOp(old)).result).toMatchObject({ ok: false, error: "clockSkew" });
  });
});

describe("PolicyEngine — admission consult", () => {
  it("denies a banned actor, allows others, recovers replays, and lets a lifted ban through", async () => {
    const alice = createWallet();
    const bob = createWallet();
    const banned = new Set<string>();
    const engine = new PolicyEngine(new InMemoryStore(), {
      isDenied: (actor) => banned.has(actor),
    });
    await placeJar(engine, alice);

    const firstOp = op(alice, "add", { item: item("r1") });
    const first = await engine.applyOp(firstOp);
    expect(first.result).toMatchObject({ ok: true });

    // The operator bans Alice.
    banned.add(alice.account.did);

    // The op she landed before the ban still recovers, because the consult sits after replay: that
    // is what keeps a lost-reply retry working for someone banned between the send and the retry.
    const replay = await engine.applyOp(firstOp);
    expect(replay.replayed).toBe(true);
    expect(replay.result).toEqual(first.result);

    const denied = await engine.applyOp(op(alice, "add", { item: item("r2") }));
    expect(denied.result).toEqual({ ok: false, error: "denied", message: "actor not admitted" });

    // The ban is per actor, so Bob is untouched by it.
    const bobAdd = await engine.applyOp(op(bob, "add", { item: item("r3") }));
    expect(bobAdd.result).toMatchObject({ ok: true });

    // Lifting the ban lets the SAME envelope through, nonce and all: the verdict was never
    // finalized, so a client does not have to mint a fresh op to recover from an unban.
    const refused = op(alice, "add", { item: item("r4") });
    expect((await engine.applyOp(refused)).result).toMatchObject({ ok: false, error: "denied" });
    banned.delete(alice.account.did);
    expect((await engine.applyOp(refused)).result).toMatchObject({ ok: true });
  });
});

describe("PolicyEngine — membership consult", () => {
  it("refuses a non-member's write but not their read, unbilled, and admits them on retry", async () => {
    const alice = createWallet();
    const bob = createWallet();
    const members = new Set<string>([alice.account.did]);
    const billed: string[] = [];
    const engine = new PolicyEngine(new InMemoryStore(), {
      isNotMember: (actor) => !members.has(actor),
      isRateLimited: (actor) => {
        billed.push(actor);
        return false;
      },
    });
    await placeJar(engine, alice);

    const refused = op(bob, "add", { item: item("r1") });
    expect((await engine.applyOp(refused)).result).toEqual({
      ok: false,
      error: "notMember",
      message: "not a member",
    });
    expect(billed).not.toContain(bob.account.did);

    // A read is never gated: membership is about writing.
    expect((await engine.applyOp(op(bob, "list", {}))).result).toMatchObject({ ok: true });

    // Not finalized under the nonce, so the same envelope goes through once Bob is admitted.
    members.add(bob.account.did);
    expect((await engine.applyOp(refused)).result).toMatchObject({ ok: true });
  });
});

describe("PolicyEngine — game admission consult", () => {
  it("refuses an unadmitted game, without billing it, and lets it in the moment it is listed", async () => {
    const alice = createWallet();
    const admitted = new Set<string>(["kites"]);
    const billed: string[] = [];
    const engine = new PolicyEngine(new InMemoryStore(), {
      isAppDenied: (app) => app === undefined || !admitted.has(app),
      isRateLimited: (actor) => {
        billed.push(actor);
        return false;
      },
    });
    await placeJar(engine, alice, {}, addOpenToEveryGame());

    const fromKites = signOpWithWallet(alice, {
      op: "add",
      room: JAR_ID,
      nonce: nonce(),
      game: "kites",
      params: { item: item("r1") },
    });
    expect((await engine.applyOp(fromKites)).result).toMatchObject({ ok: true });

    const fromElsewhere = signOpWithWallet(alice, {
      op: "add",
      room: JAR_ID,
      nonce: nonce(),
      game: "other-game",
      params: { item: item("r2") },
    });
    expect((await engine.applyOp(fromElsewhere)).result).toEqual({
      ok: false,
      error: "gameNotAdmitted",
      message: "game not admitted",
    });

    // Admission precedes billing: the refused op never reached the budget consult, so an
    // unadmitted game cannot spend the player's account budget by being refused in a loop.
    expect(billed).toEqual([alice.account.did]);

    // The verdict is not finalized under the nonce, so an operator adding the slug lets the SAME
    // envelope through — the operationally important case, because a client that has to mint a
    // fresh op to recover is a client that has already shown the player an error.
    admitted.add("other-game");
    expect((await engine.applyOp(fromElsewhere)).result).toMatchObject({ ok: true });
  });

  it("sits after replay, so an op applied before the list narrowed still recovers", async () => {
    const alice = createWallet();
    const admitted = new Set<string>(["kites"]);
    const engine = new PolicyEngine(new InMemoryStore(), {
      isAppDenied: (app) => app === undefined || !admitted.has(app),
    });
    await placeJar(engine, alice, {}, addOpenToEveryGame());

    const first = signOpWithWallet(alice, {
      op: "add",
      room: JAR_ID,
      nonce: nonce(),
      game: "kites",
      params: { item: item("r1") },
    });
    const applied = await engine.applyOp(first);
    expect(applied.result).toMatchObject({ ok: true });

    admitted.delete("kites");

    const replay = await engine.applyOp(first);
    expect(replay.replayed).toBe(true);
    expect(replay.result).toEqual(applied.result);
  });

  it("refuses after the ban, so a banned actor learns nothing about the admission list", async () => {
    // Both refusals are a 403 to the caller, but the codes differ, and which one comes back is the
    // observable proof of the order: `denied` means the operator banned this actor, full stop.
    const alice = createWallet();
    const engine = new PolicyEngine(new InMemoryStore(), {
      isDenied: () => true,
      isAppDenied: () => true,
    });
    await placeJar(engine, alice, {}, addOpenToEveryGame());
    const env = signOpWithWallet(alice, {
      op: "add",
      room: JAR_ID,
      nonce: nonce(),
      game: "other-game",
      params: { item: item("r1") },
    });
    expect((await engine.applyOp(env)).result).toMatchObject({ ok: false, error: "denied" });
  });
});

describe("PolicyEngine — admission before the room", () => {
  // The client SDK's `probeDevice` sends a `list` op to a room id that was never placed and reads
  // the code: `denied` is a blocked account, `deviceRevoked` a revoked device, and `unknownRoom`
  // means the device may write. So both admission checks must answer before the room lookup does.
  // The store is empty, so `op`'s room was never placed.
  const answer = async (opts: { blocked?: boolean; revoked?: boolean }) => {
    const engine = new PolicyEngine(new InMemoryStore(), {
      isDenied: () => opts.blocked ?? false,
      isDeviceRevoked: () => opts.revoked ?? false,
    });
    return (await engine.applyOp(op(createWallet(), "list", {}))).result;
  };

  it("answers denied, not unknownRoom, to a blocked account's op on a room that does not exist", async () => {
    expect(await answer({ blocked: true })).toMatchObject({ ok: false, error: "denied" });
    // The block wins over a revoked device too, so `denied` always means the account.
    expect(await answer({ blocked: true, revoked: true })).toMatchObject({ error: "denied" });
  });

  it("answers deviceRevoked for a revoked device, and unknownRoom only when both checks pass", async () => {
    expect(await answer({ revoked: true })).toMatchObject({ ok: false, error: "deviceRevoked" });
    expect(await answer({})).toMatchObject({ ok: false, error: "unknownRoom" });
  });
});

describe("PolicyEngine — a room belongs to its game", () => {
  const add = (wallet: Wallet, game: string | undefined, unique: string): OpEnvelope =>
    signOpWithWallet(wallet, {
      op: "add",
      room: JAR_ID,
      nonce: nonce(),
      ...(game === undefined ? {} : { game }),
      params: { item: item(unique) },
    });

  it("stamps the placing game on the room", async () => {
    const engine = new PolicyEngine(new InMemoryStore());
    const room = (await placeJar(engine, createWallet())) as Room;
    expect(room.game).toBe(TEST_GAME);
  });

  it("takes its own game's ops, and refuses another game's or a slugless one with gameNotAccepted", async () => {
    const alice = createWallet();
    const engine = new PolicyEngine(new InMemoryStore());
    await placeJar(engine, alice);

    expect((await engine.applyOp(add(alice, TEST_GAME, "r1"))).result).toMatchObject({ ok: true });
    for (const game of ["other-game", undefined]) {
      expect((await engine.applyOp(add(alice, game, "r2"))).result).toEqual({
        ok: false,
        error: "gameNotAccepted",
        message: "op not open to this game: add",
      });
    }
  });

  it("takes another game's op only where the policy opens that op to it", async () => {
    const alice = createWallet();
    const engine = new PolicyEngine(new InMemoryStore());
    const base = bagPolicy();
    const policy: Policy = {
      ...base,
      ops: { ...base.ops, add: { role: "public", games: ["game-b"] } },
    };
    await placeJar(engine, alice, {}, policy);

    expect((await engine.applyOp(add(alice, "game-b", "r1"))).result).toMatchObject({ ok: true });
    expect((await engine.applyOp(add(alice, "game-c", "r2"))).result).toMatchObject({
      error: "gameNotAccepted",
    });
    const take = signOpWithWallet(alice, {
      op: "take",
      room: JAR_ID,
      nonce: nonce(),
      game: "game-b",
      params: { unique: "r1" },
    });
    expect((await engine.applyOp(take)).result).toMatchObject({ error: "gameNotAccepted" });
  });

  it("records the refusal under the nonce, like the room's other policy refusals", async () => {
    const alice = createWallet();
    const engine = new PolicyEngine(new InMemoryStore());
    await placeJar(engine, alice);
    const env = add(alice, "other-game", "r1");
    const first = await engine.applyOp(env);
    const again = await engine.applyOp(env);
    expect(again.replayed).toBe(true);
    expect(again.result).toEqual(first.result);
  });
});

describe("PolicyEngine — device revocation consult", () => {
  it("denies a new op from a revoked device; allows others; replays still recover", async () => {
    const alice = createWallet();
    const revoked = new Set<string>();
    const engine = new PolicyEngine(new InMemoryStore(), {
      isDeviceRevoked: (_account, device) => revoked.has(device),
    });
    await placeJar(engine, alice);

    const firstOp = op(alice, "add", { item: item("r1") });
    const first = await engine.applyOp(firstOp);
    expect(first.result).toMatchObject({ ok: true });

    // The account's signing device is later revoked.
    revoked.add(firstOp.device);

    // A NEW op from that device is denied…
    const denied = await engine.applyOp(op(alice, "add", { item: item("r2") }));
    expect(denied.result).toEqual({ ok: false, error: "deviceRevoked", message: "device revoked" });

    // …but the already-applied op still recovers idempotently (the check is after replay).
    const replay = await engine.applyOp(firstOp);
    expect(replay.replayed).toBe(true);
    expect(replay.result).toEqual(first.result);
  });
});
