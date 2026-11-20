import type { BlockEntry } from "@beaconsgg/protocol-types";
import type { Pool } from "pg";
import type { BlocklistStore } from "./blocklist-store";

const BLOCKLIST_COLUMNS = "did, reason, added_by, added_at";

/** A DB row → the {@link BlockEntry} DTO. */
interface BlocklistDbRow {
  did: string;
  reason: string | null;
  added_by: string;
  added_at: string;
}

function rowToEntry(r: BlocklistDbRow): BlockEntry {
  return {
    did: r.did as BlockEntry["did"],
    ...(r.reason !== null ? { reason: r.reason } : {}),
    addedBy: r.added_by,
    addedAt: r.added_at,
  };
}

/** The bind tuple for {@link BLOCKLIST_COLUMNS}. */
function entryToBind(e: BlockEntry): [string, string | null, string, string] {
  return [e.did, e.reason ?? null, e.addedBy, e.addedAt];
}

/**
 * Postgres {@link BlocklistStore}: the production twin (`doc/spec/admin-api.md` §3), over the
 * `blacklist` table (`0009_admin`).
 */
export class PgBlocklistStore implements BlocklistStore {
  constructor(private readonly pool: Pool) {}

  async put(entry: BlockEntry): Promise<void> {
    await this.pool.query(
      `INSERT INTO blacklist (${BLOCKLIST_COLUMNS}) VALUES ($1, $2, $3, $4) ` +
        "ON CONFLICT (did) DO UPDATE SET reason = excluded.reason, " +
        "added_by = excluded.added_by, added_at = excluded.added_at",
      entryToBind(entry),
    );
  }

  async remove(did: string): Promise<boolean> {
    const res = await this.pool.query("DELETE FROM blacklist WHERE did = $1", [did]);
    return (res.rowCount ?? 0) > 0;
  }

  async all(): Promise<BlockEntry[]> {
    // Byte order: both columns are `COLLATE "C"` (0023_byte_order), not the database's collation,
    // which an operator picks at createdb and which is linguistic by default (en_US puts `zb` first).
    const res = await this.pool.query<BlocklistDbRow>(
      `SELECT ${BLOCKLIST_COLUMNS} FROM blacklist ORDER BY added_at, did`,
    );
    return res.rows.map(rowToEntry);
  }
}
