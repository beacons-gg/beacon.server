/**
 * A min-heap of `(dueAt, roomId)` for the lifecycle timer-wheel (`doc/spec/room-operation.md`
 * §8.4). Instead of scanning every room each tick, the server schedules each lifecycle room at its
 * next-transition time and processes only the rooms that are actually **due** — O(due) per wake,
 * not O(rooms).
 *
 * Rescheduling and removal use **lazy deletion**: `set` just records the room's current intended
 * time and pushes a fresh heap entry, and a `roomId -> dueAt` map is the source of truth. A popped
 * entry whose `dueAt` no longer matches the map is stale (superseded by a reschedule, or the room
 * was deleted) and is skipped. The heap is compacted when stale entries pile up, so it stays
 * O(live rooms).
 */
interface Entry {
  dueAt: number;
  roomId: string;
}

/**
 * The longest a single wake may be scheduled for. Node's `setTimeout` stores its delay in a signed
 * 32-bit int: anything past 2^31-1 ms (~24.9 days) is **silently truncated to 1 ms** with only a
 * `TimeoutOverflowWarning`. A room whose next boundary is further out than that — a challenge may
 * run for up to a year — would therefore wake immediately, find nothing due, re-arm with the same
 * out-of-range delay, and spin the event loop for the rest of the month.
 *
 * So a long wait is slept in hops: each wake finds nothing due and re-arms. A day is far inside the
 * limit and costs one spurious wake per idle day.
 */
export const MAX_TIMER_MS = 86_400_000;

/**
 * How long to sleep before the next lifecycle wake, given the earliest scheduled boundary: never
 * negative (an overdue room wakes now), never past {@link MAX_TIMER_MS} (see above).
 */
export function tickDelay(dueAtMs: number, nowMs: number): number {
  return Math.min(Math.max(0, dueAtMs - nowMs), MAX_TIMER_MS);
}

export class LifecycleScheduler {
  private readonly heap: Entry[] = [];
  /** The current intended due time per room — the source of truth; heap entries that disagree are stale. */
  private readonly due = new Map<string, number>();

  /** Schedule (or reschedule) `roomId` to be processed at `dueAtMs` (epoch ms). */
  set(roomId: string, dueAtMs: number): void {
    this.due.set(roomId, dueAtMs);
    this.push({ dueAt: dueAtMs, roomId });
    // Bound stale-entry buildup from repeated reschedules.
    if (this.heap.length > 2 * this.due.size + 16) this.rebuild();
  }

  /** Remove `roomId` from the schedule (its heap entries become stale and are skipped). */
  delete(roomId: string): void {
    this.due.delete(roomId);
  }

  /** Count of scheduled rooms. */
  get size(): number {
    return this.due.size;
  }

  /** The earliest scheduled time (epoch ms), or `undefined` if nothing is scheduled. */
  nextDueAt(): number | undefined {
    this.dropStaleRoots();
    return this.heap[0]?.dueAt;
  }

  /**
   * Pop and return every room currently due at or before `nowMs`, removing them from the schedule.
   * The caller processes each and reschedules (via `set`) or leaves it dropped (e.g. on close).
   */
  dueBefore(nowMs: number): string[] {
    const out: string[] = [];
    for (;;) {
      this.dropStaleRoots();
      const top = this.heap[0];
      if (!top || top.dueAt > nowMs) break;
      const e = this.pop() as Entry;
      this.due.delete(e.roomId);
      out.push(e.roomId);
    }
    return out;
  }

  /** Drop heap roots whose `dueAt` no longer matches the map (stale: rescheduled or deleted). */
  private dropStaleRoots(): void {
    while (this.heap.length > 0) {
      const top = this.heap[0] as Entry;
      if (this.due.get(top.roomId) === top.dueAt) break;
      this.pop();
    }
  }

  private rebuild(): void {
    this.heap.length = 0;
    for (const [roomId, dueAt] of this.due) this.push({ dueAt, roomId });
  }

  private push(e: Entry): void {
    const h = this.heap;
    h.push(e);
    let i = h.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if ((h[p] as Entry).dueAt <= (h[i] as Entry).dueAt) break;
      [h[p], h[i]] = [h[i] as Entry, h[p] as Entry];
      i = p;
    }
  }

  private pop(): Entry | undefined {
    const h = this.heap;
    const top = h[0];
    const last = h.pop();
    if (h.length > 0 && last !== undefined) {
      h[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = 2 * i + 2;
        let s = i;
        if (l < h.length && (h[l] as Entry).dueAt < (h[s] as Entry).dueAt) s = l;
        if (r < h.length && (h[r] as Entry).dueAt < (h[s] as Entry).dueAt) s = r;
        if (s === i) break;
        [h[s], h[i]] = [h[i] as Entry, h[s] as Entry];
        i = s;
      }
    }
    return top;
  }
}
