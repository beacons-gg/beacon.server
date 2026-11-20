import type { AccessEntry } from "@beaconsgg/protocol-types";
import type { Pool } from "pg";
import type { AccessStore } from "./access-store";
import { columnsOf } from "./pg-columns";

const COLUMNS = ["did", "status", "note", "requested_at", "decided_by", "decided_at"] as const;

// Every row in one statement: one array parameter per column, zipped row-wise by `unnest`, the form
// the places store writes its batches in. Six parameters whatever the row count, so an admit-all of
// any size is one atomic round trip.
const UPSERT_MANY =
  `INSERT INTO access_members (${COLUMNS.join(", ")}) SELECT * FROM unnest(` +
  COLUMNS.map((_, i) => `$${String(i + 1)}::text[]`).join(", ") +
  ") ON CONFLICT (did) DO UPDATE SET " +
  COLUMNS.slice(1)
    .map((c) => `${c} = excluded.${c}`)
    .join(", ");

/** A DB row → the {@link AccessEntry} DTO. */
interface AccessDbRow {
  did: string;
  status: AccessEntry["status"];
  note: string | null;
  requested_at: string | null;
  decided_by: string | null;
  decided_at: string | null;
}

function rowToEntry(r: AccessDbRow): AccessEntry {
  return {
    did: r.did as AccessEntry["did"],
    status: r.status,
    ...(r.note !== null ? { note: r.note } : {}),
    ...(r.requested_at !== null ? { requestedAt: r.requested_at } : {}),
    ...(r.decided_by !== null ? { decidedBy: r.decided_by as AccessEntry["did"] } : {}),
    ...(r.decided_at !== null ? { decidedAt: r.decided_at } : {}),
  };
}

/** The bind values for {@link COLUMNS}, in order. */
function entryToBind(e: AccessEntry): (string | null)[] {
  return [
    e.did,
    e.status,
    e.note ?? null,
    e.requestedAt ?? null,
    e.decidedBy ?? null,
    e.decidedAt ?? null,
  ];
}

/** Postgres {@link AccessStore}: the production twin, over `access_members` (`0030_access`). */
export class PgAccessStore implements AccessStore {
  constructor(private readonly pool: Pool) {}

  async put(entries: readonly AccessEntry[]): Promise<void> {
    if (entries.length === 0) return;
    await this.pool.query(UPSERT_MANY, columnsOf(entries.map(entryToBind), COLUMNS.length));
  }

  async remove(did: string): Promise<boolean> {
    const res = await this.pool.query("DELETE FROM access_members WHERE did = $1", [did]);
    return (res.rowCount ?? 0) > 0;
  }

  async all(): Promise<AccessEntry[]> {
    const res = await this.pool.query<AccessDbRow>(
      `SELECT ${COLUMNS.join(", ")} FROM access_members ORDER BY did`,
    );
    return res.rows.map(rowToEntry);
  }
}
