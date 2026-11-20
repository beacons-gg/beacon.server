import {
  createWallet,
  signRoomProvenance,
  signOpWithWallet,
  walletMinter,
  type Wallet,
} from "@beaconsgg/identity";
import { nowSeconds } from "@beaconsgg/policy-engine";
import {
  bagPolicy,
  InMemoryStore,
  ladderPolicy,
  nonce,
  timedPotPolicy,
  token,
} from "@beaconsgg/policy-engine/testing";
import {
  ANY_GAME,
  type LiveEvent,
  type MapDelta,
  type OpaqueItem,
  type OpEnvelope,
  type PlaceParams,
  type Room,
} from "@beaconsgg/protocol-types";
import { encode } from "@beaconsgg/geo";
import { ulid } from "ulid";
import { beforeEach, describe, expect, it } from "vitest";
import { ProfilesService } from "../profiles/profiles.service";
import {
  TEST_GAME,
  budgetsWith,
  testBlocklist,
  testGameGate,
  testMemberList,
} from "./test-helpers";
import { RoomsGateway } from "../rooms/rooms.gateway";
import { DidBudgets } from "../common/did-budgets";
import { RoomsService } from "../rooms/rooms.service";
import { ServerIdentity } from "../server-identity";

/**
 * Service-level acceptance for the room service: the core mechanisms, against the real {@link
 * RoomsService} over the injected Store: atomic place→add→take handoff, discovery via
 * `roomsInCells`, live-map emissions, revocation, and lifecycle recompute + timer advance. The
 * gateway is a recording double (no real socket). The policies and signed items are the generic
 * ones from `@beaconsgg/policy-engine/testing`.
 */

/** The two rungs' escrow pools, for the multi-rule place mapping. */
const POOL1 = "rung1";
const POOL2 = "rung2";

/** A two-rung ladder, the shape whose place mapping seeds one pool per grant rule. */
function twoRungLadder(secondRungCount = 2) {
  return ladderPolicy({
    rungs: [
      { key: "a", target: 3, pool: POOL1, count: 1 },
      { key: "b", target: 2, pool: POOL2, count: secondRungCount },
    ],
    deadlineSec: nowSeconds(Date.now()) + 3600,
    maxContributors: 2,
  });
}

const HERE = { lat: 47.61, lng: -122.34 };

/** A recording gateway double: capture every room `delta` and map delta the service emits. */
class RecordingGateway {
  readonly deltas: LiveEvent[] = [];
  readonly maps: MapDelta[] = [];
  readonly audiences: (readonly string[])[] = [];
  broadcast(event: LiveEvent): void {
    this.deltas.push(event);
  }
  broadcastMap(delta: MapDelta, games: readonly string[]): void {
    this.maps.push(delta);
    this.audiences.push(games);
  }
}

/** Build a ServerIdentity double with an ephemeral key and a fixed host (no env / mnemonic). */
function fakeIdentity(): ServerIdentity {
  return {
    config: {
      host: "beacon.test",
      publicUrl: "http://beacon.test",
      coverage: [""],
      name: "Test",
      corsOrigins: [],
      port: 3001,
      pgPoolSize: 10,
      maxNonces: 50_000,
    },
  } as unknown as ServerIdentity;
}

function placeParams(policy: PlaceParams["policy"], type: string, placer: Wallet): PlaceParams {
  // The container's client-minted id becomes the room's `unique`; its `mintedBy` is signed over
  // {unique, kind, policy} and required at place. Signed by the placer (first-party mint — the place
  // actor MUST be the minter). A fresh unique per call avoids id collisions.
  const unique = nonce();
  const mintedBy = signRoomProvenance({ unique, kind: type, policy }, walletMinter(placer));
  return { type, unique, mintedBy, location: HERE, policy };
}

describe("RoomsService (P2 heart)", () => {
  let service: RoomsService;
  let gateway: RecordingGateway;
  let profiles: ProfilesService;
  let alice: Wallet;
  let bob: Wallet;

  /** The service under test over `store`, sharing the suite's gateway + profile registry. */
  function makeService(
    store: InMemoryStore,
    blocklist = testBlocklist(),
    budgets = new DidBudgets(),
    games = testGameGate(),
    members = testMemberList(),
  ): RoomsService {
    return new RoomsService(
      gateway as unknown as RoomsGateway,
      fakeIdentity(),
      profiles,
      blocklist,
      members,
      games,
      budgets,
      store,
      { writeLocked: false },
    );
  }

  beforeEach(async () => {
    gateway = new RecordingGateway();
    profiles = new ProfilesService(testBlocklist()); // no store -> pure in-memory registry
    // Use the in-memory Store to keep the test hermetic (the SQL path is covered by the durability
    // suite); the service is identical over any Store — that is the seam's point.
    const store = new InMemoryStore();
    service = makeService(store);
    await service.onModuleInit();
    alice = createWallet();
    bob = createWallet();
  });

  function op(
    wallet: Wallet,
    name: string,
    room: string,
    params: Record<string, unknown>,
  ): OpEnvelope {
    return signOpWithWallet(wallet, { op: name, room, nonce: nonce(), game: TEST_GAME, params });
  }

  it("places a jar, then add→take transfers ownership atomically and emits ordered deltas", async () => {
    const placed = await service.place(
      alice.account.did,
      placeParams(bagPolicy(), "jar", alice),
      nonce(),
      TEST_GAME,
    );
    expect(placed.room?.type).toBe("jar");
    const id = placed.id;
    // A placement emits an `object` map delta to the room's cell.
    expect(gateway.maps.at(-1)).toMatchObject({ kind: "room", room: { id } });

    // Alice adds a resource.
    const add = await service.applyOp(
      op(alice, "add", id, {
        item: token("r1"),
      }),
    );
    expect(add.result).toMatchObject({ ok: true, version: 2 });
    expect(add.changes[0]).toMatchObject({ type: "itemAdded" });

    // Bob takes it — ownership transfers.
    const take = await service.applyOp(op(bob, "take", id, { item: "r1" }));
    expect(take.result.ok).toBe(true);
    expect(take.changes[0]).toMatchObject({ type: "itemRemoved" });

    // Deltas are versioned & ordered (add then take).
    const versions = gateway.deltas.map((d) => d.version);
    expect(versions).toEqual([...versions].sort((a, b) => a - b));

    // Re-taking the same item now fails (single custody — no double spend).
    const again = await service.applyOp(op(bob, "take", id, { item: "r1" }));
    expect(again.result).toMatchObject({ ok: false });
  });

  it("rejects a placement seeded with an unsigned resource (provenance gate at place, no bypass)", async () => {
    // A schema-valid but UNSIGNED item (no mintedBy) — rejected by the place-time provenance gate.
    const unsigned = { unique: "seed", birth: {} } as OpaqueItem;
    await expect(
      service.place(
        alice.account.did,
        { ...placeParams(bagPolicy(), "jar", alice), initialContents: [unsigned] },
        nonce(),
        TEST_GAME,
      ),
    ).rejects.toThrow(/provenance/);
  });

  it("accepts a placement seeded with a validly signed resource", async () => {
    const placed = await service.place(
      alice.account.did,
      { ...placeParams(bagPolicy(), "jar", alice), initialContents: [token("seed")] },
      nonce(),
      TEST_GAME,
    );
    expect((placed.room?.state["contents"] as OpaqueItem[]).map((r) => r.unique)).toEqual(["seed"]);
  });

  it("seeds initialRewards under the policy's grant.from + threads the media header (the place mapping)", async () => {
    // Guards the thin apps/server translation layer the engine tests bypass (they seed state.rewards
    // directly): initialRewards -> state[grant.from], and the content-addressed media header.
    const policy: PlaceParams["policy"] = timedPotPolicy({
      lockDelaySec: 60,
      unlockDelaySec: 120,
      grant: { op: "claim", from: "rewards", count: 1 },
      maxContributors: 1,
    });
    const media = [{ type: "image", role: "full" as const, hash: "h", uris: ["h@a.example"] }];
    const placed = await service.place(
      alice.account.did,
      { ...placeParams(policy, "capsule", alice), initialRewards: [token("rw-1")], media },
      nonce(),
      TEST_GAME,
    );
    const pool = placed.room?.state["rewards"] as OpaqueItem[];
    expect(pool.map((r) => r.unique)).toEqual(["rw-1"]);
    expect(placed.room?.media).toEqual(media);
  });

  it("seeds a ladder's named initialPools under each grant rule's key (the multi-step place mapping)", async () => {
    // One room, per-rung escrow pools: the wire shape a multi-step challenge sends.
    const policy = twoRungLadder();
    const placed = await service.place(
      alice.account.did,
      {
        ...placeParams(policy, "challenge", alice),
        initialPools: {
          [POOL1]: [token("p1-a")],
          [POOL2]: [token("p2-a"), token("p2-b")],
        },
      },
      nonce(),
      TEST_GAME,
    );
    const pool = (k: string): string[] =>
      ((placed.room?.state[k] as OpaqueItem[]) ?? []).map((r) => r.unique);
    expect(pool(POOL1)).toEqual(["p1-a"]);
    expect(pool(POOL2)).toEqual(["p2-a", "p2-b"]);
  });

  it("initialRewards keep their legacy meaning on a multi-rule policy: the FIRST rule's pool", async () => {
    // A single-pool client placing against a ladder policy still seeds something sensible — and
    // when both are sent, the NAMED pool wins its key (initialPools spread last, deterministic).
    const policy = twoRungLadder(1);
    const legacyOnly = await service.place(
      alice.account.did,
      { ...placeParams(policy, "challenge", alice), initialRewards: [token("legacy-1")] },
      nonce(),
      TEST_GAME,
    );
    expect(((legacyOnly.room?.state[POOL1] as OpaqueItem[]) ?? []).map((r) => r.unique)).toEqual([
      "legacy-1",
    ]);
    expect(legacyOnly.room?.state[POOL2]).toBeUndefined();

    const both = await service.place(
      alice.account.did,
      {
        ...placeParams(policy, "challenge", alice),
        initialRewards: [token("legacy-2")],
        initialPools: { [POOL1]: [token("named-1")] },
      },
      nonce(),
      TEST_GAME,
    );
    expect(((both.room?.state[POOL1] as OpaqueItem[]) ?? []).map((r) => r.unique)).toEqual([
      "named-1",
    ]);
  });

  it("serves discovery via roomsInCells and filters by type", async () => {
    const jar = await service.place(
      alice.account.did,
      placeParams(bagPolicy(), "jar", alice),
      nonce(),
      TEST_GAME,
    );
    const cell = encode(HERE).slice(0, 5);

    const all = await service.discover([cell]);
    expect(all.rooms.map((o) => o.id)).toContain(jar.id);
    expect(all.coveredBy).toBe("beacon.test");

    // A non-matching type filters it out; a far cell finds nothing.
    expect((await service.discover([cell], ["capsule"])).rooms).toHaveLength(0);
    const farCell = encode({ lat: 0, lng: 0 }).slice(0, 5);
    expect((await service.discover([farCell])).rooms).toHaveLength(0);
  });

  it("filters discovery to rooms a game owns or may act on, and says whose each room is", async () => {
    const mine = await service.place(
      alice.account.did,
      placeParams(bagPolicy(), "jar", alice),
      nonce(),
      TEST_GAME,
    );
    const theirs = await service.place(
      alice.account.did,
      placeParams(bagPolicy(), "jar", alice),
      nonce(),
      "game-b",
    );
    const base = bagPolicy();
    const opened = await service.place(
      alice.account.did,
      placeParams(
        { ...base, ops: { ...base.ops, list: { role: "public", games: [ANY_GAME] } } },
        "jar",
        alice,
      ),
      nonce(),
      "game-b",
    );
    const cell = encode(HERE).slice(0, 5);
    const ids = async (games?: string[]) =>
      (await service.discover([cell], undefined, games)).rooms.map((o) => o.id).sort();

    expect(await ids([TEST_GAME])).toEqual([mine.id, opened.id].sort());
    expect(await ids(["game-b"])).toEqual([theirs.id, opened.id].sort());
    expect(await ids()).toEqual([mine.id, theirs.id, opened.id].sort());
    const summaries = (await service.discover([cell])).rooms;
    expect(summaries.find((o) => o.id === theirs.id)?.game).toBe("game-b");
  });

  it("resolves a room only for a game that owns it or may act on it, when asked for one", async () => {
    const theirs = await service.place(
      alice.account.did,
      placeParams(bagPolicy(), "jar", alice),
      nonce(),
      "game-b",
    );
    expect(await service.resolve(theirs.id)).toMatchObject({ id: theirs.id, game: "game-b" });
    expect(await service.resolve(theirs.id, ["game-b"])).toMatchObject({ id: theirs.id });
    expect(await service.resolve(theirs.id, [TEST_GAME])).toBeUndefined();
  });

  it("sends a room's map marker to its own game and the games it opens an op to", async () => {
    await service.place(
      alice.account.did,
      placeParams(bagPolicy(), "jar", alice),
      nonce(),
      TEST_GAME,
    );
    expect(gateway.audiences.at(-1)).toEqual([TEST_GAME]);

    const base = bagPolicy();
    const named = {
      ...base,
      ops: { ...base.ops, add: { role: "public" as const, games: ["game-b"] } },
    };
    await service.place(alice.account.did, placeParams(named, "jar", alice), nonce(), TEST_GAME);
    expect(gateway.audiences.at(-1)).toEqual([TEST_GAME, "game-b"]);

    const open = {
      ...base,
      ops: { ...base.ops, list: { role: "public" as const, games: [ANY_GAME] } },
    };
    await service.place(alice.account.did, placeParams(open, "jar", alice), nonce(), TEST_GAME);
    expect(gateway.audiences.at(-1)).toEqual([ANY_GAME]);
  });

  it("carries the reward THUMB on a discovered object, and only the thumb", async () => {
    // A marker draws the object's own picture instead of a generic pin, so the thumb has to ride the
    // cheap discovery read. The rest of `media[]` deliberately does not: discovery returns every
    // object in the queried cells, and full-size entries plus credit lines per object is what turns a
    // dense block into a slow read. The detail screen resolves the room for the rest.
    const media = [
      { type: "image", role: "full" as const, hash: "hf", uris: ["hf@a.example"] },
      { type: "image", role: "thumb" as const, hash: "ht", uris: ["ht@a.example"] },
    ];
    await service.place(
      alice.account.did,
      {
        ...placeParams(
          timedPotPolicy({ lockDelaySec: 86_400, unlockDelaySec: 604_800 }),
          "capsule",
          alice,
        ),
        initialRewards: [token("rw-2")],
        media,
      },
      nonce(),
      TEST_GAME,
    );
    const [found] = (await service.discover([encode(HERE).slice(0, 5)], ["capsule"])).rooms;
    expect(found?.summary?.["media"]).toEqual(media[1]);
  });

  it("says nothing about media for an object that has none", async () => {
    // Absent, not null: the key is how a client decides between a picture and the fallback marker.
    await service.place(
      alice.account.did,
      placeParams(bagPolicy(), "jar", alice),
      nonce(),
      TEST_GAME,
    );
    const [found] = (await service.discover([encode(HERE).slice(0, 5)], ["jar"])).rooms;
    expect(found?.summary).toBeDefined();
    expect("media" in (found?.summary ?? {})).toBe(false);
  });

  it("adminRemove closes any room: closed + roomGone events, discovery gone, racing op expired", async () => {
    const placed = await service.place(
      alice.account.did,
      placeParams(bagPolicy(), "jar", alice),
      nonce(),
      TEST_GAME,
    );
    const id = placed.id;
    await service.applyOp(op(alice, "add", id, { item: token("r9") }));
    const cell = encode(HERE).slice(0, 5);
    expect((await service.discover([cell])).rooms.map((o) => o.id)).toContain(id);

    expect(await service.adminRemove(id)).toBe(true);
    // Watchers get the SAME events a lifecycle close emits — indistinguishable from a normal close.
    expect(gateway.deltas.at(-1)).toMatchObject({ room: id, change: { type: "closed" } });
    expect(gateway.maps.at(-1)).toMatchObject({ kind: "roomGone", id });
    expect((await service.discover([cell])).rooms).toHaveLength(0);

    // A racing op sees `expired` (the engine tombstoned the id), not `unknownRoom`.
    const late = await service.applyOp(op(bob, "take", id, { item: "r9" }));
    expect(late.result).toMatchObject({ ok: false, error: "expired" });

    // Removing an already-gone (or never-existing) room is a clean false, not an error.
    expect(await service.adminRemove(id)).toBe(false);
  });

  it("rejects an op from a revoked device (engine consults the profile registry)", async () => {
    const { buildProfile, authorizeDevice } = await import("@beaconsgg/identity");
    const placed = await service.place(
      alice.account.did,
      placeParams(bagPolicy(), "jar", alice),
      nonce(),
      TEST_GAME,
    );
    // Publish alice's profile revoking her signing device.
    const issued = new Date().toISOString();
    const v = buildProfile(alice.account, {
      version: 1,
      devices: [
        {
          did: alice.device.did,
          auth: authorizeDevice(alice.account, alice.device.did, { issued }),
        },
      ],
      revoked: [alice.device.did],
    });
    expect(await profiles.publish(v)).toMatchObject({ ok: true });

    const denied = await service.applyOp(
      op(alice, "add", placed.id, {
        item: token("x"),
      }),
    );
    expect(denied.result).toMatchObject({ ok: false, error: "deviceRevoked" });
  });

  it("places a timed pot in its first phase, and a contribute recomputes its timers", async () => {
    const placed = await service.place(
      alice.account.did,
      placeParams(
        // The lock comes 1 s sooner per unit of `hue` contributed, so a recompute is visible.
        timedPotPolicy({
          lockDelaySec: 100,
          unlockDelaySec: 200,
          lockShift: { key: "hue", per: -1 },
        }),
        "capsule",
        alice,
      ),
      nonce(),
      TEST_GAME,
    );
    const id = placed.id;
    const room = placed.room as Room;
    expect(room.state["phase"]).toBe("filling");
    const lockAt = room.state["lockAt"] as number;

    // A contribute while filling recomputes the derived timers, and says so on the live channel.
    const contribute = await service.applyOp(
      op(alice, "contribute", id, { item: token("c1", { hue: 10 }) }),
    );
    expect(contribute.result.ok).toBe(true);
    expect(contribute.changes).toContainEqual(expect.objectContaining({ type: "derivedUpdated" }));
    const after = (await service.resolve(id)) as Room;
    expect(after.state["lockAt"]).toBe(lockAt - 10);
  });

  it("hands the operator's blocklist to the engine, so a blocked DID's ops are denied", async () => {
    // The wiring is the whole point: the engine has an admission consult, and without the blocklist
    // passed into it a blocked DID would keep playing. This asserts the room path, which is the
    // surface a blocked actor would actually use.
    const blocked = makeService(new InMemoryStore(), testBlocklist([bob.account.did]));
    await blocked.onModuleInit();
    const policy = { ops: { contribute: { role: "public" as const } } };
    const placed = await blocked.place(
      alice.account.did,
      placeParams(policy, "capsule", alice),
      nonce(),
      TEST_GAME,
    );

    const allowed = await blocked.applyOp(
      op(alice, "contribute", placed.id, { item: token("m1") }),
    );
    expect(allowed.result.ok).toBe(true);

    const denied = await blocked.applyOp(op(bob, "contribute", placed.id, { item: token("m2") }));
    expect(denied.result).toMatchObject({ ok: false, error: "denied" });
    // Denied before the room was touched, so the block costs the room nothing.
    expect(denied.changes).toEqual([]);
    // Even on a room that does not exist: the client SDK's `probeDevice` reads `denied` as blocked.
    const missing = await blocked.applyOp(op(bob, "list", `${ulid()}@probe.invalid`, {}));
    expect(missing.result).toMatchObject({ ok: false, error: "denied" });
  });

  it("hands the operator's game list to the engine, so an unadmitted app's ops are gameNotAdmitted", async () => {
    // The wiring test, and the only place the gate and the engine meet: RoomsService is what turns
    // a configured BEACON_GAMES into the engine's `isAppDenied`. One GameGate backs this and both
    // boundaries that verify for themselves, so the three cannot drift to different verdicts.
    const gated = makeService(
      new InMemoryStore(),
      testBlocklist(),
      new DidBudgets(),
      testGameGate(["kites"]),
    );
    await gated.onModuleInit();
    const policy = { ops: { contribute: { role: "public" as const } } };
    const placed = await gated.place(
      alice.account.did,
      placeParams(policy, "capsule", alice),
      nonce(),
      "kites",
    );

    const fromKites = await gated.applyOp(
      signOpWithWallet(alice, {
        op: "contribute",
        room: placed.id,
        nonce: nonce(),
        game: "kites",
        params: { item: token("m1") },
      }),
    );
    expect(fromKites.result.ok).toBe(true);

    const fromElsewhere = await gated.applyOp(
      signOpWithWallet(alice, {
        op: "contribute",
        room: placed.id,
        nonce: nonce(),
        game: "other-game",
        params: { item: token("m2") },
      }),
    );
    expect(fromElsewhere.result).toMatchObject({ ok: false, error: "gameNotAdmitted" });
    // Refused before the room was touched, so an unadmitted game costs the room nothing.
    expect(fromElsewhere.changes).toEqual([]);

    // An op naming no game is refused the same way: every game write names its game.
    const silent = await gated.applyOp(
      signOpWithWallet(alice, {
        op: "contribute",
        room: placed.id,
        nonce: nonce(),
        params: { item: token("m3") },
      }),
    );
    expect(silent.result).toMatchObject({ ok: false, error: "gameNotAdmitted" });
  });

  it("budgets ANY op per DID through the engine seam, not just react", async () => {
    // An earlier seam carried a single `react` limiter and every other op was IP-bounded only.
    const limited = makeService(
      new InMemoryStore(),
      testBlocklist(),
      budgetsWith({ BEACON_OP_RATE_LIMIT_MAX: "2" }),
    );
    {
      // `place` below is billed at the HTTP boundary, not here, so it costs Alice nothing.
      await limited.onModuleInit();
      const policy = { ops: { contribute: { role: "public" as const } } };
      const placed = await limited.place(
        alice.account.did,
        placeParams(policy, "capsule", alice),
        nonce(),
        TEST_GAME,
      );
      const contribute = (w: typeof alice, id: string) =>
        limited.applyOp(op(w, "contribute", placed.id, { item: token(id) }));

      expect((await contribute(alice, "m1")).result.ok).toBe(true);
      expect((await contribute(alice, "m2")).result.ok).toBe(true);
      expect((await contribute(alice, "m3")).result).toMatchObject({
        ok: false,
        error: "rateLimited",
      });
      // Bob has his own window: the budget is per account, not per room or per process.
      expect((await contribute(bob, "m4")).result.ok).toBe(true);
    }
  });

  it("budgets react per DID and keeps a reaction off the live map", async () => {
    // The per-DID budget rides the engine's `isRateLimited` consult from HERE, so the actor is
    // already verified when it is charged and the HTTP boundary needs no signature check of its own.
    const limited = makeService(
      new InMemoryStore(),
      testBlocklist(),
      budgetsWith({ BEACON_REACT_RATE_LIMIT_MAX: "2" }),
    );
    {
      await limited.onModuleInit();
      const policy = {
        ops: { contribute: { role: "public" as const }, react: { role: "contributor" as const } },
      };
      const placed = await limited.place(
        alice.account.did,
        placeParams(policy, "capsule", alice),
        nonce(),
        TEST_GAME,
      );
      const id = placed.id;
      await limited.applyOp(op(alice, "contribute", id, { item: token("m1") }));
      await limited.applyOp(op(bob, "contribute", id, { item: token("m2") }));

      // From here on, reactions only — so any `object` map delta below came from one.
      const mapsBefore = gateway.maps.length;
      const react = (w: typeof alice, kind: string) =>
        limited.applyOp(op(w, "react", id, { target: "m1", kind }));
      expect((await react(alice, "love")).result.ok).toBe(true);
      // A second, different kind is refused by the ledger rule — but it still spends budget.
      expect((await react(alice, "wow")).result).toMatchObject({ ok: false, error: "full" });
      expect((await react(alice, "fire")).result).toMatchObject({
        ok: false,
        error: "rateLimited",
      });
      // Another player has their own budget: this is per account, not per room or per process.
      expect((await react(bob, "clap")).result.ok).toBe(true);

      // A reaction changes nothing a room summary shows, so no map delta was pushed for one.
      expect(gateway.maps.slice(mapsBefore).filter((m) => m.kind === "room")).toEqual([]);
    }
  });
});
