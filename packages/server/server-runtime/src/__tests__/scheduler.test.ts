import { describe, expect, it } from "vitest";
import { LifecycleScheduler, MAX_TIMER_MS, tickDelay } from "../scheduler";

describe("LifecycleScheduler", () => {
  it("returns due rooms in time order and leaves future ones", () => {
    const s = new LifecycleScheduler();
    s.set("a", 300);
    s.set("b", 100);
    s.set("c", 200);
    expect(s.nextDueAt()).toBe(100);
    expect(s.dueBefore(200)).toEqual(["b", "c"]); // earliest first; 'a' (300) stays
    expect(s.size).toBe(1);
    expect(s.nextDueAt()).toBe(300);
    expect(s.dueBefore(1000)).toEqual(["a"]);
    expect(s.nextDueAt()).toBeUndefined();
  });

  it("a reschedule supersedes the old time (lazy deletion)", () => {
    const s = new LifecycleScheduler();
    s.set("a", 100);
    s.set("a", 500); // move it later
    expect(s.size).toBe(1);
    expect(s.dueBefore(200)).toEqual([]); // the old 100 entry is stale, not returned
    expect(s.nextDueAt()).toBe(500);
    expect(s.dueBefore(500)).toEqual(["a"]);
  });

  it("delete removes a room even if its old time was already due", () => {
    const s = new LifecycleScheduler();
    s.set("a", 100);
    s.set("b", 100);
    s.delete("a");
    expect(s.size).toBe(1);
    expect(s.dueBefore(100)).toEqual(["b"]);
  });

  it("dueBefore consumes rooms (re-set to reschedule)", () => {
    const s = new LifecycleScheduler();
    s.set("a", 100);
    expect(s.dueBefore(100)).toEqual(["a"]);
    expect(s.size).toBe(0); // consumed
    s.set("a", 200); // caller reschedules
    expect(s.dueBefore(150)).toEqual([]);
    expect(s.dueBefore(200)).toEqual(["a"]);
  });

  it("stays correct after many reschedules (heap compaction)", () => {
    const s = new LifecycleScheduler();
    for (let i = 0; i < 1000; i++) s.set("x", i); // 1000 reschedules of one room
    expect(s.size).toBe(1);
    expect(s.nextDueAt()).toBe(999); // only the latest stands
    expect(s.dueBefore(998)).toEqual([]);
    expect(s.dueBefore(999)).toEqual(["x"]);
  });
});

describe("tickDelay — a wake that Node will actually honour", () => {
  const NOW = 1_800_000_000_000;

  it("sleeps in bounded hops past Node's 32-bit timer ceiling", () => {
    // The bug this exists to prevent: `setTimeout` truncates any delay past 2^31-1 ms to ONE
    // millisecond (with only a warning), so a room a month out would wake instantly, find nothing
    // due, re-arm identically, and spin the event loop until its boundary finally arrived.
    const A_YEAR = 365 * 86_400_000;
    expect(A_YEAR).toBeGreaterThan(2 ** 31 - 1); // the delay a year-long challenge would ask for
    expect(tickDelay(NOW + A_YEAR, NOW)).toBe(MAX_TIMER_MS);
    expect(MAX_TIMER_MS).toBeLessThan(2 ** 31 - 1);
  });

  it("passes a short wait through, and wakes immediately for an overdue room", () => {
    expect(tickDelay(NOW + 5_000, NOW)).toBe(5_000);
    expect(tickDelay(NOW - 60_000, NOW)).toBe(0); // never negative
  });
});
