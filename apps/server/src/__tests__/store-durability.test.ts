import type { Store } from "@beaconsgg/policy-engine";
import type { Policy, Room } from "@beaconsgg/protocol-types";
import { timedPotPolicy } from "@beaconsgg/policy-engine/testing";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { PgStore } from "../stores/pg.store";
import { type StoreBundle, createStores } from "../stores/store.factory";
import { pgTwin, testDatabaseUrl } from "./pg-twin";
import { makeJarRoom } from "./test-helpers";

/**
 * The store's durability suite, against the Postgres at `BEACON_TEST_DATABASE_URL` (`pnpm test:db`
 * starts one). It proves the two invariants the custody path lives on — restart durability (place a
 * room + nonce → reopen → both intact) and all-or-nothing batch commit — plus the two indexed
 * queries (`roomsInCells`, `lifecycleRoomsDue`) against real SQL.
 */

/** The shared minimal jar-shaped room fixture (test-helpers). */
const jar = makeJarRoom;

const DAY = 86_400;
const TTL = 7 * DAY;

/** The generic three-phase pot with a 7-day claim window (`@beaconsgg/policy-engine/testing`). */
const POT_POLICY: Policy = timedPotPolicy({
  lockDelaySec: DAY,
  unlockDelaySec: DAY,
  claimTtl: "7d",
});

/** A pot (lifecycle) room still `filling`, with explicit lock/unlock times. */
function fillingPot(id: string, lockAt: number, unlockAt: number): Room {
  return {
    id,
    type: "pot",
    version: 1,
    location: { lat: 47.61, lng: -122.34 },
    state: {
      contents: [],
      contributors: { a: [] },
      claimed: [],
      phase: "filling",
      lockAt,
      unlockAt,
    },
    policy: POT_POLICY,
    placedBy: "did:key:z6MkSmokeTestAccountKeyAbCdEfGhJkLm",
  } as Room;
}

/** A pot that entered its terminal phase at `settledAt`, with one contributor yet to claim. */
function settledPot(id: string, settledAt: number, unlockAt: number): Room {
  return {
    id,
    type: "pot",
    version: 3,
    location: { lat: 47.61, lng: -122.34 },
    state: {
      contents: [],
      contributors: { a: [] },
      claimed: [],
      phase: "open",
      placedAt: unlockAt - 2 * DAY,
      lockAt: unlockAt - DAY,
      unlockAt,
      settledAt,
    },
    policy: POT_POLICY,
    placedBy: "did:key:z6MkSmokeTestAccountKeyAbCdEfGhJkLm",
  } as Room;
}

/**
 * A pot stuck `locked` behind an unlock decades out: stranded, so it closes a claim window after it
 * locked. `unlockAt` is the time a row written before the horizon rule holds as its due time.
 */
function strandedPot(id: string, lockAt: number): Room {
  const pot = fillingPot(id, lockAt, lockAt + 30 * 365 * DAY);
  return { ...pot, state: { ...pot.state, phase: "locked", placedAt: lockAt - DAY } };
}

const dueIds = async (s: Store, nowSec: number): Promise<string[]> =>
  (await s.lifecycleRoomsDue(nowSec)).map((r) => r.id).sort();

// Only this suite's tables are truncated: the other store suites own theirs, and every suite runs
// against the same database.
const pg = pgTwin((pool) => new PgStore(pool), ["rooms", "nonces"]);

/**
 * The Postgres twin, plus two things a boot needs. `open()` twice is a restart against the same data:
 * a store keeps nothing of its own beyond the pool, so a second one starts from the database alone.
 */
/** Bundles {@link backend.boot} opened, ended with the suite. */
const booted: StoreBundle[] = [];
afterAll(async () => {
  for (const bundle of booted.splice(0)) await bundle.close();
});

const backend = {
  ...pg,
  /**
   * Boot the way the server does, through `createStores`, so a test sees what a boot runs (the
   * lifecycle repair) and not only what the repair does when called.
   */
  async boot(): Promise<PgStore> {
    const bundle = await createStores({
      databaseUrl: testDatabaseUrl(),
      pgPoolSize: 2,
      maxNonces: 50_000,
      writerLockWaitMs: null,
    });
    booted.push(bundle);
    expect(bundle.store).toBeInstanceOf(PgStore);
    return bundle.store as PgStore;
  },
  /** Overwrite a row's `lifecycle_due_at`, as a row written under an older rule would hold it. */
  setDueAt: (id: string, due: number | null): Promise<void> =>
    pg.query("UPDATE rooms SET lifecycle_due_at = $1 WHERE id = $2", [due, id]),
};

describe("Store durability — PgStore", () => {
  beforeEach(() => backend.reset());

  it("persists rooms and nonces across a reopen (restart durability)", async () => {
    const a = await backend.open();
    await a.commit([
      { kind: "putRoom", room: jar("jar1@h", 3, 47.6205, -122.3493, [{ unique: "x" }]) },
      { kind: "putNonce", nonce: "op:n1", result: { ok: true, version: 3 } },
    ]);

    // Reopen against the same data — the equivalent of a process restart.
    const b = await backend.open();
    const got = await b.getRoom("jar1@h");
    expect(got?.version).toBe(3);
    expect((got?.state["contents"] as unknown[]).length).toBe(1);
    expect(await b.getNonceResult("op:n1")).toEqual({ ok: true, version: 3 });
  });

  it("commits a batch atomically (put + delete + nonce in one transaction)", async () => {
    const s = await backend.open();
    await s.commit([{ kind: "putRoom", room: jar("a@h") }]);
    await s.commit([
      { kind: "putRoom", room: jar("b@h") },
      { kind: "deleteRoom", id: "a@h" },
      { kind: "putNonce", nonce: "op:n", result: { ok: false, error: "gone" } },
    ]);

    expect(await s.getRoom("a@h")).toBeUndefined();
    expect((await s.getRoom("b@h"))?.id).toBe("b@h");
    expect(await s.getNonceResult("op:n")).toEqual({ ok: false, error: "gone" });
    expect((await s.listRooms()).map((r) => r.id)).toEqual(["b@h"]);
  });

  it("rolls back the whole batch on error (all-or-nothing)", async () => {
    const s = await backend.open();
    await s.commit([{ kind: "putRoom", room: jar("keep@h") }]);
    // A putNonce with a non-serializable payload throws mid-batch → the batch must not partially land.
    const circular: Record<string, unknown> = {};
    circular["self"] = circular;
    await expect(
      s.commit([
        { kind: "deleteRoom", id: "keep@h" },
        { kind: "putNonce", nonce: "bad", result: circular as never },
      ]),
    ).rejects.toBeTruthy();
    // The delete must have rolled back with the failed nonce write.
    expect((await s.getRoom("keep@h"))?.id).toBe("keep@h");
  });

  it("upserts a room on a repeated id (last write wins)", async () => {
    const s = await backend.open();
    await s.commit([{ kind: "putRoom", room: jar("r@h", 1) }]);
    await s.commit([{ kind: "putRoom", room: jar("r@h", 2) }]);
    expect((await s.getRoom("r@h"))?.version).toBe(2);
    expect(await s.listRooms()).toHaveLength(1);
  });

  it("serves roomsInCells from the geohash index (prefix test)", async () => {
    const s = await backend.open();
    const seattle = jar("seattle@h", 1, 47.6205, -122.3493);
    const london = jar("london@h", 1, 51.5074, -0.1278);
    await s.commit([
      { kind: "putRoom", room: seattle },
      { kind: "putRoom", room: london },
    ]);
    const { roomGeohash } = await import("@beaconsgg/policy-engine");
    const seattleCell = roomGeohash(seattle).slice(0, 5);
    expect((await s.roomsInCells([seattleCell])).map((r) => r.id)).toEqual(["seattle@h"]);
    expect(await s.roomsInCells([])).toEqual([]);
    // A finer query cell than the index hash still matches (prefix either direction).
    const finer = roomGeohash(seattle) + "0";
    expect((await s.roomsInCells([finer])).map((r) => r.id)).toEqual(["seattle@h"]);
  });

  it("serves lifecycleRoomsDue from the lifecycle_due index", async () => {
    const s = await backend.open();
    // lifecycle_due_at is stored at write time from nextTransitionAt(room, wallClockNow). Use lock
    // times far in the past/future relative to *actual* now so the stored value is stable.
    const wallNow = Math.floor(Date.now() / 1000);
    const overdue = fillingPot("overdue@h", wallNow - 10, wallNow + 100_000); // lockAt passed → due at write
    const future = fillingPot("future@h", wallNow + 1_000_000, wallNow + 2_000_000); // due far in future
    await s.commit([
      { kind: "putRoom", room: overdue },
      { kind: "putRoom", room: future },
      { kind: "putRoom", room: jar("plainjar@h") }, // non-lifecycle → never due
    ]);
    // Query with a large `now` → the overdue room (due at write) is returned; the future one is not.
    const due = await s.lifecycleRoomsDue(wallNow + 100);
    expect(due.map((r) => r.id)).toEqual(["overdue@h"]);
  });

  // lifecycle_due_at is derived at write time from nextTransitionAt(room, wallClockNow), so these use
  // times relative to the real clock, far enough apart that a slow run cannot cross a boundary.
  it("writes lifecycle_due_at from settlement, not from unlockAt", async () => {
    const s = await backend.open();
    const wallNow = Math.floor(Date.now() / 1000);
    // Settled an hour ago, a month after its unlockAt: unlockAt + ttl is long past, settledAt + ttl is not.
    const settledAt = wallNow - 3600;
    await s.commit([
      { kind: "putRoom", room: settledPot("late@h", settledAt, settledAt - 30 * DAY) },
    ]);

    expect(await dueIds(s, wallNow)).toEqual([]); // not due yet (the old rule stored NULL: never)
    expect(await dueIds(s, settledAt + TTL - 1)).toEqual([]);
    expect(await dueIds(s, settledAt + TTL)).toEqual(["late@h"]);
  });

  it("heals a lifecycle room stored with no due time, or an early one, when the store boots", async () => {
    const s = await backend.open();
    const wallNow = Math.floor(Date.now() / 1000);
    const settledAt = wallNow - 3600;
    const unlockAt = settledAt - 30 * DAY;
    await s.commit([
      { kind: "putRoom", room: settledPot("stranded@h", settledAt, unlockAt) },
      { kind: "putRoom", room: settledPot("early@h", settledAt, unlockAt) },
      // Its window ended an hour ago: genuinely due, before and after the heal.
      { kind: "putRoom", room: settledPot("overdue@h", wallNow - TTL - 3600, unlockAt) },
      { kind: "putRoom", room: jar("plainjar@h") },
    ]);
    // What rows written before the fix hold: NULL for a room settled after unlockAt + ttl (so
    // lifecycleRoomsDue never returns it), and an early time that has already fired.
    await backend.setDueAt("stranded@h", null);
    await backend.setDueAt("early@h", wallNow - 60);
    await backend.setDueAt("overdue@h", wallNow - 120);
    expect(await dueIds(s, settledAt + TTL)).toEqual(["early@h", "overdue@h"]); // stranded is invisible

    const booted = await backend.boot();
    expect(await dueIds(booted, wallNow)).toEqual(["overdue@h"]); // early no longer comes back every reconcile
    expect(await dueIds(booted, settledAt + TTL)).toEqual(["early@h", "overdue@h", "stranded@h"]);
    // A row due either way is left as it is, so a later boot does not rewrite the due backlog.
    expect(await booted.healLifecycleDue(wallNow + 10)).toBe(0);
  });

  it("heals a stranded room stored with its decades-away due time, when the store boots", async () => {
    const s = await backend.open();
    const wallNow = Math.floor(Date.now() / 1000);
    const lockAt = wallNow - 3600;
    const room = strandedPot("lost@h", lockAt);
    await s.commit([
      { kind: "putRoom", room },
      { kind: "putRoom", room: fillingPot("near@h", wallNow + 30 * DAY, wallNow + 31 * DAY) },
      // Far out but still filling, so a contribution could bring it back: not stranded, and the heal
      // reads it every boot without rewriting it.
      {
        kind: "putRoom",
        room: fillingPot("far@h", wallNow + 40 * 365 * DAY, wallNow + 41 * 365 * DAY),
      },
    ]);
    // What a row written before the horizon rule holds: the far-off unlock, so nothing wakes it.
    await backend.setDueAt("lost@h", room.state["unlockAt"] as number);
    expect(await dueIds(s, lockAt + TTL)).toEqual([]);

    const booted = await backend.boot();
    expect(await dueIds(booted, lockAt + TTL - 1)).toEqual([]);
    expect(await dueIds(booted, lockAt + TTL)).toEqual(["lost@h"]);
    // Every row is now inside the horizon, so a later boot rewrites nothing.
    expect(await booted.healLifecycleDue(wallNow + 10)).toBe(0);
  });
});
