/**
 * `react`, the generic reaction op (`doc/spec/room-operation.md` §9.6). The engine half: a reaction
 * must point at something the room actually holds, one player leaves one reaction per target, the
 * room's ledger is bounded, and everything else (who may react, and when) is the ordinary
 * `ops.react` role/phase gate the engine already runs for every op.
 *
 * The policies here are written inline where the op's own rules are under test: it is
 * game-agnostic. The phase cases reach for the generic timed pot (`../testing`) because a lifecycle
 * is exactly what they need. A shipped game's policy is run in `shipped-policies.test.ts`.
 */
import { createWallet, signOpWithWallet, type Wallet } from "@beaconsgg/identity";
import {
  MAX_REACTION_KIND_LEN,
  type OpaqueItem,
  type OpEnvelope,
  type OpResult,
  type Policy,
} from "@beaconsgg/protocol-types";
import { beforeEach, describe, expect, it } from "vitest";
import { getReactions, MAX_OP_LEDGER, PolicyEngine } from "../index";
import {
  InMemoryStore,
  nonce,
  reward,
  roomMintedBy,
  timedPotPolicy,
  token,
  TEST_GAME,
} from "../testing";

const ROOM_ID = "react1@beacon.example";

/** A room anyone may contribute to and any contributor may react in — the shape both game rooms take. */
function reactPolicy(over: Partial<Policy> = {}): Policy {
  return {
    ops: {
      contribute: { role: "public" },
      react: { role: "contributor" },
    },
    ...over,
  };
}

/** The shipped reader, over a room that may not exist — so the tests exercise what production does. */
const reactionsOf = (room: { state: Record<string, unknown> } | undefined) =>
  getReactions(room?.state ?? {});

const resultOf = (result: OpResult): Record<string, unknown> =>
  result.ok && result.result ? (result.result as Record<string, unknown>) : {};

const versionOf = (result: OpResult): number => (result.ok ? result.version : -1);

describe("PolicyEngine — react (room-operation.md §9.6)", () => {
  let engine: PolicyEngine;
  let alice: Wallet;
  let bob: Wallet;

  beforeEach(() => {
    engine = new PolicyEngine(new InMemoryStore());
    alice = createWallet();
    bob = createWallet();
  });

  function op(
    wallet: Wallet,
    name: string,
    params: Record<string, unknown>,
    baseVersion?: number,
  ): OpEnvelope {
    return signOpWithWallet(wallet, {
      game: TEST_GAME,
      op: name,
      room: ROOM_ID,
      nonce: nonce(),
      params,
      ...(baseVersion !== undefined ? { baseVersion } : {}),
    });
  }

  function place(policy: Policy, state: Record<string, unknown> = { contents: [] }) {
    return engine.placeRoom({
      game: TEST_GAME,
      id: ROOM_ID,
      type: "capsule",
      location: { lat: 47.61, lng: -122.34 },
      policy,
      placedBy: alice.account.did,
      mintedBy: roomMintedBy(ROOM_ID, "capsule", policy, alice),
      state,
    });
  }

  /** Seat `who` as a contributor (the role `ops.react` gates on) and return the item they put in. */
  async function contribute(who: Wallet, unique: string): Promise<OpaqueItem> {
    const item = token(unique);
    const applied = await engine.applyOp(op(who, "contribute", { item: item }));
    expect(applied.result.ok).toBe(true);
    return item;
  }

  it("records a reaction on a contributed item and broadcasts it", async () => {
    await place(reactPolicy());
    await contribute(alice, "m1");

    const applied = await engine.applyOp(op(alice, "react", { target: "m1", kind: "love" }));

    expect(applied.result.ok).toBe(true);
    const [recorded] = reactionsOf(applied.room);
    expect(recorded).toMatchObject({ by: alice.account.did, target: "m1", kind: "love" });
    expect(recorded?.at).toBeGreaterThan(0);
    // The whole record rides the live channel, so a watcher renders it without re-reading the room.
    expect(applied.changes).toEqual([{ type: "reactionAdded", reaction: recorded }]);
    // The op result names the reaction by the id the ledger stored it under.
    expect(resultOf(applied.result)["reaction"]).toBe(recorded?.unique);
  });

  it("reacts to a PLAYER — a recorded contributor's did (the challenge Team case)", async () => {
    await place(reactPolicy());
    await contribute(alice, "m1");
    await contribute(bob, "m2");

    const applied = await engine.applyOp(
      op(alice, "react", { target: bob.account.did, kind: "clap" }),
    );

    expect(applied.result.ok).toBe(true);
    expect(reactionsOf(applied.room)[0]).toMatchObject({ target: bob.account.did, kind: "clap" });
  });

  it("reacts to an item sitting in a grant pool, not only the shared contents", async () => {
    const policy = reactPolicy({ grant: { op: "collect", from: "rewards", count: 1 } });
    await place(policy, { contents: [], rewards: [reward("p1")] });
    await contribute(alice, "m1");

    const applied = await engine.applyOp(op(alice, "react", { target: "p1", kind: "wow" }));
    expect(applied.result.ok).toBe(true);
  });

  it("refuses a target the room does not hold", async () => {
    await place(reactPolicy());
    await contribute(alice, "m1");

    const applied = await engine.applyOp(op(alice, "react", { target: "nope", kind: "love" }));
    expect(applied.result).toMatchObject({ ok: false, error: "gone" });

    // …including a target that is only a prototype key of the contributor ledger: `"toString" in
    // {}` is true, so a plain `in` test would have let these through into room state.
    for (const target of ["toString", "constructor", "__proto__"]) {
      const proto = await engine.applyOp(op(alice, "react", { target, kind: "love" }));
      expect(proto.result).toMatchObject({ ok: false, error: "gone" });
    }
  });

  it("is idempotent on (actor, target, kind) — the same reaction twice adds nothing", async () => {
    await place(reactPolicy());
    await contribute(alice, "m1");

    const first = await engine.applyOp(op(alice, "react", { target: "m1", kind: "love" }));
    const again = await engine.applyOp(op(alice, "react", { target: "m1", kind: "love" }));

    expect(again.result.ok).toBe(true);
    expect(reactionsOf(again.room)).toHaveLength(1);
    expect(again.changes).toEqual([]); // nothing to broadcast — the room did not change
    // Both calls name the SAME reaction, so a client that lost the first response keys on one id.
    expect(resultOf(again.result)["reaction"]).toBe(resultOf(first.result)["reaction"]);
    // ...and the room is not re-written for it. A room persists as ONE JSON blob, so a bumped
    // version here would mean the whole thing was re-serialized for a gesture that changed nothing.
    expect(again.result).toMatchObject({ ok: true, version: versionOf(first.result) });
  });

  it("a repeated react leaves a concurrent baseVersion assertion valid", async () => {
    // The other half of not burning a version: an op that pins `baseVersion` (engine step 5) is
    // racing the double tap. If the repeat had bumped the room, this would come back `stale`: a
    // real op refused over a reaction recorded minutes ago.
    await place(reactPolicy());
    await contribute(alice, "m1");
    const first = await engine.applyOp(op(alice, "react", { target: "m1", kind: "love" }));
    const pinned = versionOf(first.result);

    await engine.applyOp(op(alice, "react", { target: "m1", kind: "love" })); // the repeat

    const racing = op(bob, "contribute", { item: token("m2") }, pinned);
    expect((await engine.applyOp(racing)).result.ok).toBe(true);
  });

  it("refuses a SECOND kind on a target you already reacted to (one per player per target)", async () => {
    await place(reactPolicy());
    await contribute(alice, "m1");
    await engine.applyOp(op(alice, "react", { target: "m1", kind: "love" }));

    const other = await engine.applyOp(op(alice, "react", { target: "m1", kind: "fire" }));
    expect(other.result).toMatchObject({ ok: false, error: "full" });

    const room = await engine.resolveRoom(ROOM_ID);
    expect(reactionsOf(room)).toHaveLength(1);
    expect(reactionsOf(room)[0]?.kind).toBe("love"); // refused, never replaced
  });

  it("lets two players react to the same target, and one player to two targets", async () => {
    await place(reactPolicy());
    await contribute(alice, "m1");
    await contribute(bob, "m2");

    await engine.applyOp(op(alice, "react", { target: "m1", kind: "love" }));
    await engine.applyOp(op(bob, "react", { target: "m1", kind: "wow" }));
    await engine.applyOp(op(alice, "react", { target: "m2", kind: "fire" }));

    expect(reactionsOf(await engine.resolveRoom(ROOM_ID))).toHaveLength(3);
  });

  it("holds the room to its policy total, and refuses past it", async () => {
    await place(
      reactPolicy({
        ops: { contribute: { role: "public" }, react: { role: "contributor", max: 1 } },
      }),
    );
    await contribute(alice, "m1");
    await contribute(bob, "m2");

    expect(
      (await engine.applyOp(op(alice, "react", { target: "m1", kind: "love" }))).result.ok,
    ).toBe(true);
    const past = await engine.applyOp(op(bob, "react", { target: "m1", kind: "wow" }));
    expect(past.result).toMatchObject({ ok: false, error: "full" });
  });

  it("refuses a policy asking for more ledger than the engine will hold, at placement", async () => {
    // Refused, not silently clamped: a placement that asked for more would otherwise be accepted
    // and then quietly behave as something smaller, with the client none the wiser.
    const greedy = reactPolicy({
      ops: {
        contribute: { role: "public" },
        react: { role: "contributor", max: MAX_OP_LEDGER + 1 },
      },
    });
    await expect(place(greedy)).rejects.toThrow(/exceeds the engine ceiling/);
  });

  it("refuses a ledger bound on an op that keeps no ledger, at placement", async () => {
    // `max` rides the op rule so the next bounded op needs no new wire type, which also means it
    // PARSES on every op. Only the ops in `OP_LEDGER_KEYS` read it, so anywhere else it would be
    // accepted and then quietly do nothing, the same silence the ceiling check exists to prevent.
    const misplaced = reactPolicy({
      ops: {
        contribute: { role: "public", max: 10 },
        react: { role: "contributor" },
      },
    });
    await expect(place(misplaced)).rejects.toThrow(/keeps no ledger of its own/);
  });

  it("refuses a derived formula named after the reaction ledger, at placement", async () => {
    // `recomputeDerived` writes every derived key into state on every op, so this one would
    // overwrite the ledger with a NUMBER, and `getReactions`' array guard reads a number back as
    // none, so dedupe would stop working and the bound would never bind, with nothing logged.
    const shadowing = reactPolicy({ derived: { reactions: { "+": [1, 1] } } });
    await expect(place(shadowing)).rejects.toThrow(/reserved state key/);
  });

  it("holds a room to the engine ceiling when the policy names no bound", async () => {
    // Seeded right at the ceiling; the policy asked for nothing, so the ceiling is the bound.
    const seeded = Array.from({ length: MAX_OP_LEDGER }, (_, i) => ({
      unique: `seed${i}`,
      by: bob.account.did,
      at: 1,
      target: `seeded-target-${i}`,
      kind: "love",
    }));
    await place(reactPolicy(), { contents: [], reactions: seeded });
    await contribute(alice, "m1");

    const applied = await engine.applyOp(op(alice, "react", { target: "m1", kind: "wow" }));
    expect(applied.result).toMatchObject({ ok: false, error: "full" });
  });

  it("rides the ordinary phase gate — react is refused outside its phase", async () => {
    const base = timedPotPolicy({ lockDelaySec: 100, unlockDelaySec: 200, claimTtl: "1d" });
    const policy: Policy = {
      ...base,
      ops: { ...base.ops, react: { role: "contributor", phase: "open" } },
    };
    await place(policy);
    await contribute(alice, "m1");

    const applied = await engine.applyOp(op(alice, "react", { target: "m1", kind: "love" }));
    expect(applied.result).toMatchObject({ ok: false, error: "phase" });
  });

  it("refuses a malformed kind — empty, over-long, or not a string", async () => {
    await place(reactPolicy());
    await contribute(alice, "m1");

    for (const kind of ["", "k".repeat(MAX_REACTION_KIND_LEN + 1), 7]) {
      const applied = await engine.applyOp(op(alice, "react", { target: "m1", kind }));
      expect(applied.result).toMatchObject({ ok: false, error: "invalid" });
    }
    const noTarget = await engine.applyOp(op(alice, "react", { target: "", kind: "love" }));
    expect(noTarget.result).toMatchObject({ ok: false, error: "invalid" });
  });

  it("names a param it does not know, so a newer app is told the server is behind", async () => {
    await place(reactPolicy());
    await contribute(alice, "m1");

    const applied = await engine.applyOp(
      op(alice, "react", { target: "m1", kind: "love", burst: 3 }),
    );
    expect(applied.result).toMatchObject({ ok: false, error: "invalid", fields: ["burst"] });
    // Anything else wrong as well is a malformed request, not a version gap: no `fields`.
    const both = await engine.applyOp(op(alice, "react", { target: "", kind: "love", burst: 3 }));
    expect(both.result).not.toHaveProperty("fields");
  });

  it("emits no derivedUpdated — a reaction feeds no formula, so it must not wake every watcher", async () => {
    const policy = timedPotPolicy({
      lockDelaySec: 100,
      unlockDelaySec: 200,
      claimTtl: "1d",
      react: true,
    });
    await place(policy);
    await contribute(alice, "m1");

    const applied = await engine.applyOp(op(alice, "react", { target: "m1", kind: "love" }));
    expect(applied.result.ok).toBe(true);
    expect(applied.changes.map((c) => c.type)).toEqual(["reactionAdded"]);
    // The timers the skipped recompute would have written are still the ones the room was placed with.
    expect(applied.room?.state["lockAt"]).toBe(
      (await engine.resolveRoom(ROOM_ID))?.state["lockAt"],
    );
  });

  it("refuses an op the injected budget says is over, and lets it through once it is not", async () => {
    // The server's per-DID budget rides the engine's `isRateLimited` consult — the same seam
    // revocation uses — because that is the first point where the actor is cryptographically known.
    let over = false;
    const seen: string[] = [];
    engine = new PolicyEngine(new InMemoryStore(), {
      isRateLimited: (actor, opName) => {
        seen.push(`${opName}:${actor === alice.account.did}`);
        return over;
      },
    });
    await place(reactPolicy());
    await contribute(alice, "m1");

    over = true;
    const refused = await engine.applyOp(op(alice, "react", { target: "m1", kind: "love" }));
    expect(refused.result).toMatchObject({ ok: false, error: "rateLimited" });
    expect(seen).toContain("react:true"); // consulted with the verified actor and the op name

    // Not finalized under the nonce, so the SAME actor succeeds once the window rolls — a budget
    // is a moving verdict, unlike a structural rejection.
    over = false;
    const allowed = await engine.applyOp(op(alice, "react", { target: "m1", kind: "love" }));
    expect(allowed.result.ok).toBe(true);
  });

  it("denies a player who is not in the room (the role gate, not a react rule)", async () => {
    await place(reactPolicy());
    await contribute(alice, "m1");

    const applied = await engine.applyOp(op(bob, "react", { target: "m1", kind: "love" }));
    expect(applied.result).toMatchObject({ ok: false, error: "denied" });
  });

  it("denies react on a room placed before reactions shipped (no ops.react)", async () => {
    await place({ ops: { contribute: { role: "public" } } });
    await contribute(alice, "m1");

    const applied = await engine.applyOp(op(alice, "react", { target: "m1", kind: "love" }));
    expect(applied.result).toMatchObject({ ok: false, error: "denied" });
  });
});
