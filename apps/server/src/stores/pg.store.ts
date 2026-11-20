import {
  healedLifecycleDue,
  lifecycleDueAt,
  type Mutation,
  nowSeconds,
  roomGeohash,
  type Store,
} from "@beaconsgg/policy-engine";
import {
  type GlobalId,
  type OpResult,
  type Room,
  TRANSITION_HORIZON_SEC,
} from "@beaconsgg/protocol-types";
import type { Pool } from "pg";

const DEFAULT_MAX_NONCES = 50_000;

/**
 * A durable {@link Store} backed by PostgreSQL via **node-postgres (`pg`)** — the production
 * custody implementation, and the only one a server runs on. The engine is unaware of it because
 * the async/batch seams were built for exactly this swap.
 *
 * Design choices:
 * - **`commit(Mutation[])` = one `BEGIN … COMMIT`** on a single pooled client. The engine hands the
 *   full write set (room mutation **+** nonce record) at once, so the transaction never spans an
 *   engine `await` — it maps cleanly to BEGIN → awaited statements → COMMIT (ROLLBACK on error).
 * - **`INSERT … ON CONFLICT … DO UPDATE`** upsert.
 * - Room and `OpResult` stored as **`JSONB`**.
 * - A **`geohash` column + index** backs {@link roomsInCells}; a **`lifecycle_due_at` column +
 *   partial index** backs {@link lifecycleRoomsDue}. Both are derived from the Room on write.
 * - The nonce log is FIFO-pruned to `maxNonces` in the same transaction as a nonce write.
 *
 * The pool, and the migration run before any store opens, are the store factory's. The factory
 * also runs {@link healLifecycleDue} once per boot.
 */
export class PgStore implements Store {
  /** `maxNonces` is the FIFO cap on the nonce idempotency log. */
  constructor(
    private readonly pool: Pool,
    private readonly maxNonces: number = DEFAULT_MAX_NONCES,
  ) {}

  /**
   * Repair `lifecycle_due_at` for lifecycle rooms stored as NULL, already due, or due past the
   * transition horizon, returning how many rows changed. The store factory runs it once per boot, and
   * nothing else does; {@link healedLifecycleDue} decides each row.
   *
   * The column is derived at write time, so a row keeps what the rule of its last write said. Under
   * an earlier rule, a room that settled after its `unlockAt` could be stored NULL, which {@link
   * lifecycleRoomsDue} never returns, so nothing wrote it again; or with an early time that came
   * back on every reconcile. Those are the two shapes this repairs.
   *
   * A row whose stored time is still in the future is not revisited, and the earlier rule left some
   * of those too: a room settled after `unlockAt` while `placedAt + ttl` was still ahead. Once that
   * early time passes, reconcile schedules the right close in memory and re-reads the row each
   * minute until the room closes or the next open repairs it, a bounded cost of at most one old
   * claim window. A later rule change that moves due times earlier would need its own pass.
   *
   * The horizon rule is one: a room stranded behind a transition past {@link
   * TRANSITION_HORIZON_SEC} now closes a claim window after it got stuck, but its row still holds
   * the decades-away time the old rule wrote. So a row due past the horizon is revisited too. That
   * also reads the rare room that legitimately stays that far out (one that drifted there in a
   * phase that can still move it, or a settled room with a very long `claimTtl`) on every open, but
   * rewrites only the rows whose due time changed.
   *
   * Between opens nothing rewrites a row whose wake found nothing to do: the wheel drops the room and
   * reconcile keeps re-reading the row. Keeping `nextTransitionAt` in agreement with `advancePhase`
   * is what prevents that, not this repair.
   *
   * One server process per database (doc/deploy.md, "Topology") makes this server the only writer
   * of its database, so nothing should race this pass. Each update is still conditional on the row
   * holding the value this pass read, as cheap defence for the moments that rule is broken: a
   * rolling deploy that briefly overlaps two servers, or a second server pointed at the same
   * database. A row a concurrent commit has just rewritten carries a due time derived from newer
   * data, and is left alone.
   */
  async healLifecycleDue(nowSec: number = nowSeconds(Date.now())): Promise<number> {
    const res = await this.pool.query<{ id: string; data: Room; due: string | null }>(
      "SELECT id, data, lifecycle_due_at AS due FROM rooms " +
        "WHERE data->'policy'->'lifecycle' IS NOT NULL " +
        "AND (lifecycle_due_at IS NULL OR lifecycle_due_at <= $1 OR lifecycle_due_at > $2)",
      [nowSec, nowSec + TRANSITION_HORIZON_SEC],
    );
    let changed = 0;
    for (const row of res.rows) {
      const stored = row.due === null ? null : Number(row.due); // BIGINT arrives as a string
      const healed = healedLifecycleDue(row.data, stored, nowSec);
      if (!healed) continue;
      const updated = await this.pool.query(
        "UPDATE rooms SET lifecycle_due_at = $1 WHERE id = $2 AND lifecycle_due_at IS NOT DISTINCT FROM $3",
        [healed.due, row.id, stored],
      );
      changed += updated.rowCount ?? 0;
    }
    return changed;
  }

  async getRoom(id: GlobalId): Promise<Room | undefined> {
    const res = await this.pool.query<{ data: Room }>("SELECT data FROM rooms WHERE id = $1", [id]);
    return res.rows[0]?.data;
  }

  async listRooms(): Promise<Room[]> {
    const res = await this.pool.query<{ data: Room }>("SELECT data FROM rooms");
    return res.rows.map((r) => r.data);
  }

  async getNonceResult(nonce: string): Promise<OpResult | undefined> {
    const res = await this.pool.query<{ result: OpResult }>(
      "SELECT result FROM nonces WHERE nonce = $1",
      [nonce],
    );
    return res.rows[0]?.result;
  }

  async commit(mutations: Mutation[]): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      let touchedNonces = false;
      for (const m of mutations) {
        if (m.kind === "putRoom") {
          const now = nowSeconds(Date.now());
          await client.query(
            "INSERT INTO rooms (id, data, geohash, lifecycle_due_at, touched_at) VALUES ($1, $2, $3, $4, $5) " +
              "ON CONFLICT (id) DO UPDATE SET data = excluded.data, geohash = excluded.geohash, " +
              "lifecycle_due_at = excluded.lifecycle_due_at, touched_at = excluded.touched_at",
            [
              m.room.id,
              JSON.stringify(m.room),
              roomGeohash(m.room),
              lifecycleDueAt(m.room, now),
              now,
            ],
          );
        } else if (m.kind === "deleteRoom") {
          await client.query("DELETE FROM rooms WHERE id = $1", [m.id]);
        } else {
          await client.query(
            "INSERT INTO nonces (nonce, result) VALUES ($1, $2) " +
              "ON CONFLICT (nonce) DO UPDATE SET result = excluded.result",
            [m.nonce, JSON.stringify(m.result)],
          );
          touchedNonces = true;
        }
      }
      // Bound the idempotency log FIFO (by insertion seq) in the same transaction.
      if (touchedNonces) {
        await client.query(
          "DELETE FROM nonces WHERE seq <= (SELECT COALESCE(MAX(seq), 0) FROM nonces) - $1",
          [this.maxNonces],
        );
      }
      await client.query("COMMIT");
      client.release();
    } catch (err) {
      // Roll back best-effort, then release the client AS FAILED (`release(err)`) so a connection
      // broken mid-transaction is destroyed + evicted from the pool — not handed to the next commit in
      // an aborted-transaction state. A plain `release()` in a `finally` would return it clean.
      try {
        await client.query("ROLLBACK");
      } catch {
        /* connection likely already broken; the failed release below discards it */
      }
      client.release(err instanceof Error ? err : new Error(String(err)));
      throw err;
    }
  }

  async roomsInCells(cells: string[]): Promise<Room[]> {
    if (cells.length === 0) return [];
    // Prefix test: a room matches when its geohash starts with a query cell, OR the query cell
    // starts with the room's geohash (either direction). `like_prefix || '%'` uses the
    // text_pattern_ops index for the common (cell-prefixes-geohash) case.
    const clauses: string[] = [];
    const params: string[] = [];
    let i = 1;
    for (const cell of cells) {
      clauses.push(`geohash LIKE $${i} || '%' OR $${i} LIKE geohash || '%'`);
      params.push(cell);
      i += 1;
    }
    const res = await this.pool.query<{ data: Room }>(
      `SELECT DISTINCT data FROM rooms WHERE ${clauses.join(" OR ")}`,
      params,
    );
    return res.rows.map((r) => r.data);
  }

  async lifecycleRoomsDue(nowSec: number): Promise<Room[]> {
    const res = await this.pool.query<{ data: Room }>(
      "SELECT data FROM rooms WHERE lifecycle_due_at IS NOT NULL AND lifecycle_due_at <= $1",
      [nowSec],
    );
    return res.rows.map((r) => r.data);
  }

  /**
   * Rooms from before game slugs: no game can read or act on one until it is stamped
   * (doc/deploy.md). Counted for the boot log.
   */
  async countWithoutGame(): Promise<number> {
    const res = await this.pool.query<{ n: string }>(
      "SELECT COUNT(*) AS n FROM rooms WHERE NOT (data ? 'game')",
    );
    return Number(res.rows[0]?.n ?? 0);
  }

  async countRooms(): Promise<number> {
    const res = await this.pool.query<{ n: string }>("SELECT COUNT(*) AS n FROM rooms");
    return Number(res.rows[0]?.n ?? 0);
  }

  /**
   * Rooms written at or after `sinceSec` (Unix seconds): the home page's "active today". A room not
   * written since migration 0024 has no time and is not counted.
   */
  async countRoomsTouchedSince(sinceSec: number): Promise<number> {
    const res = await this.pool.query<{ n: string }>(
      "SELECT COUNT(*) AS n FROM rooms WHERE touched_at >= $1",
      [sinceSec],
    );
    return Number(res.rows[0]?.n ?? 0);
  }
}
