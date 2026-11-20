import type {
  ContribLicense,
  Media,
  MediaCredit,
  PlaceCategory,
  PlaceGeometry,
  PlaceSnapshotParams,
  PlaceSnapshotStats,
} from "@beaconsgg/protocol-types";
import { columnsOf } from "./pg-columns";
import type { Pool, PoolClient } from "pg";
import {
  type AtlasPinRecord,
  type ApprovedContribution,
  type CreditedContribution,
  type PlaceCommitEntry,
  type PlaceConflictRecord,
  type PlaceFields,
  type PlaceProposalFilter,
  type PlaceProposalRecord,
  type PlaceProposalReview,
  type PlaceQueryRecord,
  type PlaceQueryResult,
  type PlaceRecord,
  type PlaceSnapshotRecord,
  type PlaceSourceRecord,
  type PlaceStats,
  type PlaceStore,
  type SourceIdOwner,
  spreadLength,
  validCellPrefixes,
} from "./place-store";

// ── column lists + row shapes + converters ──
// The column lists, the Row shapes, and the bind/`rowTo*` converters live together so a schema
// change is a one-file edit.

const PLACE_COLUMNS =
  "unique_id, category, subcategory, name, description, description_credit, website, wikipedia, alt_names, lat, lng, geometry, media, status, created_at, updated_at";

/**
 * {@link PLACE_COLUMNS} with the geometry blob + the long `description` text each projected to a boolean
 * and the detail-only descriptor fields (description + its credit/website/wikipedia/alt_names) dropped — the light
 * list-read shape. `has_description` lets the list rank a place's richness without shipping the text.
 */
const PLACE_SUMMARY_COLUMNS =
  "unique_id, category, subcategory, name, lat, lng, (geometry IS NOT NULL) AS has_geometry, (description IS NOT NULL) AS has_description, media, status, created_at, updated_at";

const SOURCE_COLUMNS =
  "source, source_id, place_unique, fields, raw, attribution, edited_by, edited_at, synced_at, gone_at";

/** {@link SOURCE_COLUMNS} with `raw` nulled — list reads (the sweep) skip the heavy payload. */
const SOURCE_COLUMNS_SLIM =
  "source, source_id, place_unique, fields, NULL AS raw, attribution, edited_by, edited_at, synced_at, gone_at";

// The ON CONFLICT SET tails of the multi-row upserts below; `created_at` is deliberately absent
// from the place tail (write-once; see the interface).
const PLACE_UPSERT_SET =
  "category = excluded.category, subcategory = excluded.subcategory, name = excluded.name, " +
  "description = excluded.description, description_credit = excluded.description_credit, " +
  "website = excluded.website, wikipedia = excluded.wikipedia, alt_names = excluded.alt_names, " +
  "lat = excluded.lat, lng = excluded.lng, geometry = excluded.geometry, media = excluded.media, " +
  "status = excluded.status, updated_at = excluded.updated_at";

const SOURCE_UPSERT_SET =
  "place_unique = excluded.place_unique, fields = excluded.fields, raw = excluded.raw, " +
  "attribution = excluded.attribution, edited_by = excluded.edited_by, " +
  "edited_at = excluded.edited_at, synced_at = excluded.synced_at, gone_at = excluded.gone_at";

const SNAPSHOT_COLUMNS =
  "id, source, params, requested_by, status, stats, error, created_at, started_at, finished_at";

const CONFLICT_COLUMNS =
  "id, place_unique, field, current_value, incoming_value, source, snapshot_id, created_at, resolved_at";

const PROPOSAL_COLUMNS =
  "id, place_unique, proposed_by, credit, license, fields, note, status, reviewed_by, reviewed_at, review_reason, applied_place, created_at";

interface PlaceRow {
  unique_id: string;
  category: string;
  subcategory: string | null;
  name: string | null;
  description: string | null;
  description_credit: string | null;
  website: string | null;
  wikipedia: string | null;
  alt_names: string | null;
  lat: number;
  lng: number;
  geometry: string | null;
  media: string | null;
  status: string;
  created_at: string;
  updated_at: string;
}

interface PlaceSourceRow {
  source: string;
  source_id: string;
  place_unique: string;
  fields: string;
  raw: string | null;
  attribution: string | null;
  edited_by: string | null;
  edited_at: string | null;
  synced_at: string;
  gone_at: string | null;
}

interface PlaceSnapshotRow {
  id: string;
  source: string;
  params: string;
  requested_by: string;
  status: string;
  stats: string | null;
  error: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

interface PlaceConflictRow {
  id: string;
  place_unique: string;
  field: string;
  current_value: string | null;
  incoming_value: string;
  source: string;
  snapshot_id: string | null;
  created_at: string;
  resolved_at: string | null;
}

interface PlaceProposalRow {
  id: string;
  place_unique: string | null;
  proposed_by: string;
  /** A stored `INTEGER` 0/1, so the driver returns a number. */
  credit: number;
  license: string | null;
  fields: string;
  note: string | null;
  status: string;
  reviewed_by: string | null;
  reviewed_at: string | null;
  review_reason: string | null;
  applied_place: string | null;
  created_at: string;
}

interface PlaceSummaryRow extends Omit<
  PlaceRow,
  "geometry" | "description" | "website" | "wikipedia" | "alt_names"
> {
  has_geometry: boolean; // computed `IS NOT NULL`, which pg returns as a real boolean
  has_description: boolean;
}

function rowToQueryRecord(row: PlaceSummaryRow): PlaceQueryRecord {
  return {
    unique: row.unique_id,
    category: row.category as PlaceCategory,
    ...(row.subcategory !== null ? { subcategory: row.subcategory } : {}),
    ...(row.name !== null ? { name: row.name } : {}),
    point: { lat: row.lat, lng: row.lng },
    hasGeometry: row.has_geometry,
    hasDescription: row.has_description,
    ...(row.media !== null ? { media: JSON.parse(row.media) as Media[] } : {}),
    status: row.status as PlaceRecord["status"],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToPlace(row: PlaceRow): PlaceRecord {
  return {
    unique: row.unique_id,
    category: row.category as PlaceCategory,
    ...(row.subcategory !== null ? { subcategory: row.subcategory } : {}),
    ...(row.name !== null ? { name: row.name } : {}),
    ...(row.description !== null ? { description: row.description } : {}),
    ...(row.description_credit !== null
      ? { descriptionCredit: JSON.parse(row.description_credit) as MediaCredit }
      : {}),
    ...(row.website !== null ? { website: row.website } : {}),
    ...(row.wikipedia !== null ? { wikipedia: row.wikipedia } : {}),
    ...(row.alt_names !== null ? { altNames: JSON.parse(row.alt_names) as string[] } : {}),
    point: { lat: row.lat, lng: row.lng },
    ...(row.geometry !== null ? { geometry: JSON.parse(row.geometry) as PlaceGeometry } : {}),
    ...(row.media !== null ? { media: JSON.parse(row.media) as Media[] } : {}),
    status: row.status as PlaceRecord["status"],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToSource(row: PlaceSourceRow): PlaceSourceRecord {
  return {
    source: row.source,
    sourceId: row.source_id,
    placeUnique: row.place_unique,
    fields: JSON.parse(row.fields) as PlaceFields,
    ...(row.raw !== null ? { raw: JSON.parse(row.raw) as unknown } : {}),
    ...(row.attribution !== null ? { attribution: row.attribution } : {}),
    ...(row.edited_by !== null ? { editedBy: row.edited_by } : {}),
    ...(row.edited_at !== null ? { editedAt: row.edited_at } : {}),
    syncedAt: row.synced_at,
    ...(row.gone_at !== null ? { goneAt: row.gone_at } : {}),
  };
}

function rowToSnapshot(row: PlaceSnapshotRow): PlaceSnapshotRecord {
  return {
    id: row.id,
    source: row.source,
    params: JSON.parse(row.params) as PlaceSnapshotParams,
    requestedBy: row.requested_by,
    status: row.status as PlaceSnapshotRecord["status"],
    ...(row.stats !== null ? { stats: JSON.parse(row.stats) as PlaceSnapshotStats } : {}),
    ...(row.error !== null ? { error: row.error } : {}),
    createdAt: row.created_at,
    ...(row.started_at !== null ? { startedAt: row.started_at } : {}),
    ...(row.finished_at !== null ? { finishedAt: row.finished_at } : {}),
  };
}

const ATLAS_PIN_COLUMNS = "volume, publisher, pinned_at, pinned_by";

interface AtlasPinRow {
  volume: string;
  publisher: string;
  pinned_at: string;
  pinned_by: string;
}

function rowToAtlasPin(row: AtlasPinRow): AtlasPinRecord {
  return {
    volume: row.volume,
    publisher: row.publisher,
    pinnedAt: row.pinned_at,
    pinnedBy: row.pinned_by,
  };
}

function rowToConflict(row: PlaceConflictRow): PlaceConflictRecord {
  return {
    id: row.id,
    placeUnique: row.place_unique,
    field: row.field,
    ...(row.current_value !== null
      ? { currentValue: JSON.parse(row.current_value) as unknown }
      : {}),
    incomingValue: JSON.parse(row.incoming_value) as unknown,
    source: row.source,
    ...(row.snapshot_id !== null ? { snapshotId: row.snapshot_id } : {}),
    createdAt: row.created_at,
    ...(row.resolved_at !== null ? { resolvedAt: row.resolved_at } : {}),
  };
}

/** One credited-contribution row → the record shape. */
function rowToCreditedContribution(row: {
  proposed_by: string;
  license: string | null;
}): CreditedContribution {
  return {
    did: row.proposed_by,
    ...(row.license !== null ? { license: row.license as ContribLicense } : {}),
  };
}

/** An approved-contribution row → the record shape. */
function rowToApprovedContribution(row: {
  proposed_by: string;
  license: string | null;
  credit: number;
  applied_place: string;
}): ApprovedContribution {
  return {
    ...rowToCreditedContribution(row),
    placeUnique: row.applied_place,
    credited: Boolean(row.credit),
  };
}

function rowToProposal(row: PlaceProposalRow): PlaceProposalRecord {
  return {
    id: row.id,
    ...(row.place_unique !== null ? { placeUnique: row.place_unique } : {}),
    proposedBy: row.proposed_by,
    credit: Boolean(row.credit),
    ...(row.license !== null ? { license: row.license as ContribLicense } : {}),
    fields: JSON.parse(row.fields) as PlaceFields,
    ...(row.note !== null ? { note: row.note } : {}),
    status: row.status as PlaceProposalRecord["status"],
    ...(row.reviewed_by !== null ? { reviewedBy: row.reviewed_by } : {}),
    ...(row.reviewed_at !== null ? { reviewedAt: row.reviewed_at } : {}),
    ...(row.review_reason !== null ? { reviewReason: row.review_reason } : {}),
    ...(row.applied_place !== null ? { appliedPlace: row.applied_place } : {}),
    createdAt: row.created_at,
  };
}

/** JSON-or-null bind helper (absent optional → SQL NULL). */
function jsonOrNull(value: unknown): string | null {
  return value === undefined ? null : JSON.stringify(value);
}

// The bind converters — the inverse of `rowTo*`, in the same column order as the lists above, so
// every statement shares one `?? null` / JSON-encode decision instead of duplicating it.

function placeToBind(place: PlaceRecord): unknown[] {
  return [
    place.unique,
    place.category,
    place.subcategory ?? null,
    place.name ?? null,
    place.description ?? null,
    jsonOrNull(place.descriptionCredit),
    place.website ?? null,
    place.wikipedia ?? null,
    jsonOrNull(place.altNames),
    place.point.lat,
    place.point.lng,
    jsonOrNull(place.geometry),
    jsonOrNull(place.media),
    place.status,
    place.createdAt,
    place.updatedAt,
  ];
}

function sourceToBind(source: PlaceSourceRecord): unknown[] {
  return [
    source.source,
    source.sourceId,
    source.placeUnique,
    JSON.stringify(source.fields),
    jsonOrNull(source.raw),
    source.attribution ?? null,
    source.editedBy ?? null,
    source.editedAt ?? null,
    source.syncedAt,
    source.goneAt ?? null,
  ];
}

function snapshotToBind(snapshot: PlaceSnapshotRecord): unknown[] {
  return [
    snapshot.id,
    snapshot.source,
    JSON.stringify(snapshot.params),
    snapshot.requestedBy,
    snapshot.status,
    jsonOrNull(snapshot.stats),
    snapshot.error ?? null,
    snapshot.createdAt,
    snapshot.startedAt ?? null,
    snapshot.finishedAt ?? null,
  ];
}

function conflictToBind(conflict: PlaceConflictRecord): unknown[] {
  return [
    conflict.id,
    conflict.placeUnique,
    conflict.field,
    jsonOrNull(conflict.currentValue),
    JSON.stringify(conflict.incomingValue),
    conflict.source,
    conflict.snapshotId ?? null,
    conflict.createdAt,
    conflict.resolvedAt ?? null,
  ];
}

function proposalToBind(proposal: PlaceProposalRecord): unknown[] {
  return [
    proposal.id,
    proposal.placeUnique ?? null,
    proposal.proposedBy,
    proposal.credit ? 1 : 0,
    proposal.license ?? null,
    JSON.stringify(proposal.fields),
    proposal.note ?? null,
    proposal.status,
    proposal.reviewedBy ?? null,
    proposal.reviewedAt ?? null,
    proposal.reviewReason ?? null,
    proposal.appliedPlace ?? null,
    proposal.createdAt,
  ];
}

/**
 * The proposal filter → `[column, bindValue]` pairs, in a fixed order, so the WHERE clause is
 * rendered from one list.
 */
function proposalFilterEntries(filter: PlaceProposalFilter): [string, unknown][] {
  const entries: [string, unknown][] = [];
  if (filter.status !== undefined) entries.push(["status", filter.status]);
  if (filter.proposedBy !== undefined) entries.push(["proposed_by", filter.proposedBy]);
  return entries;
}

/** The snapshot patch → `[column, bindValue]` pairs (shared SET builder). */
function snapshotPatchEntries(
  patch: Partial<
    Pick<PlaceSnapshotRecord, "status" | "stats" | "error" | "startedAt" | "finishedAt">
  >,
): [string, unknown][] {
  const entries: [string, unknown][] = [];
  if (patch.status !== undefined) entries.push(["status", patch.status]);
  if (patch.stats !== undefined) entries.push(["stats", JSON.stringify(patch.stats)]);
  if (patch.error !== undefined) entries.push(["error", patch.error]);
  if (patch.startedAt !== undefined) entries.push(["started_at", patch.startedAt]);
  if (patch.finishedAt !== undefined) entries.push(["finished_at", patch.finishedAt]);
  return entries;
}

// The multi-row write statements: one array parameter per column, zipped row-wise by `unnest`
// (multi-argument unnest yields columns in argument order — the same trick the old single-row
// path already used for cells). The arrays are column-major transposes of the shared bind
// converters' rows (`placeToBind` / `sourceToBind` / `conflictToBind`), so the single and batched
// forms can't drift on a column — and the already-JSON-encoded payload columns (fields, raw,
// geometry, media) ride as plain text elements: no second serialization, no server-side jsonb
// parse of a megabyte parameter, and lat/lng stay numeric end to end.
const PLACE_UPSERT_MANY =
  `INSERT INTO places (${PLACE_COLUMNS}) SELECT * FROM unnest(` +
  "$1::text[], $2::text[], $3::text[], $4::text[], $5::text[], $6::text[], $7::text[], " +
  "$8::text[], $9::text[], $10::float8[], $11::float8[], $12::text[], $13::text[], " +
  "$14::text[], $15::text[], $16::text[]) " +
  `ON CONFLICT (unique_id) DO UPDATE SET ${PLACE_UPSERT_SET}`;
const SOURCE_UPSERT_MANY =
  `INSERT INTO place_sources (${SOURCE_COLUMNS}) SELECT * FROM unnest(` +
  "$1::text[], $2::text[], $3::text[], $4::text[], $5::text[], $6::text[], $7::text[], " +
  "$8::text[], $9::text[], $10::text[]) " +
  `ON CONFLICT (source, source_id) DO UPDATE SET ${SOURCE_UPSERT_SET}`;
const CONFLICT_INSERT_MANY =
  `INSERT INTO place_conflicts (${CONFLICT_COLUMNS}) SELECT * FROM unnest(` +
  "$1::text[], $2::text[], $3::text[], $4::text[], $5::text[], $6::text[], $7::text[], " +
  "$8::text[], $9::text[])";
const CELLS_INSERT_MANY =
  "INSERT INTO place_cells (cell, place_unique) " +
  "SELECT * FROM unnest($1::text[], $2::text[]) ON CONFLICT DO NOTHING";

/**
 * Rows per multi-row statement — bounds ONE statement's parameter size (a run of park polygons
 * carries megabytes of geometry) while `commitPlaces` stays total for any batch: more rows just
 * repeat the statements inside the same transaction.
 */
const ROWS_PER_STATEMENT = 500;

/**
 * Postgres {@link PlaceStore} — the production twin (`doc/spec/places.md` §3), over the
 * `0007_places_v2` tables. `commitPlaces` runs BEGIN…COMMIT on one client so every canonical row,
 * source record, cell index, and conflict in the batch is all-or-nothing, and each table is one
 * multi-row jsonb statement — the write cost of a batch is a handful of round trips, not a function
 * of its row count. All bulk statements are **named** (per-connection parse cache).
 */
export class PgPlaceStore implements PlaceStore {
  constructor(private readonly pool: Pool) {}

  /** Run `fn` inside one BEGIN…COMMIT (ROLLBACK on any throw). */
  private async inTransaction(fn: (client: PoolClient) => Promise<void>): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await fn(client);
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  commitPlace(
    place: PlaceRecord,
    source: PlaceSourceRecord,
    cells: string[],
    conflicts: PlaceConflictRecord[],
  ): Promise<void> {
    return this.commitPlaces([{ place, sources: [source], cells, conflicts }]);
  }

  async commitPlaces(entries: readonly PlaceCommitEntry[]): Promise<void> {
    if (entries.length === 0) return;
    await this.inTransaction(async (client) => {
      // One transaction whatever the batch size; {@link ROWS_PER_STATEMENT} only bounds parameters.
      // Entries never repeat a `place.unique` (the contract), so the statement slices are disjoint.
      for (let i = 0; i < entries.length; i += ROWS_PER_STATEMENT) {
        const slice = entries.slice(i, i + ROWS_PER_STATEMENT);
        await client.query(
          { name: "place-upsert-many", text: PLACE_UPSERT_MANY },
          columnsOf(
            slice.map((e) => placeToBind(e.place)),
            16,
          ),
        );
        await client.query(
          {
            name: "place-cells-delete-many",
            text: "DELETE FROM place_cells WHERE place_unique = ANY($1::text[])",
          },
          [slice.map((e) => e.place.unique)],
        );
        const cells = slice.flatMap((e) => e.cells.map((c) => [c, e.place.unique]));
        if (cells.length > 0) {
          await client.query(
            { name: "place-cells-insert-many", text: CELLS_INSERT_MANY },
            columnsOf(cells, 2),
          );
        }
        const sources = slice.flatMap((e) => e.sources.map(sourceToBind));
        if (sources.length > 0) {
          await client.query(
            { name: "place-source-upsert-many", text: SOURCE_UPSERT_MANY },
            columnsOf(sources, 10),
          );
        }
        const conflicts = slice.flatMap((e) => e.conflicts.map(conflictToBind));
        if (conflicts.length > 0) {
          await client.query(
            { name: "place-conflict-insert-many", text: CONFLICT_INSERT_MANY },
            columnsOf(conflicts, 9),
          );
        }
      }
    });
  }

  updatePlace(place: PlaceRecord, cells: string[]): Promise<void> {
    // The batched commit with nothing but the canonical row — `sources: []` skips that statement.
    return this.commitPlaces([{ place, sources: [], cells, conflicts: [] }]);
  }

  async retirePlace(unique: string, at: string): Promise<void> {
    await this.inTransaction(async (client) => {
      await client.query(
        "UPDATE places SET status = 'retired', updated_at = $1 WHERE unique_id = $2",
        [at, unique],
      );
      await client.query("DELETE FROM place_cells WHERE place_unique = $1", [unique]);
    });
  }

  async getPlace(unique: string): Promise<PlaceRecord | undefined> {
    const res = await this.pool.query<PlaceRow>(
      { name: "place-get", text: `SELECT ${PLACE_COLUMNS} FROM places WHERE unique_id = $1` },
      [unique],
    );
    const row = res.rows[0];
    return row ? rowToPlace(row) : undefined;
  }

  async getSource(source: string, sourceId: string): Promise<PlaceSourceRecord | undefined> {
    return (await this.getSources(source, [sourceId]))[0];
  }

  async getSources(source: string, sourceIds: readonly string[]): Promise<PlaceSourceRecord[]> {
    if (sourceIds.length === 0) return [];
    const res = await this.pool.query<PlaceSourceRow>(
      {
        name: "place-sources-get-many",
        text: `SELECT ${SOURCE_COLUMNS} FROM place_sources WHERE source = $1 AND source_id = ANY($2::text[])`,
      },
      [source, sourceIds],
    );
    return res.rows.map(rowToSource);
  }

  /**
   * Each id's owning place — see the interface for why this exists. Live only; `DISTINCT ON`
   * keeps exactly the `ORDER BY source` winner per id (`source_id` pins the rest of the primary
   * key, so the order is already total).
   */
  async placeUniquesForSourceIds(sourceIds: readonly string[]): Promise<SourceIdOwner[]> {
    if (sourceIds.length === 0) return [];
    const res = await this.pool.query<{ source_id: string; place_unique: string; source: string }>(
      {
        name: "place-source-owners-by-source-ids",
        text:
          "SELECT DISTINCT ON (source_id) source_id, place_unique, source FROM place_sources " +
          "WHERE source_id = ANY($1::text[]) AND gone_at IS NULL ORDER BY source_id, source",
      },
      [sourceIds],
    );
    return res.rows.map((r) => ({
      sourceId: r.source_id,
      placeUnique: r.place_unique,
      source: r.source,
    }));
  }

  async sourcesForPlace(placeUnique: string): Promise<PlaceSourceRecord[]> {
    const res = await this.pool.query<PlaceSourceRow>(
      {
        name: "place-sources-for-place",
        text: `SELECT ${SOURCE_COLUMNS} FROM place_sources WHERE place_unique = $1`,
      },
      [placeUnique],
    );
    return res.rows.map(rowToSource);
  }

  async sourcesForPlaces(placeUniques: readonly string[]): Promise<PlaceSourceRecord[]> {
    if (placeUniques.length === 0) return [];
    const res = await this.pool.query<PlaceSourceRow>(
      {
        name: "place-sources-for-places",
        // Slim per the interface: this read feeds merge/conflicts, never the raw payload.
        text: `SELECT ${SOURCE_COLUMNS_SLIM} FROM place_sources WHERE place_unique = ANY($1::text[])`,
      },
      [placeUniques],
    );
    return res.rows.map(rowToSource);
  }

  async liveSourceKeysBySource(
    source: string,
  ): Promise<Array<Pick<PlaceSourceRecord, "sourceId" | "placeUnique">>> {
    const res = await this.pool.query<{ source_id: string; place_unique: string }>(
      {
        name: "place-source-keys-live",
        // Keys only — the whole-source retire sweep reads nothing else, and it is dataset-scale.
        text: `SELECT source_id, place_unique FROM place_sources WHERE source = $1 AND gone_at IS NULL`,
      },
      [source],
    );
    return res.rows.map((r) => ({ sourceId: r.source_id, placeUnique: r.place_unique }));
  }

  async liveSourcesBySource(
    source: string,
    cellPrefixes?: readonly string[],
  ): Promise<PlaceSourceRecord[]> {
    if (cellPrefixes === undefined) {
      const res = await this.pool.query<PlaceSourceRow>(
        {
          name: "place-sources-live",
          // Slim list — the sweep never needs the raw payload column.
          text: `SELECT ${SOURCE_COLUMNS_SLIM} FROM place_sources WHERE source = $1 AND gone_at IS NULL`,
        },
        [source],
      );
      return res.rows.map(rowToSource);
    }
    // Scoped sweep: only records whose place is indexed under a matching cell (prefix match via
    // the place_cells index — the sweep scales with the snapshot, not the dataset).
    const prefixes = validCellPrefixes(cellPrefixes);
    if (prefixes.length === 0) return [];
    const params: unknown[] = [source];
    const cellClause = prefixes
      .map((p) => {
        params.push(`${p}%`);
        return `cell LIKE $${params.length}`;
      })
      .join(" OR ");
    const res = await this.pool.query<PlaceSourceRow>(
      `SELECT ${SOURCE_COLUMNS_SLIM} FROM place_sources WHERE source = $1 AND gone_at IS NULL ` +
        `AND place_unique IN (SELECT place_unique FROM place_cells WHERE ${cellClause})`,
      params,
    );
    return res.rows.map(rowToSource);
  }

  async setSourceGone(source: string, sourceId: string, at: string): Promise<void> {
    await this.pool.query(
      {
        name: "place-source-gone",
        text: "UPDATE place_sources SET gone_at = $1 WHERE source = $2 AND source_id = $3",
      },
      [at, source, sourceId],
    );
  }

  async attributionsForPlaces(placeUniques: readonly string[]): Promise<string[]> {
    if (placeUniques.length === 0) return [];
    // One stable, nameable statement shape: the id list rides as a single array param.
    const res = await this.pool.query<{ attribution: string }>(
      {
        name: "place-attributions",
        text:
          "SELECT DISTINCT attribution FROM place_sources WHERE attribution IS NOT NULL " +
          "AND gone_at IS NULL AND place_unique = ANY($1::text[]) ORDER BY attribution",
      },
      [[...placeUniques]],
    );
    return res.rows.map((r) => r.attribution);
  }

  async queryByCells(
    cellPrefixes: string[],
    categories: PlaceCategory[] | undefined,
    limit: number,
    after?: string,
    spread?: boolean,
  ): Promise<PlaceQueryResult> {
    const prefixes = validCellPrefixes(cellPrefixes);
    const cats = categories && categories.length > 0 ? categories : undefined;
    if (prefixes.length === 0) return { places: [], truncated: false };

    const params: unknown[] = [];
    let categoryClause = "";
    if (cats) {
      const placeholders = cats.map((cat) => {
        params.push(cat);
        return `$${params.length}`;
      });
      categoryClause = ` AND category IN (${placeholders.join(", ")})`;
    }
    // Bind full patterns (indexable via the text_pattern_ops index regardless of DB collation).
    const cellClause = prefixes
      .map((p) => {
        params.push(`${p}%`);
        return `cell LIKE $${params.length}`;
      })
      .join(" OR ");
    const filters = `status = 'active'${categoryClause}`;
    if (spread) {
      // Rank each place within its sub-cell, then take rank 1 of every sub-cell, rank 2, and so on,
      // in md5(unique) order, which ids minted cell by cell do not follow. The ranking carries ids
      // and cells only; the summaries are read for the page alone. A place indexed under several
      // cells (a polygon) ranks once, in its first.
      params.push(spreadLength(prefixes, limit), limit + 1);
      const res = await this.pool.query<PlaceSummaryRow>(
        `WITH hits AS (SELECT pc.place_unique, left(min(pc.cell), $${params.length - 1}) AS sub, ` +
          `md5(pc.place_unique) COLLATE "C" AS mix FROM place_cells pc ` +
          `JOIN places p ON p.unique_id = pc.place_unique WHERE (${cellClause}) AND ${filters} ` +
          `GROUP BY pc.place_unique), ` +
          `page AS (SELECT place_unique, mix, ROW_NUMBER() OVER ` +
          `(PARTITION BY sub ORDER BY mix) AS spread_rank FROM hits ` +
          `ORDER BY spread_rank, mix LIMIT $${params.length}) ` +
          `SELECT ${PLACE_SUMMARY_COLUMNS} FROM places JOIN page ON unique_id = page.place_unique ` +
          `ORDER BY page.spread_rank, page.mix`,
        params,
      );
      return {
        places: res.rows.slice(0, limit).map(rowToQueryRecord),
        truncated: res.rows.length > limit,
      };
    }
    // Keyset cursor: only rows past the last page (ORDER BY unique_id makes this the PK walk).
    let afterClause = "";
    if (after !== undefined) {
      params.push(after);
      afterClause = ` AND unique_id > $${params.length}`;
    }
    params.push(limit + 1); // one extra row detects truncation
    // Semijoin (not DISTINCT over the JSON blobs): dedupe on the key, probe places once each.
    const res = await this.pool.query<PlaceSummaryRow>(
      `SELECT ${PLACE_SUMMARY_COLUMNS} FROM places WHERE ${filters} ` +
        `AND unique_id IN (SELECT place_unique FROM place_cells WHERE ${cellClause})${afterClause} ` +
        `ORDER BY unique_id LIMIT $${params.length}`,
      params,
    );
    const truncated = res.rows.length > limit;
    return { places: res.rows.slice(0, limit).map(rowToQueryRecord), truncated };
  }

  async createSnapshot(snapshot: PlaceSnapshotRecord): Promise<void> {
    await this.pool.query(
      {
        name: "place-snapshot-insert",
        text: `INSERT INTO place_snapshots (${SNAPSHOT_COLUMNS}) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      },
      snapshotToBind(snapshot),
    );
  }

  async updateSnapshot(
    id: string,
    patch: Partial<
      Pick<PlaceSnapshotRecord, "status" | "stats" | "error" | "startedAt" | "finishedAt">
    >,
  ): Promise<void> {
    const entries = snapshotPatchEntries(patch);
    if (entries.length === 0) return;
    const sets = entries.map(([column], i) => `${column} = $${i + 1}`).join(", ");
    await this.pool.query(`UPDATE place_snapshots SET ${sets} WHERE id = $${entries.length + 1}`, [
      ...entries.map(([, value]) => value),
      id,
    ]);
  }

  async getSnapshot(id: string): Promise<PlaceSnapshotRecord | undefined> {
    const res = await this.pool.query<PlaceSnapshotRow>(
      {
        name: "place-snapshot-get",
        text: `SELECT ${SNAPSHOT_COLUMNS} FROM place_snapshots WHERE id = $1`,
      },
      [id],
    );
    const row = res.rows[0];
    return row ? rowToSnapshot(row) : undefined;
  }

  async listSnapshots(limit: number): Promise<PlaceSnapshotRecord[]> {
    const res = await this.pool.query<PlaceSnapshotRow>(
      {
        name: "place-snapshots-list",
        text: `SELECT ${SNAPSHOT_COLUMNS} FROM place_snapshots ORDER BY id DESC LIMIT $1`,
      },
      [limit],
    );
    return res.rows.map(rowToSnapshot);
  }

  async failSnapshots(error: string, at: string, id?: string): Promise<number> {
    const base =
      "UPDATE place_snapshots SET status = 'failed', error = $1, finished_at = $2 " +
      "WHERE status IN ('queued', 'running')";
    // Named only for the bulk (boot) shape — the id-scoped variant is a rare admin cancel.
    const res =
      id === undefined
        ? await this.pool.query({ name: "place-snapshots-fail-all", text: base }, [error, at])
        : await this.pool.query(`${base} AND id = $3`, [error, at, id]);
    return res.rowCount ?? 0;
  }

  async getAtlasPublisher(volume: string): Promise<string | undefined> {
    const res = await this.pool.query("SELECT publisher FROM atlas_publishers WHERE volume = $1", [
      volume,
    ]);
    return (res.rows[0] as { publisher: string } | undefined)?.publisher;
  }

  async pinAtlasPublisher(
    volume: string,
    publisher: string,
    at: string,
    by: string,
  ): Promise<boolean> {
    // Insert-or-match in one statement: the conditional DO UPDATE only fires when the publisher is
    // the same (idempotent re-pin); a different publisher inserts nothing and returns no row.
    const res = await this.pool.query(
      "INSERT INTO atlas_publishers (volume, publisher, pinned_at, pinned_by) " +
        "VALUES ($1, $2, $3, $4) " +
        "ON CONFLICT (volume) DO UPDATE SET publisher = excluded.publisher " +
        "WHERE atlas_publishers.publisher = excluded.publisher " +
        "RETURNING volume",
      [volume, publisher, at, by],
    );
    return (res.rowCount ?? 0) > 0;
  }

  async unpinAtlasPublisher(volume: string): Promise<boolean> {
    const res = await this.pool.query("DELETE FROM atlas_publishers WHERE volume = $1", [volume]);
    return (res.rowCount ?? 0) > 0;
  }

  async listAtlasPublishers(): Promise<AtlasPinRecord[]> {
    const res = await this.pool.query<AtlasPinRow>(
      `SELECT ${ATLAS_PIN_COLUMNS} FROM atlas_publishers ORDER BY volume`,
    );
    return res.rows.map(rowToAtlasPin);
  }

  async listConflicts(
    placeUnique: string | undefined,
    limit: number,
  ): Promise<PlaceConflictRecord[]> {
    const where = placeUnique !== undefined ? "WHERE place_unique = $2" : "";
    const params: unknown[] = placeUnique !== undefined ? [limit, placeUnique] : [limit];
    const res = await this.pool.query<PlaceConflictRow>(
      `SELECT ${CONFLICT_COLUMNS} FROM place_conflicts ${where} ` +
        "ORDER BY (resolved_at IS NOT NULL), id DESC LIMIT $1",
      params,
    );
    return res.rows.map(rowToConflict);
  }

  async resolveConflicts(ids: readonly string[], at: string): Promise<number> {
    if (ids.length === 0) return 0;
    const res = await this.pool.query(
      {
        name: "place-conflicts-resolve",
        text: "UPDATE place_conflicts SET resolved_at = $1 WHERE resolved_at IS NULL AND id = ANY($2::text[])",
      },
      [at, [...ids]],
    );
    return res.rowCount ?? 0;
  }

  async createProposal(proposal: PlaceProposalRecord): Promise<void> {
    await this.pool.query(
      {
        name: "place-proposal-insert",
        text: `INSERT INTO place_proposals (${PROPOSAL_COLUMNS}) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
      },
      proposalToBind(proposal),
    );
  }

  async getProposal(id: string): Promise<PlaceProposalRecord | undefined> {
    const res = await this.pool.query<PlaceProposalRow>(
      {
        name: "place-proposal-get",
        text: `SELECT ${PROPOSAL_COLUMNS} FROM place_proposals WHERE id = $1`,
      },
      [id],
    );
    const row = res.rows[0];
    return row ? rowToProposal(row) : undefined;
  }

  async listProposals(
    filter: PlaceProposalFilter,
    limit: number,
    after?: string,
  ): Promise<PlaceProposalRecord[]> {
    // Unnamed: the WHERE clause varies with the filter, and a named statement pins one text per name.
    const entries = proposalFilterEntries(filter);
    const params: unknown[] = [limit];
    const clauses = entries.map(([column, value]) => {
      params.push(value);
      return `${column} = $${params.length}`;
    });
    if (after !== undefined) {
      params.push(after);
      clauses.push(`id < $${params.length}`); // keyset: the order is id DESC
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")} ` : "";
    const res = await this.pool.query<PlaceProposalRow>(
      `SELECT ${PROPOSAL_COLUMNS} FROM place_proposals ${where}ORDER BY id DESC LIMIT $1`,
      params,
    );
    return res.rows.map(rowToProposal);
  }

  async countPendingByDid(did: string): Promise<number> {
    const res = await this.pool.query<{ n: string }>(
      {
        name: "place-proposals-pending-count",
        text: "SELECT COUNT(*) AS n FROM place_proposals WHERE proposed_by = $1 AND status = 'pending'",
      },
      [did],
    );
    // Postgres COUNT(*) is a bigint — node-pg hands it back as a string.
    return Number(res.rows[0]?.n ?? 0);
  }

  async approvedContributionsForPlaces(
    placeUniques: readonly string[],
  ): Promise<ApprovedContribution[]> {
    if (placeUniques.length === 0) return [];
    const res = await this.pool.query<{
      proposed_by: string;
      license: string | null;
      credit: number;
      applied_place: string;
    }>(
      {
        name: "place-proposals-approved-many",
        text:
          "SELECT proposed_by, license, credit, applied_place FROM place_proposals " +
          "WHERE applied_place = ANY($1::text[]) AND status = 'approved' ORDER BY proposed_by",
      },
      [[...placeUniques]],
    );
    return res.rows.map(rowToApprovedContribution);
  }

  async creditedContributionsFor(placeUnique: string): Promise<CreditedContribution[]> {
    const res = await this.pool.query<{ proposed_by: string; license: string | null }>(
      {
        name: "place-proposals-contributors",
        // Not DISTINCT: one person can improve the same place more than once, and the two
        // submissions may carry different grants — collapsing them would lose one.
        text:
          "SELECT proposed_by, license FROM place_proposals WHERE applied_place = $1 " +
          "AND status = 'approved' AND credit = 1 ORDER BY proposed_by",
      },
      [placeUnique],
    );
    return res.rows.map(rowToCreditedContribution);
  }

  async updateProposal(id: string, review: PlaceProposalReview): Promise<number> {
    // Conditional on `pending` so a second decision never clobbers the first (see the interface).
    const res = await this.pool.query(
      {
        name: "place-proposal-review",
        text:
          "UPDATE place_proposals SET status = $1, reviewed_by = $2, reviewed_at = $3, " +
          "review_reason = $4, applied_place = $5 WHERE id = $6 AND status = 'pending'",
      },
      [
        review.status,
        review.reviewedBy,
        review.reviewedAt,
        review.reviewReason ?? null,
        review.appliedPlace ?? null,
        id,
      ],
    );
    return res.rowCount ?? 0;
  }

  async countActive(): Promise<number> {
    const res = await this.pool.query<{ n: string }>(
      "SELECT COUNT(*) AS n FROM places WHERE status = 'active'",
    );
    return Number(res.rows[0]?.n ?? 0);
  }

  async stats(): Promise<PlaceStats> {
    const res = await this.pool.query<{
      places: string;
      retired: string;
      pending: string;
      snapshots: string;
    }>(
      `SELECT
         (SELECT COUNT(*) FROM places WHERE status = 'active') AS places,
         (SELECT COUNT(*) FROM places WHERE status = 'retired') AS retired,
         (SELECT COUNT(*) FROM place_conflicts WHERE resolved_at IS NULL) AS pending,
         (SELECT COUNT(*) FROM place_snapshots) AS snapshots`,
    );
    const row = res.rows[0];
    return {
      places: Number(row?.places ?? 0),
      placesRetired: Number(row?.retired ?? 0),
      conflictsPending: Number(row?.pending ?? 0),
      snapshots: Number(row?.snapshots ?? 0),
    };
  }
}
