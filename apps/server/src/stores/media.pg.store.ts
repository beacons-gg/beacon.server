import type { DidKey } from "@beaconsgg/protocol-types";
import type { Pool } from "pg";
import {
  MEDIA_SORTS,
  type MediaListPage,
  type MediaListQuery,
  type MediaRecord,
  type MediaStats,
  type MediaStore,
  toMediaListPage,
} from "./media-store";

// One column list so `get()` + `list()` can't drift as the row grows; `put()` keeps its own explicit
// insert (the review columns default NULL). Mirrors PLACE_COLUMNS in place.pg.store.ts.
const MEDIA_COLUMNS =
  "hash, type, size, owner, uploaded_at, last_access_at, reviewed_at, reviewed_by";

/** A DB row → the {@link MediaRecord} DTO. */
interface MediaDbRow {
  hash: string;
  type: string;
  size: number | string; // pg BIGINT comes back as string
  owner: string;
  uploaded_at: string;
  last_access_at: string | null;
  reviewed_at: string | null;
  reviewed_by: string | null;
}

function rowToRecord(r: MediaDbRow): MediaRecord {
  return {
    hash: r.hash,
    type: r.type,
    size: Number(r.size),
    owner: r.owner as DidKey,
    uploadedAt: r.uploaded_at,
    lastAccessAt: r.last_access_at,
    reviewedAt: r.reviewed_at,
    reviewedBy: r.reviewed_by as DidKey | null,
  };
}

/**
 * Postgres {@link MediaStore} — the production twin (`doc/spec/mailbox-and-media.md` §5.4), over
 * the `media` table (`0003_media`; review columns in `0013_media_review`).
 */
export class PgMediaStore implements MediaStore {
  constructor(private readonly pool: Pool) {}

  async put(rec: MediaRecord): Promise<{ existed: boolean }> {
    const res = await this.pool.query(
      "INSERT INTO media (hash, type, size, owner, uploaded_at, last_access_at) " +
        "VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (hash) DO NOTHING",
      [rec.hash, rec.type, rec.size, rec.owner, rec.uploadedAt, rec.lastAccessAt],
    );
    return { existed: (res.rowCount ?? 0) === 0 };
  }

  async get(hash: string): Promise<MediaRecord | undefined> {
    const res = await this.pool.query<MediaDbRow>(
      `SELECT ${MEDIA_COLUMNS} FROM media WHERE hash = $1`,
      [hash],
    );
    const row = res.rows[0];
    return row ? rowToRecord(row) : undefined;
  }

  // Keyset walk over (<column> DESC, hash DESC): only present filters/cursor become clauses, so the
  // sort's index (media_uploaded_at_hash_idx / media_size_hash_idx) serves the page (no OFFSET scan).
  // `column` comes from MEDIA_SORTS (an internal literal, never user input); `hash` (the PK) is the
  // strict tiebreak, so no row is skipped or repeated on ties. The cursor carries both keys, and
  // `MEDIA_SORTS[sort].value` reads the one this sort seeks on.
  async list(query: MediaListQuery): Promise<MediaListPage> {
    const { column, value } = MEDIA_SORTS[query.sort];
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (query.owner !== undefined) {
      params.push(query.owner);
      clauses.push(`owner = $${params.length}`);
    }
    if (query.type !== undefined) {
      params.push(query.type);
      clauses.push(`type = $${params.length}`);
    }
    if (query.reviewed === "unreviewed") clauses.push("reviewed_at IS NULL");
    else if (query.reviewed === "reviewed") clauses.push("reviewed_at IS NOT NULL");
    if (query.cursor !== undefined) {
      params.push(value(query.cursor));
      const at = params.length;
      params.push(query.cursor.hash);
      clauses.push(`(${column} < $${at} OR (${column} = $${at} AND hash < $${params.length}))`);
    }
    const where = clauses.length > 0 ? ` WHERE ${clauses.join(" AND ")}` : "";
    params.push(query.limit + 1); // one extra row detects a next page
    const res = await this.pool.query<MediaDbRow>(
      `SELECT ${MEDIA_COLUMNS} FROM media${where} ORDER BY ${column} DESC, hash DESC LIMIT $${params.length}`,
      params,
    );
    return toMediaListPage(res.rows.map(rowToRecord), query.limit);
  }

  async setReviewed(
    hash: string,
    reviewedBy: DidKey | null,
    reviewedAt: string | null,
  ): Promise<boolean> {
    const res = await this.pool.query(
      "UPDATE media SET reviewed_at = $1, reviewed_by = $2 WHERE hash = $3",
      [reviewedAt, reviewedBy, hash],
    );
    return (res.rowCount ?? 0) > 0;
  }

  async totalBytesFor(owner: DidKey): Promise<number> {
    const res = await this.pool.query<{ total: string }>(
      "SELECT COALESCE(SUM(size), 0) AS total FROM media WHERE owner = $1",
      [owner],
    );
    return Number(res.rows[0]?.total ?? 0);
  }

  async touch(hash: string, nowIso: string): Promise<void> {
    await this.pool.query("UPDATE media SET last_access_at = $1 WHERE hash = $2", [nowIso, hash]);
  }

  async delete(hash: string): Promise<boolean> {
    const res = await this.pool.query("DELETE FROM media WHERE hash = $1", [hash]);
    return (res.rowCount ?? 0) > 0;
  }

  async stats(): Promise<MediaStats> {
    const res = await this.pool.query<{ objects: string; bytes: string; unreviewed: string }>(
      "SELECT COUNT(*) AS objects, COALESCE(SUM(size), 0) AS bytes, " +
        "COUNT(*) FILTER (WHERE reviewed_at IS NULL) AS unreviewed FROM media",
    );
    const row = res.rows[0];
    return {
      objects: Number(row?.objects ?? 0),
      bytes: Number(row?.bytes ?? 0),
      unreviewed: Number(row?.unreviewed ?? 0),
    };
  }
}
