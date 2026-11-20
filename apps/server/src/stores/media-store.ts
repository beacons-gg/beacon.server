import type { DidKey } from "@beaconsgg/protocol-types";

/** Media metadata (the bytes live in the {@link MediaBlobStore}); keyed by the content `hash`. */
export interface MediaRecord {
  hash: string; // sha256 base64url content id
  type: string; // MIME type
  size: number; // byte length
  owner: DidKey; // uploader account did:key
  uploadedAt: string; // ISO-8601 UTC
  lastAccessAt: string | null; // ISO-8601 UTC, stamped on fetch
  reviewedAt: string | null; // ISO-8601 UTC an admin marked it reviewed (`doc/spec/admin-api.md` §3); null = unreviewed
  reviewedBy: DidKey | null; // the reviewing admin account did:key; null = unreviewed
}

/** The ordering for {@link MediaStore.list}: `recent` = newest-first (default), `size` = largest-first. */
export type MediaSort = "recent" | "size";

/**
 * The keyset cursor for {@link MediaStore.list} — the last row on a page, carrying every field a sort
 * might key on (`uploadedAt` for `recent`, `size` for `size`) plus `hash` as the strict tiebreak. The
 * shape is sort-agnostic: the store's `list` compares the fields its `sort` needs. The wire ships it as
 * one opaque base64url token (encoded/decoded at the controller seam), so the key never leaks its shape.
 */
export interface MediaCursor {
  uploadedAt: string;
  hash: string;
  size: number;
}

/** The admin media-list query (`doc/spec/admin-api.md` §3) — filtered, sorted, keyset-paginated. */
export interface MediaListQuery {
  limit: number; // caller-clamped page size (1..N); the store fetches limit+1 to detect a next page
  sort: MediaSort; // ordering (controller defaults to "recent"); the cursor must match the sort
  cursor?: MediaCursor; // return only rows *after* this one in the sort's (key DESC, hash DESC) order
  owner?: DidKey; // exact uploader filter
  type?: string; // exact MIME filter
  reviewed?: "reviewed" | "unreviewed"; // omitted = all
}

/** One page of the admin media list: the rows plus the cursor to fetch the next page (absent = last). */
export interface MediaListPage {
  items: MediaRecord[];
  nextCursor?: MediaCursor;
}

/**
 * Durable media-metadata index (`doc/spec/mailbox-and-media.md` §5.4). Same pattern as the other
 * stores: {@link PgMediaStore} implements it, and the service suites run on an in-memory fake
 * (`__tests__/memory-stores.ts`) held to the same parity suite. Content-addressed: `put` is
 * idempotent on `hash` (identical content dedupes to one row), and quota is a `SUM(size)` per
 * owner.
 */
export interface MediaStore {
  /** Insert metadata; idempotent on the content `hash`. `existed` ⇒ this content was already stored. */
  put(rec: MediaRecord): Promise<{ existed: boolean }>;
  /** Look up metadata by content hash. */
  get(hash: string): Promise<MediaRecord | undefined>;
  /** Total bytes an owner currently has stored (for the per-DID quota). */
  totalBytesFor(owner: DidKey): Promise<number>;
  /** Stamp `last_access_at` on fetch (recorded now; no auto-eviction yet). */
  touch(hash: string, nowIso: string): Promise<void>;
  /** Delete the metadata row (admin moderation); true if a row was actually removed. */
  delete(hash: string): Promise<boolean>;
  /**
   * The admin browse read (`doc/spec/admin-api.md` §3): newest-first, filtered, keyset-paginated.
   * Admin-only — enumerating hashes/owners is a gated capability (individual bytes were already
   * public-by-hash).
   */
  list(query: MediaListQuery): Promise<MediaListPage>;
  /**
   * Set (or clear) the moderation review stamp on one object — `reviewedAt`/`reviewedBy` together, or
   * both `null` to un-review. Returns whether a row matched (idempotent; unknown hash ⇒ false).
   */
  setReviewed(hash: string, reviewedBy: DidKey | null, reviewedAt: string | null): Promise<boolean>;
  /** Store-wide totals — a cheap operational read for `admin.status` (`doc/spec/admin-api.md` §3). */
  stats(): Promise<MediaStats>;
}

/** Store-wide media totals (`COUNT(*)` + `SUM(size)` in the Postgres store). */
export interface MediaStats {
  /** Content-addressed objects stored. */
  objects: number;
  /** Total stored bytes across all owners. */
  bytes: number;
  /** Objects an admin hasn't marked reviewed yet — the review-queue to-do number. */
  unreviewed: number;
}

/** How one sort maps to its keyset: the DB `column` to order/seek on, and the row's comparand for it. */
export interface MediaSortSpec {
  /** ORDER BY / keyset column — a fixed literal from this map, never user input, so it is interpolated safely. */
  column: "uploaded_at" | "size";
  /** The sort's keyset comparand for a row/cursor (backed by an index per {@link MediaSort}). */
  value: (row: Pick<MediaRecord, "uploadedAt" | "size">) => string | number;
}

/**
 * The single source of truth mapping each {@link MediaSort} to its keyset column + comparand — so all
 * implementations order and page the same way and a new sort is one entry, not a ternary edited in each
 * (as {@link toMediaListPage} is for paging). Every column here is index-backed
 * (`media_uploaded_at_hash_idx`, `media_size_hash_idx`), so the keyset walk is a seek, not a scan.
 */
export const MEDIA_SORTS: Record<MediaSort, MediaSortSpec> = {
  recent: { column: "uploaded_at", value: (r) => r.uploadedAt },
  size: { column: "size", value: (r) => r.size },
};

/**
 * Turn a fetched slice into a {@link MediaListPage}: if more rows came back than the page size, the
 * page is full and a `nextCursor` is derived from the last kept row. The Postgres store passes
 * `limit+1` mapped rows; the memory fake passes its full filtered/sorted list — both correct, since
 * the "more exist" test is `records.length > limit`. One derivation site so the two can't disagree.
 */
export function toMediaListPage(records: MediaRecord[], limit: number): MediaListPage {
  const hasMore = records.length > limit;
  const items = hasMore ? records.slice(0, limit) : records;
  const last = items[items.length - 1];
  return hasMore && last
    ? { items, nextCursor: { uploadedAt: last.uploadedAt, hash: last.hash, size: last.size } }
    : { items };
}
