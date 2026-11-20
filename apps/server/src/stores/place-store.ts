import { isGeohash } from "@beaconsgg/geo";
import type {
  ContribLicense,
  LatLng,
  Media,
  MediaCredit,
  PlaceCategory,
  PlaceGeometry,
  PlaceSnapshotParams,
  PlaceSnapshotStats,
  PlaceSubcategory,
} from "@beaconsgg/protocol-types";

/**
 * The owned places dataset (`doc/spec/places.md` §3) — the durable heart of the v2 places
 * capability. Same pattern as the other stores ({@link PgPlaceStore}, plus an in-memory fake for
 * the service suites), but one store owns six tables. Five of them commit **atomically**
 * (`commitPlace`): the canonical row, its source record, its cell index, and any conflicts.
 *
 * The sixth, `place_proposals` (`doc/spec/place-proposals.md` §3), is deliberately **outside** that
 * transaction. It lives here because it shares the capability flag, the pool, and the migration
 * series — but approval is two writes (commit the place, then stamp the proposal), made safe by
 * giving a new-place proposal's `id` to the place it creates: a crash in between leaves a pending
 * row whose re-run upserts the same place. Don't fold a proposal write into `commitPlace`.
 *
 * The store persists and queries; it never merges. Field-priority merge + conflict derivation are
 * pure functions in `places/merge.ts` — callers compute the canonical record from the source records
 * and hand the result here.
 */

/** The mergeable canonical fields a source record can contribute (`doc/spec/places.md` §3.1). */
export interface PlaceFields {
  category?: PlaceCategory;
  subcategory?: PlaceSubcategory;
  name?: string;
  description?: string;
  descriptionCredit?: MediaCredit;
  website?: string;
  wikipedia?: string;
  altNames?: string[];
  point?: LatLng;
  geometry?: PlaceGeometry;
  media?: Media[];
}

/** One canonical place — what queries serve, always. */
export interface PlaceRecord {
  /** ULID; addressable as `unique@host`; survives export/import. */
  unique: string;
  category: PlaceCategory;
  subcategory?: PlaceSubcategory;
  name?: string;
  /** Detail-only on the wire (list rows stay light) — but merged/stored like every field. */
  description?: string;
  /** Attribution for `description` when its source has terms (a CC BY-SA Wikipedia summary). */
  descriptionCredit?: MediaCredit;
  website?: string;
  wikipedia?: string;
  altNames?: string[];
  point: LatLng;
  geometry?: PlaceGeometry;
  media?: Media[];
  status: "active" | "retired";
  createdAt: string;
  updatedAt: string;
}

/** One `(source, sourceId)` record — where each fact came from. */
export interface PlaceSourceRecord {
  source: string; // 'osm' | 'list:<name>' | 'admin' | future connectors
  sourceId: string; // e.g. 'node/123'; for admin rows, the place unique
  placeUnique: string;
  fields: PlaceFields;
  raw?: unknown; // raw payload (e.g. OSM tags) for re-mapping/debug
  attribution?: string;
  editedBy?: string; // admin-source audit
  editedAt?: string;
  syncedAt: string;
  goneAt?: string; // set when a fresh in-scope sync no longer returns it
}

/** One durable ingestion run — the audit trail + the re-run/refresh unit (`doc/spec/places.md` §6.2). */
export interface PlaceSnapshotRecord {
  id: string;
  source: string;
  params: PlaceSnapshotParams; // stored verbatim — a re-run is a refresh (wire-typed: protocol-types owns the shape)
  requestedBy: string; // admin DID
  status: "queued" | "running" | "done" | "failed";
  stats?: PlaceSnapshotStats;
  error?: string;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
}

/** A pending revision: connector data that would change an admin-held field (`doc/spec/places.md` §3.1). */
export interface PlaceConflictRecord {
  id: string;
  placeUnique: string;
  field: string;
  currentValue?: unknown;
  incomingValue: unknown;
  source: string;
  snapshotId?: string;
  createdAt: string;
  resolvedAt?: string;
}

/**
 * One player-submitted contribution awaiting review (`doc/spec/place-proposals.md` §3) — a place
 * the dataset doesn't have, or descriptor fields for one it does. **Nothing here is visible to a
 * read path.** An approved proposal is applied separately, as a `contrib` source record through the
 * same merge/commit pipeline every connector uses; this row is then stamped with the outcome.
 */
export interface PlaceProposalRecord {
  /**
   * ULID. For a **new-place** proposal this also becomes the created place's `unique` — which is
   * what makes approval idempotent: a retry re-upserts the same place instead of minting a second.
   */
  id: string;
  /** The place being improved. Absent ⇒ this proposes a brand-new place. */
  placeUnique?: string;
  /** The contributor's DID (cryptographically verified at submit). */
  proposedBy: string;
  /** Publish the contributor alongside the place — opt-in per submission (`doc/spec/place-proposals.md` §3.2). */
  credit: boolean;
  /**
   * The licence the contributor granted, covering this submission's text and photos alike.
   *
   * Optional because the column postdates the table (0021): a row without one was never granted
   * anything, which is why it can never be exported. `places.propose` requires it, and an
   * uncredited submission may only be `CC0-1.0` — CC BY promises attribution to a named author.
   */
  license?: ContribLicense;
  /** The proposed canonical-field values (a subset; what's allowed depends on new vs. improvement). */
  fields: PlaceFields;
  /** Free text from the contributor to the reviewer. */
  note?: string;
  status: "pending" | "approved" | "rejected";
  reviewedBy?: string;
  reviewedAt?: string;
  reviewReason?: string;
  /** The place the approval landed on (a new place's own `unique`, or the improved place's). */
  appliedPlace?: string;
  createdAt: string;
}

/** The review-queue filter — unset fields don't constrain (admin sees all; a contributor sees their own). */
export interface PlaceProposalFilter {
  status?: PlaceProposalRecord["status"];
  proposedBy?: string;
}

/** One place's atomic write in a {@link PlaceStore.commitPlaces} batch. */
export interface PlaceCommitEntry {
  place: PlaceRecord;
  /** Every batch record landing on this place — a chunk can put several source records on one. */
  sources: PlaceSourceRecord[];
  cells: string[];
  conflicts: PlaceConflictRecord[];
}

/** One volume→publisher pin, with its audit half: which admin confirmed it, and when. */
export interface AtlasPinRecord {
  volume: string;
  publisher: string;
  pinnedAt: string;
  pinnedBy: string;
}

/** One id's owning place — a {@link PlaceStore.placeUniquesForSourceIds} row. */
export interface SourceIdOwner {
  sourceId: string;
  placeUnique: string;
  /**
   * The winning record's source name. The snapshot runner batches its reads ahead of a slice of
   * elements, so it must replay the min-by-source contest against records the slice itself is about
   * to write — which it can only do knowing which source the stored winner was.
   */
  source: string;
}

/**
 * The stamp an admin decision writes. Deliberately not a general patch: a proposal's only legal
 * mutation is its review, and the store applies it **conditionally on `pending`** so two admins
 * reviewing the same row can't both win (the `failSnapshots` / `resolveConflicts` discipline).
 */
export interface PlaceProposalReview {
  status: "approved" | "rejected";
  reviewedBy: string;
  reviewedAt: string;
  reviewReason?: string;
  appliedPlace?: string;
}

/**
 * A query-result row: the summary **projection** of a place. The geometry blob (potentially tens
 * of KB per park) is never fetched or parsed on the list path — `hasGeometry` stands in for it;
 * the detail path (`getPlace`) returns the full record.
 */
export type PlaceQueryRecord = Omit<
  PlaceRecord,
  "geometry" | "description" | "descriptionCredit" | "website" | "wikipedia" | "altNames"
> & {
  hasGeometry: boolean;
  hasDescription: boolean;
};

export interface PlaceQueryResult {
  places: PlaceQueryRecord[];
  /** True when the result cap was hit — never silent truncation. */
  truncated: boolean;
}

export interface PlaceStore {
  /**
   * Atomically upsert a canonical place + one source record, replace the place's cell index, and
   * append any conflicts — the one write path for merge results (all-or-nothing).
   *
   * `createdAt` is **write-once**: an upsert over an existing row preserves the stored value
   * (callers always pass "now"; the Postgres store's ON CONFLICT clause simply omits the column).
   */
  commitPlace(
    place: PlaceRecord,
    source: PlaceSourceRecord,
    cells: string[],
    conflicts: PlaceConflictRecord[],
  ): Promise<void>;
  /**
   * The batched {@link commitPlace}: every entry lands in **one transaction**, and the Postgres
   * store writes multi-row statements rather than a statement per row. This is the snapshot runner's
   * write path — per-place commits are ~8 sequential round trips each, which turned a 225k-place
   * volume import into 90 minutes of network waits against a remote database. Total for any batch
   * size (the store bounds its own statement sizes internally). Entries must not repeat a
   * `place.unique` (the runner merges a batch's records per place first); `createdAt` stays
   * write-once exactly as in the single form.
   */
  commitPlaces(entries: readonly PlaceCommitEntry[]): Promise<void>;
  /** Re-write a canonical place + its cells without touching source records (post-retirement merge). */
  updatePlace(place: PlaceRecord, cells: string[]): Promise<void>;
  /** Soft-retire: `status = retired`, cells dropped from the index; the row (and refs) survive. */
  retirePlace(unique: string, at: string): Promise<void>;

  getPlace(unique: string): Promise<PlaceRecord | undefined>;
  getSource(source: string, sourceId: string): Promise<PlaceSourceRecord | undefined>;
  /** Batched {@link getSource} for one source: the records among `sourceIds` (absent ids yield no row). */
  getSources(source: string, sourceIds: readonly string[]): Promise<PlaceSourceRecord[]>;
  /**
   * Per id, the place any **live** source record with that `sourceId` belongs to, whatever source
   * wrote it (ids with no live record yield no row).
   *
   * The cross-source counterpart to {@link getSource}, and the query that stops a second source
   * describing a place the server already has from minting a new one. The runner resolves identity
   * as `getSource(source, sourceId)` — keyed by *both* — so without this, a server that snapshotted
   * `osm` and then imports an Atlas volume **duplicates every place**, and two volumes covering one
   * region duplicate every overlap (`apps/atlas/doc/spec/beacon-integration.md` §4).
   *
   * Live only: a `goneAt` record is a source that stopped carrying the place, and attaching a new source to
   * it would resurrect an identity the sweep deliberately let go.
   *
   * Each id's winner is ordered by `source` when several match, so two runs over the same data
   * agree — the id space is namespaced to make collisions unlikely
   * (`apps/atlas/doc/spec/place-identity.md` §6), not impossible, and a nondeterministic winner
   * would make an import's result depend on physical row order.
   */
  placeUniquesForSourceIds(sourceIds: readonly string[]): Promise<SourceIdOwner[]>;
  sourcesForPlace(placeUnique: string): Promise<PlaceSourceRecord[]>;
  /**
   * Batched {@link sourcesForPlace}: every record of every listed place, in no promised order —
   * and **slim** (`raw` omitted, the {@link liveSourcesBySource} discipline): its caller feeds
   * merge and conflict derivation, which never read the heavy payload, and this read runs once
   * per snapshot slice over up to ~500 places' siblings.
   */
  sourcesForPlaces(placeUniques: readonly string[]): Promise<PlaceSourceRecord[]>;
  /**
   * All live (`goneAt` unset) records of one source — the retirement sweep's working set. Slim:
   * `raw` is omitted (the sweep never needs the heavy payload; `getSource` returns it). With
   * `cellPrefixes`, only records whose place is indexed under a matching cell are returned — the
   * sweep scales with the snapshot's scope, not the whole dataset.
   */
  liveSourcesBySource(
    source: string,
    cellPrefixes?: readonly string[],
  ): Promise<PlaceSourceRecord[]>;
  /**
   * The identities alone of one source's live records — for the whole-source retire sweep
   * (`places.source.retire`), which is dataset-scale by design and reads nothing but the two ids.
   * {@link liveSourcesBySource} would ship and parse every record's `fields` just to drop them.
   */
  liveSourceKeysBySource(
    source: string,
  ): Promise<Array<Pick<PlaceSourceRecord, "sourceId" | "placeUnique">>>;
  setSourceGone(source: string, sourceId: string, at: string): Promise<void>;

  /**
   * Active places whose cell index matches any of `cellPrefixes` (prefix match, so a coarser query
   * cell finds finer index cells), optionally category-filtered, capped at `limit` with a
   * deterministic order (by `unique`). The primitive is total: a prefix outside the geohash charset,
   * or longer than a geohash can be, matches nothing in every twin ({@link validCellPrefixes} guards
   * the SQL `LIKE`).
   *
   * `after` is the **keyset pagination** cursor: when set, only places with `unique > after` are
   * returned. Because the order is `unique` and it's the primary key, walking pages by passing the
   * last row's `unique` back as `after` is stable and index-served (no OFFSET scan). `truncated`
   * still means "the page was full and more exist" — the caller turns it into the next cursor.
   *
   * `spread` trades that order for an even one across the area, for a map showing one capped page:
   * the query cells are cut into about `limit` sub-cells ({@link spreadLength}), and the page takes
   * one place from every sub-cell, then a second, and so on, each sub-cell's places and each round
   * in an order hashed from `unique`. Ordered by `unique` alone, a page is wherever the lowest ids
   * are, which after a bulk import is one corner (ids are minted in import order, cell by cell),
   * and the hash keeps that corner from returning inside a sub-cell or in a round the page cuts
   * short. A spread page has no keyset order, so it never pages:
   * `after` is ignored. It ranks every place in the area to choose the page, so it costs a scan of
   * the area's ids where a plain page stops at `limit`.
   */
  queryByCells(
    cellPrefixes: string[],
    categories: PlaceCategory[] | undefined,
    limit: number,
    after?: string,
    spread?: boolean,
  ): Promise<PlaceQueryResult>;

  /**
   * The distinct attribution lines of the given places' live sources — the read path derives
   * result-level dataset credit from the sources actually present (`doc/spec/places.md` §5).
   */
  attributionsForPlaces(placeUniques: readonly string[]): Promise<string[]>;

  createSnapshot(snapshot: PlaceSnapshotRecord): Promise<void>;
  updateSnapshot(
    id: string,
    patch: Partial<
      Pick<PlaceSnapshotRecord, "status" | "stats" | "error" | "startedAt" | "finishedAt">
    >,
  ): Promise<void>;
  getSnapshot(id: string): Promise<PlaceSnapshotRecord | undefined>;
  /** Most-recent-first (by id — ULIDs sort by creation time). */
  listSnapshots(limit: number): Promise<PlaceSnapshotRecord[]>;
  /**
   * Flip non-terminal (`queued`/`running`) runs to `failed` — **all** of them (`id` omitted: the
   * boot reconcile that closes out runs orphaned by a restart) or just one (`id` given: admin
   * cancel). Conditional on the current status, so it never clobbers a run that already reached a
   * terminal state — the write is idempotent and race-safe. Returns how many rows actually flipped.
   */
  failSnapshots(error: string, at: string, id?: string): Promise<number>;

  /**
   * The Atlas publisher pins — the durable half of trust-on-first-use. A volume's first import
   * records who signed it; every later import must match or the run is refused, so a swapped
   * publisher screams instead of sliding through. `pin` is idempotent for the same publisher and
   * refuses (returns false) for a different one — rotation is a deliberate `unpin`, never an
   * overwrite riding an import.
   */
  getAtlasPublisher(volume: string): Promise<string | undefined>;
  pinAtlasPublisher(volume: string, publisher: string, at: string, by: string): Promise<boolean>;
  /** Forget a pin; returns whether one existed. */
  unpinAtlasPublisher(volume: string): Promise<boolean>;
  /** Every pin, volume-ordered — the console's audit list ({@link AtlasPinRecord}). */
  listAtlasPublishers(): Promise<AtlasPinRecord[]>;

  /** Unresolved-first conflict listing (the review queue). */
  listConflicts(placeUnique: string | undefined, limit: number): Promise<PlaceConflictRecord[]>;
  /** Mark unresolved conflict rows reviewed; returns how many actually flipped (idempotent). */
  resolveConflicts(ids: readonly string[], at: string): Promise<number>;

  /** Persist a submitted contribution (`doc/spec/place-proposals.md` §3). Always lands `pending`. */
  createProposal(proposal: PlaceProposalRecord): Promise<void>;
  getProposal(id: string): Promise<PlaceProposalRecord | undefined>;
  /**
   * Newest-first proposals matching `filter`, capped at `limit`. `after` is the **keyset cursor** —
   * the last row's `id` from the previous page; because the order is `id DESC` over a ULID primary
   * key, walking pages that way is stable and index-served (the `listSnapshots` discipline).
   */
  listProposals(
    filter: PlaceProposalFilter,
    limit: number,
    after?: string,
  ): Promise<PlaceProposalRecord[]>;
  /** How many unreviewed proposals a DID currently has — the per-contributor pending cap. */
  countPendingByDid(did: string): Promise<number>;
  /**
   * Every **approved** contribution to this place whose author asked to be credited, sorted by DID
   * — the attribution behind `PlaceDetail.contributors`, and the licence envelope the contribution
   * export publishes under.
   *
   * One read serves both because of an invariant the wire enforces: **an uncredited submission can
   * only be CC0**, so an uncredited row can never raise the envelope above the credited rows. The
   * partial index this rides (`status = 'approved' AND credit = 1`) therefore already covers every
   * row that could affect the answer.
   *
   * Sorted rather than chronological because there is no ordering worth promising: a credit list is
   * a set of people, and DID order is the one every twin can produce identically without a second
   * column. **Not** distinct — one person may contribute twice under different licences, and
   * collapsing that here would lose the grant. Callers wanting the people dedupe by `did`.
   *
   * Keyed on `appliedPlace`, the column that answers this for both proposal shapes: an improvement
   * lands on the place it named, and an approved new-place proposal lands on a place whose unique is
   * the proposal's own id (`placeUnique` is null for those, so it would miss the people who put the
   * place there).
   */
  creditedContributionsFor(placeUnique: string): Promise<CreditedContribution[]>;
  /**
   * Every **approved** contribution to every listed place — credited or not — each row naming its
   * place and saying which it was.
   *
   * Wider than {@link creditedContributionsFor} on purpose, and the difference is the whole reason
   * this exists rather than a batched twin of it. The export has to answer *"was every contribution
   * that fed this place actually granted to us?"*, and a credited-only read cannot: an uncredited
   * submission is simply absent from it, so a place whose only contribution had no grant looks
   * identical to a place with no contributions at all — and would ship stamped CC0 on a grant
   * nobody made. Batched for the {@link sourcesForPlaces} reason: the export walks the whole
   * `contrib` population.
   */
  approvedContributionsForPlaces(placeUniques: readonly string[]): Promise<ApprovedContribution[]>;
  /**
   * Stamp a **pending** proposal with its review. Conditional on the current status, so a second
   * decision (a different admin, or a retry past the nonce window) can't clobber the first. Returns
   * how many rows actually flipped — 0 means it was already terminal.
   */
  updateProposal(id: string, review: PlaceProposalReview): Promise<number>;

  /** Active places: one `COUNT`, for the home page. */
  countActive(): Promise<number>;

  /** Operational counts for `admin.status` (`doc/spec/admin-api.md` §3) — aggregate `COUNT` reads, no row materialization. */
  stats(): Promise<PlaceStats>;
}

/** The dataset-size numbers `admin.status` reports (each a `COUNT(*)` in the Postgres store). */
export interface PlaceStats {
  /** Active places. */
  places: number;
  /** Soft-retired places (rows survive for provenance). */
  placesRetired: number;
  /** Unresolved conflicts — the curation to-do number. */
  conflictsPending: number;
  /** Recorded snapshot runs. */
  snapshots: number;
}

/**
 * Drop non-geohash prefixes so `queryByCells` is total and both implementations agree. Prefixes reach a
 * SQL `LIKE`, where anything else would match nothing.
 *
 * `isGeohash` rather than a local regex, so this asks the same question the wire does. It is
 * slightly stricter than the regex it replaced, which had no length cap: an over-long prefix is now
 * dropped rather than sent as a doomed `LIKE` parameter.
 */
export function validCellPrefixes(prefixes: readonly string[]): string[] {
  return prefixes.filter(isGeohash);
}

/**
 * The sub-cell length a `spread` page ranks places in: fine enough that the query cells hold at
 * least `limit` sub-cells between them, so a full page can take about one place from each.
 */
export function spreadLength(prefixes: readonly string[], limit: number): number {
  const finer = Math.ceil(Math.log(Math.max(limit / prefixes.length, 1)) / Math.log(32));
  return Math.min(...prefixes.map((p) => p.length)) + finer;
}

/** One credited approved contribution to a place — who, and under what grant. */
export interface CreditedContribution {
  did: string;
  /** Absent for a row written before the grant existed (0021) — it never exports. */
  license?: ContribLicense;
}

/** One approved contribution to a place, credited or not — the export's working set. */
export interface ApprovedContribution extends CreditedContribution {
  placeUnique: string;
  /** Whether its author asked to be named. Only a credited DID may travel. */
  credited: boolean;
}

/**
 * The people to name for a set of contributions — deduped and sorted.
 *
 * One spelling, because there are two callers with the same question and the underlying read is
 * deliberately **not** `DISTINCT` (the export needs every grant, and one person may contribute
 * twice). Two open-coded `[...new Set(...)]`s had already drifted by a `.sort()`.
 */
export function contributorDids(contributions: readonly CreditedContribution[]): string[] {
  return [...new Set(contributions.map((c) => c.did))].sort();
}
