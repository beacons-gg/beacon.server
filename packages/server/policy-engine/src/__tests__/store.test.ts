import type { Room } from "@beaconsgg/protocol-types";
import { describe, expect, it } from "vitest";
import { roomGeohash } from "../store";
import { InMemoryStore, timedPotPolicy } from "../testing";

/**
 * Unit tests for the two indexed queries on the `Store` interface: `roomsInCells` (discovery,
 * DB-backed) and `lifecycleRoomsDue` (seed the timer-wheel without a `listRooms()` full scan). The
 * `InMemoryStore` reference impl is the executable spec the server's PgStore must match.
 */

/** A minimal non-lifecycle (jar-shaped) room at a given point; the store treats `state` as opaque. */
function jarAt(id: string, lat: number, lng: number): Room {
  return {
    id,
    type: "jar",
    version: 1,
    location: { lat, lng },
    state: { contents: [] },
    policy: { ops: {} },
    placedBy: "did:key:z6MkSmokeTestAccountKeyAbCdEfGhJkLm",
  } as Room;
}

/**
 * A timed-pot (lifecycle) room stuck in `filling` with an explicit `lockAt`/`unlockAt`. The store
 * treats it as opaque JSON; `lifecycleRoomsDue` reads its lifecycle via `nextTransitionAt`.
 */
function potAt(id: string, lockAt: number, unlockAt: number, phase = "filling"): Room {
  return {
    id,
    type: "pot",
    version: 1,
    location: { lat: 47.61, lng: -122.34 },
    state: { contents: [], contributors: { alice: [] }, claimed: [], phase, lockAt, unlockAt },
    policy: timedPotPolicy({ lockDelaySec: 86_400, unlockDelaySec: 604_800, claimTtl: "7d" }),
    placedBy: "did:key:z6MkSmokeTestAccountKeyAbCdEfGhJkLm",
  } as Room;
}

describe("InMemoryStore.roomsInCells", () => {
  it("returns rooms whose geohash prefix intersects a query cell", async () => {
    const store = new InMemoryStore();
    // Space Needle, Seattle — both fall in the same coarse geohash cell.
    const seattleA = jarAt("a@h", 47.6205, -122.3493);
    const seattleB = jarAt("b@h", 47.6215, -122.3512);
    const london = jarAt("c@h", 51.5074, -0.1278);
    await store.commit([
      { kind: "putRoom", room: seattleA },
      { kind: "putRoom", room: seattleB },
      { kind: "putRoom", room: london },
    ]);

    // A coarse cell covering Seattle (a prefix of the rooms' finer index hashes).
    const seattleCell = roomGeohash(seattleA).slice(0, 5);
    const got = await store.roomsInCells([seattleCell]);
    expect(got.map((r) => r.id).sort()).toEqual(["a@h", "b@h"]);
  });

  it("matches on prefix in either direction (query cell finer than the index hash)", async () => {
    const store = new InMemoryStore();
    const room = jarAt("a@h", 47.6205, -122.3493);
    await store.commit([{ kind: "putRoom", room }]);

    // A query cell *finer* than the room's index hash still intersects (prefix either way).
    const finerCell = roomGeohash(room) + "0";
    expect((await store.roomsInCells([finerCell])).map((r) => r.id)).toEqual(["a@h"]);
  });

  it("returns [] for an empty cell list and for a non-overlapping cell", async () => {
    const store = new InMemoryStore();
    await store.commit([{ kind: "putRoom", room: jarAt("a@h", 47.6205, -122.3493) }]);
    expect(await store.roomsInCells([])).toEqual([]);
    expect(await store.roomsInCells(["gcpvj"])).toEqual([]); // a UK cell — no overlap
  });

  it("unions across multiple query cells (no duplicates)", async () => {
    const store = new InMemoryStore();
    const seattle = jarAt("a@h", 47.6205, -122.3493);
    const london = jarAt("b@h", 51.5074, -0.1278);
    await store.commit([
      { kind: "putRoom", room: seattle },
      { kind: "putRoom", room: london },
    ]);
    const cells = [roomGeohash(seattle).slice(0, 5), roomGeohash(london).slice(0, 5)];
    expect((await store.roomsInCells(cells)).map((r) => r.id).sort()).toEqual(["a@h", "b@h"]);
  });
});

describe("InMemoryStore.lifecycleRoomsDue", () => {
  it("returns lifecycle rooms whose next transition is due at/before now", async () => {
    const store = new InMemoryStore();
    const now = 1_000_000;
    const overdue = potAt("overdue@h", now - 10, now + 500); // lockAt already passed → due
    const future = potAt("future@h", now + 100, now + 500); // lockAt in the future → not due
    await store.commit([
      { kind: "putRoom", room: overdue },
      { kind: "putRoom", room: future },
    ]);

    const due = await store.lifecycleRoomsDue(now);
    expect(due.map((r) => r.id)).toEqual(["overdue@h"]);
  });

  it("treats a room exactly at its boundary as due (>= now)", async () => {
    const store = new InMemoryStore();
    const now = 1_000_000;
    await store.commit([{ kind: "putRoom", room: potAt("edge@h", now, now + 500) }]);
    expect((await store.lifecycleRoomsDue(now)).map((r) => r.id)).toEqual(["edge@h"]);
  });

  it("never returns non-lifecycle rooms", async () => {
    const store = new InMemoryStore();
    const now = 1_000_000;
    await store.commit([
      { kind: "putRoom", room: jarAt("jar@h", 47.61, -122.34) },
      { kind: "putRoom", room: potAt("cap@h", now - 5, now + 500) },
    ]);
    expect((await store.lifecycleRoomsDue(now)).map((r) => r.id)).toEqual(["cap@h"]);
  });

  it("returns a room due for close (claimTtl elapsed past unlockAt)", async () => {
    const store = new InMemoryStore();
    const now = 1_000_000;
    // Fully in `open`, ttl 7d (604800s) elapsed since unlockAt → lifecycleRoomShouldClose → due.
    const stale = potAt("stale@h", now - 700_000, now - 604_801, "open");
    await store.commit([{ kind: "putRoom", room: stale }]);
    expect((await store.lifecycleRoomsDue(now)).map((r) => r.id)).toEqual(["stale@h"]);
  });
});
