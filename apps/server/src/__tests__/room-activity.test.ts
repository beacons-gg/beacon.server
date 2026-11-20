import { beforeEach, describe, expect, it, vi } from "vitest";
import { PgStore } from "../stores/pg.store";
import { pgTwin } from "./pg-twin";
import { makeJarRoom } from "./test-helpers";

/**
 * When each room last changed (migration 0024), behind the home page's "active today": every write
 * stamps the room, a room nobody has written since the migration has no stamp and is not counted.
 */
const pg = pgTwin((pool) => new PgStore(pool), ["rooms", "nonces"]);

describe("PgStore.countRoomsTouchedSince", () => {
  beforeEach(async () => {
    vi.useRealTimers();
    await pg.reset();
  });

  it("counts the rooms written since a time, a rewrite moving the room's time forward", async () => {
    const store = await pg.open();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-22T10:00:00Z"));
    await store.commit([
      { kind: "putRoom", room: makeJarRoom("old@h") },
      { kind: "putRoom", room: makeJarRoom("busy@h") },
    ]);
    vi.setSystemTime(new Date("2026-10-23T09:00:00Z"));
    await store.commit([{ kind: "putRoom", room: makeJarRoom("busy@h", 2) }]);
    await store.commit([{ kind: "putRoom", room: makeJarRoom("new@h") }]);
    vi.useRealTimers();

    const since = Date.parse("2026-10-23T00:00:00Z") / 1000;
    expect(await store.countRoomsTouchedSince(since)).toBe(2);
    expect(await store.countRoomsTouchedSince(since - 86_400)).toBe(3);
    expect(await store.countRooms()).toBe(3);
  });

  it("does not count a room left from before the migration, which has no time", async () => {
    const store = await pg.open();
    await store.commit([{ kind: "putRoom", room: makeJarRoom("stamped@h") }]);
    await pg.query("UPDATE rooms SET touched_at = NULL");
    expect(await store.countRoomsTouchedSince(0)).toBe(0);
    expect(await store.countRooms()).toBe(1);
  });
});
