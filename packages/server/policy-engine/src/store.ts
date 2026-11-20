import type { GlobalId, OpResult, Room } from "@beaconsgg/protocol-types";
import { encode } from "@beaconsgg/geo";
import { nextTransitionAt } from "./lifecycle";

/**
 * Precision of the geohash prefix a Store indexes each room by, for {@link Store.roomsInCells}.
 * Matches `DEFAULT_PRECISION` in `@beaconsgg/geo` (the discovery indexing precision). A discovery
 * query passes coarser cells; a room matches when its finer index hash is prefixed by a query cell
 * (or vice versa — see the `prefixRelated` test in `@beaconsgg/geo`).
 */
export const ROOM_GEOHASH_PRECISION = 7;

/** The geohash prefix a room is indexed by (from its `location`, at {@link ROOM_GEOHASH_PRECISION}). */
export function roomGeohash(room: Room): string {
  return encode(room.location, ROOM_GEOHASH_PRECISION);
}

/**
 * The `lifecycle_due_at` a durable Store indexes a room by, for {@link Store.lifecycleRoomsDue}: the
 * epoch-second its next lifecycle work is due ({@link nextTransitionAt} at `nowSec`), or `null` for a
 * non-lifecycle room or one with no further work. A "due right now" transition comes back as `nowSec`.
 */
export function lifecycleDueAt(room: Room, nowSec: number): number | null {
  return nextTransitionAt(room, nowSec) ?? null;
}

/**
 * What a Store's on-open repair should write for a lifecycle row currently holding `stored`: the
 * recomputed due time, or `undefined` to leave the row alone.
 *
 * A row that is due both before and after is left alone: {@link Store.lifecycleRoomsDue} returns a
 * past time and "now" alike, so rewriting it would only churn the whole due backlog on every boot. A
 * NULL row, an early time that is really still in the future, and a row that should become NULL are
 * all rewritten.
 */
export function healedLifecycleDue(
  room: Room,
  stored: number | null,
  nowSec: number,
): { due: number | null } | undefined {
  const due = lifecycleDueAt(room, nowSec);
  if (due === stored) return undefined;
  if (stored !== null && stored <= nowSec && due !== null && due <= nowSec) return undefined;
  return { due };
}

/**
 * A single staged write. The engine collects every write of one logical operation (the room
 * mutation **and** its nonce record) into a batch and applies them with one {@link Store.commit},
 * so a durable Store can land them in a single transaction.
 */
export type Mutation =
  | { kind: "putRoom"; room: Room }
  | { kind: "deleteRoom"; id: GlobalId }
  | { kind: "putNonce"; nonce: string; result: OpResult };

/**
 * Custodied-state persistence behind an interface. The interface is **async** on purpose: a
 * production Store is a database, so reads/writes are awaited — which makes the server's per-room
 * mutex *load-bearing* (it must hold across a read→compute→commit cycle, so two ops on the same
 * room can't interleave at an await point). The in-memory test impl satisfies it by returning
 * resolved promises and the Postgres store awaits a real database; the discipline is the same one a
 * networked DB would force.
 *
 * Reads are plain queries. **All writes go through {@link commit}**, which is atomic: the batch
 * lands all-or-nothing, so a crash can't leave a room mutated but its op un-recorded (which a
 * retry would then re-apply, double-spending).
 */
export interface Store {
  getRoom(id: GlobalId): Promise<Room | undefined>;
  /** All live rooms — the server builds its geohash discovery index from these. */
  listRooms(): Promise<Room[]>;
  /** Idempotency: the short-lived nonce -> result record (`doc/spec/room-operation.md` §6.2). */
  getNonceResult(nonce: string): Promise<OpResult | undefined>;

  /** Apply a batch of writes atomically (all-or-nothing). */
  commit(mutations: Mutation[]): Promise<void>;

  /**
   * Rooms whose geohash prefix intersects any of the given discovery `cells` (a prefix test — one
   * is a prefix of the other). Backs spatial discovery *without a full table scan* against a
   * networked DB: the concrete stores serve it from a geohash-prefix column + index, so only the
   * matching rows come back. An empty `cells` returns no rooms.
   */
  roomsInCells(cells: string[]): Promise<Room[]>;

  /** Total custodied rooms — an aggregate `COUNT` read (admin observability), no row materialization. */
  countRooms(): Promise<number>;

  /**
   * Lifecycle rooms whose next transition (or pending close) is due at or before `nowSec` — the
   * ones the timer-wheel must process now. Lets the server seed / reconcile its scheduler without a
   * full `listRooms()` scan against a remote DB: the concrete stores back it with a
   * `lifecycle_due_at` column + index. Non-lifecycle rooms are never returned.
   */
  lifecycleRoomsDue(nowSec: number): Promise<Room[]>;
}
