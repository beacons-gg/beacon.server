import type { GlobalId, OpResult, Room } from "@beaconsgg/protocol-types";
import { nextTransitionAt } from "./lifecycle";
import { roomGeohash, type Mutation, type Store } from "./store";

/** Two geohash cells intersect iff one is a prefix of the other (same area, any precision). */
function prefixRelated(a: string, b: string): boolean {
  return a.startsWith(b) || b.startsWith(a);
}

/**
 * A trivial in-memory Store. At-risk by construction (process restart = gone) — it *literally
 * models "at-risk"* and backs the unit tests. Test-only, exported from
 * `@beaconsgg/policy-engine/testing`: no server can run on it, since a server without a database
 * refuses to start. `commit` is atomic for free: there is no await between the writes in a batch,
 * so JS can't interleave another op mid-batch.
 */
export class InMemoryStore implements Store {
  private readonly rooms = new Map<GlobalId, Room>();
  private readonly nonces = new Map<string, OpResult>();
  /** Bound the nonce→result map (FIFO) so it can't grow without limit. */
  private readonly maxNonces: number;

  constructor(options: { maxNonces?: number } = {}) {
    this.maxNonces = options.maxNonces ?? 50_000;
  }

  getRoom(id: GlobalId): Promise<Room | undefined> {
    return Promise.resolve(this.rooms.get(id));
  }
  listRooms(): Promise<Room[]> {
    return Promise.resolve([...this.rooms.values()]);
  }
  getNonceResult(nonce: string): Promise<OpResult | undefined> {
    return Promise.resolve(this.nonces.get(nonce));
  }

  commit(mutations: Mutation[]): Promise<void> {
    for (const m of mutations) {
      if (m.kind === "putRoom") {
        this.rooms.set(m.room.id, m.room);
      } else if (m.kind === "deleteRoom") {
        this.rooms.delete(m.id);
      } else {
        this.nonces.set(m.nonce, m.result);
        if (this.nonces.size > this.maxNonces) {
          const oldest = this.nonces.keys().next().value;
          if (oldest !== undefined) this.nonces.delete(oldest);
        }
      }
    }
    return Promise.resolve();
  }

  roomsInCells(cells: string[]): Promise<Room[]> {
    if (cells.length === 0) return Promise.resolve([]);
    const out: Room[] = [];
    for (const room of this.rooms.values()) {
      const hash = roomGeohash(room);
      if (cells.some((cell) => prefixRelated(hash, cell))) out.push(room);
    }
    return Promise.resolve(out);
  }

  lifecycleRoomsDue(nowSec: number): Promise<Room[]> {
    const out: Room[] = [];
    for (const room of this.rooms.values()) {
      const due = nextTransitionAt(room, nowSec);
      if (due !== undefined && due <= nowSec) out.push(room);
    }
    return Promise.resolve(out);
  }

  countRooms(): Promise<number> {
    return Promise.resolve(this.rooms.size);
  }
}
