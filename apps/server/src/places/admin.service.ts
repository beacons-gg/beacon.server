import { coarsestFitCover, WORLD_CELLS, type BBox } from "@beaconsgg/geo";
import {
  MAX_PLACE_FEATURES,
  type PlaceCreateParams,
  type PlaceDetail,
  type PlaceEditableField,
  type PlaceEditSet,
  type PlaceExport,
  type PlaceFeature,
} from "@beaconsgg/protocol-types";
import { Injectable } from "@nestjs/common";
import { ulid } from "ulid";
import type { ServerConfig } from "../config";
import { liveView } from "../settings/live-config";
import type {
  PlaceConflictRecord,
  PlaceFields,
  PlaceRecord,
  PlaceStore,
} from "../stores/place-store";
import { commitCuratedRecord, definedFields, remergeOrRetire, splitSelfSource } from "./canonical";
import {
  boundaryBBox,
  pointInBoundary,
  licenseEnvelope,
  toContribFeature,
  toFeature,
  toFeatureCollection,
  type ExportBoundary,
  type FeatureProvenance,
} from "./export-import";
import { ADMIN_SOURCE, CONTRIB_SOURCE, mergeFields } from "./merge";
import { contribSourceId } from "@beaconsgg/place-taxonomy";
import { contributorDids } from "../stores/place-store";
import { placeDetail } from "./places.service";

/** The admin-surface knobs, lifted out of {@link ServerConfig} so the service is easy to test. */
export interface PlacesAdminConfig {
  host: string; // the exporter identity stamped into the file's beacon block
  cellPrecision: number; // the place_cells index precision (edits re-index)
  /**
   * `BEACON_PLACES_PROPOSALS_EXPORT`: whether this server shares its approved contributions onward.
   *
   * On the admin service's own config, like every other admin knob, rather than as a DI token: the
   * controller already asks `this.snapshots.enabled` the same way, and a flag whose owning service
   * has a config object does not need four wiring sites.
   */
  contribExportEnabled: boolean;
}
/** The places admin slice, as accessors over the live config — see settings/live-config.ts. */
export function placesAdminConfigFrom(c: ServerConfig): PlacesAdminConfig {
  return liveView(c, {
    host: "host",
    cellPrecision: "placesCellPrecision",
    contribExportEnabled: "placesContribExportEnabled",
  });
}

/** How many conflict rows a fetch returns (unresolved-first). */
const CONFLICT_LIST_LIMIT = 100;

/** Every precision-1 geohash — the "whole dataset" prefix set (32 single-char prefix scans). */
const WORLD_PREFIXES = [...WORLD_CELLS];
/** Places per batched read in the contribution export — the `commitPlaces` slice size. */
const EXPORT_CHUNK = 500;

/** Group rows by a key — the two batched reads both arrive flat and are consumed per place. */
function groupBy<T>(rows: readonly T[], key: (row: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const row of rows) {
    const list = out.get(key(row));
    if (list) list.push(row);
    else out.set(key(row), [row]);
  }
  return out;
}

/** Cap on the export cover's prefix count (bounds the query's LIKE clause list). */
const EXPORT_COVER_MAX_CELLS = 64;

/**
 * The direct-curation admin surface (`doc/spec/places.md` §3.1, §6.3 and §7): **create** a place by
 * hand, per-field **edit** over the admin source record, the **conflict** review queue, and the
 * boundary-filtered **export**.
 *
 * Edit semantics: `set` fields become admin-held (they win every merge and connector collisions
 * are logged, never applied); `clear` releases overrides — the connector's value flows back on
 * the recompute because source records keep their own fields. Clearing the last override retires
 * the admin record (goneAt — no hard deletes), restoring full automatic behavior (including
 * auto-retirement); a later edit revives it.
 *
 * Export walks the dataset (a coarse
 * cell cover pre-filters, then a precise point-in-boundary check), emits one Feature per place
 * with its live-source provenance, and stamps the dataset attribution into the file — an
 * OSM-derived list is an ODbL derivative, so the credit travels with it.
 */
@Injectable()
export class PlacesAdminService {
  constructor(
    private readonly store: PlaceStore,
    private readonly cfg: PlacesAdminConfig,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** Whether contribution sharing is on — the export route 404s when it is not. */
  get contribExportEnabled(): boolean {
    return this.cfg.contribExportEnabled;
  }

  /** A place as the wire's `PlaceDetail`, the shape `places.create` and `places.edit` answer with. */
  detail(place: PlaceRecord): Promise<PlaceDetail> {
    return placeDetail(this.store, place);
  }

  /**
   * Apply an admin edit to a place's admin source record and recompute the canonical row.
   * Returns the fresh canonical record, or `undefined` for an unknown place. Editing a retired
   * place re-activates it when the merge is servable (curation implies the operator wants it).
   */
  async edit(
    unique: string,
    set: PlaceEditSet,
    clear: readonly PlaceEditableField[],
    actor: string,
  ): Promise<PlaceRecord | undefined> {
    const place = await this.store.getPlace(unique);
    if (!place) return undefined;
    const nowIso = new Date(this.now()).toISOString();
    const { self, others } = await splitSelfSource(this.store, ADMIN_SOURCE, unique);

    const fields: PlaceFields = { ...(self?.fields ?? {}) };
    const touched = new Set<string>(clear);
    for (const [key, value] of Object.entries(definedFields(set))) {
      (fields as Record<string, unknown>)[key] = value;
      touched.add(key);
    }
    for (const field of clear) delete fields[field]; // PlaceEditableField is keyof PlaceFields — compiler-pinned

    if (Object.keys(fields).length === 0) {
      // The last override is gone: retire the admin record and let the sources speak again.
      if (self) await this.store.setSourceGone(ADMIN_SOURCE, unique, nowIso);
      await remergeOrRetire(this.store, unique, nowIso, this.cfg.cellPrecision);
      await this.resolveTouched(unique, touched, nowIso);
      return this.store.getPlace(unique);
    }

    // Unservable merges (an exotic clear) keep the canonical row as-is; the record still lands.
    await commitCuratedRecord(this.store, this.cfg.cellPrecision, {
      source: ADMIN_SOURCE,
      unique,
      fields,
      others,
      actor,
      nowIso,
      fallback: place,
    });
    await this.resolveTouched(unique, touched, nowIso);
    return this.store.getPlace(unique);
  }

  /**
   * Author a place by hand (`doc/spec/place-proposals.md` §7) — the operator counterpart to a
   * connector snapshot, and the verb {@link edit} can't provide (it 404s on an unknown `unique`, so
   * a place no connector produced was previously uncreatable). Mints a fresh ULID and lands the
   * values as an **`admin` source**, so the new place behaves exactly like an edited one: it wins
   * every merge, never auto-retires, and a later `places.edit` adjusts it normally.
   */
  async create(params: PlaceCreateParams, actor: string): Promise<PlaceRecord> {
    const unique = ulid(this.now());
    const nowIso = new Date(this.now()).toISOString();
    // A fresh unique has no other sources — the admin record IS the whole merge.
    const place = await commitCuratedRecord(this.store, this.cfg.cellPrecision, {
      source: ADMIN_SOURCE,
      unique,
      fields: definedFields(params),
      others: [],
      actor,
      nowIso,
    });
    if (!place) {
      // Unreachable: the wire schema requires the two fields canonicalPlace needs.
      throw new Error("places.create: schema-valid params did not yield a servable place");
    }
    return place;
  }

  /**
   * An edit that sets or clears a conflicted field IS its resolution (the doc's adopt /
   * drop-override outcomes) — auto-resolve those rows so the pending queue never lies.
   */
  private async resolveTouched(
    unique: string,
    touched: ReadonlySet<string>,
    nowIso: string,
  ): Promise<void> {
    if (touched.size === 0) return;
    const open = (await this.store.listConflicts(unique, CONFLICT_LIST_LIMIT)).filter(
      (c) => c.resolvedAt === undefined && touched.has(c.field),
    );
    if (open.length > 0) {
      await this.store.resolveConflicts(
        open.map((c) => c.id),
        nowIso,
      );
    }
  }

  /** The pending-revision queue (unresolved-first), optionally scoped to one place. */
  listConflicts(unique: string | undefined): Promise<PlaceConflictRecord[]> {
    return this.store.listConflicts(unique, CONFLICT_LIST_LIMIT);
  }

  /** Mark conflict rows reviewed; returns how many actually flipped (idempotent). */
  resolveConflicts(ids: readonly string[]): Promise<number> {
    return this.store.resolveConflicts(ids, new Date(this.now()).toISOString());
  }

  /** Export the dataset (or the boundary's slice) as the interchange FeatureCollection. */
  async exportPlaces(boundary?: ExportBoundary): Promise<PlaceExport> {
    const prefixes = boundary ? exportCover(boundaryBBox(boundary)) : WORLD_PREFIXES;
    const { places: summaries, truncated } = await this.store.queryByCells(
      prefixes,
      undefined,
      MAX_PLACE_FEATURES,
    );

    const features: PlaceFeature[] = [];
    const attribution = new Set<string>();
    for (const summary of summaries) {
      // The cover over-selects at cell granularity — the boundary check is the precise filter.
      if (boundary && !pointInBoundary(summary.point, boundary)) continue;
      // The summary projection is the LIGHT shape — it drops the polygon AND the detail-only
      // descriptor fields (description/website/wikipedia/altNames), so the export must fetch the
      // full record: an exported list has to round-trip everything (a summary-built Feature
      // would silently strip the descriptors on every hop).
      const full = await this.store.getPlace(summary.unique);
      const sources: FeatureProvenance[] = (await this.store.sourcesForPlace(summary.unique))
        .filter((s) => s.goneAt === undefined)
        .map((s) => {
          if (s.attribution !== undefined) attribution.add(s.attribution);
          return {
            source: s.source,
            ...(s.attribution !== undefined ? { attribution: s.attribution } : {}),
          };
        });
      features.push(toFeature(full ?? summary, sources));
    }

    return toFeatureCollection(features, {
      host: this.cfg.host,
      exportedAt: new Date(this.now()).toISOString(),
      attribution: [...attribution].sort(),
      truncated,
    });
  }

  /**
   * The approved player contributions this server holds, as a `beacon-contrib/1` file
   * (`apps/atlas/doc/spec/beacon-integration.md` §9) — the export half of the contribution
   * round-trip.
   *
   * The working set is the `contrib` source's live records, scoped by the same coarse cell cover
   * {@link exportPlaces} uses, then read in batches: per chunk, the places' sibling source records
   * (for the upstream keys an ingesting dataset joins on, and for the point and category an
   * improvement does not carry) and every approved contribution to them.
   *
   * **A place travels only if every contribution that fed it was granted to us.** The gate reads
   * *approved* contributions rather than *credited* ones, which is the whole reason that read is
   * wider than the detail page's: an uncredited submission is absent from a credited-only read, so
   * a place whose only contribution had no grant would look identical to a place with none — and
   * would ship stamped CC0 on a grant nobody made, into bytes that never change.
   */
  async exportContributions(boundary?: ExportBoundary): Promise<PlaceExport> {
    // Scoped at the query, not by filtering afterwards: an unscoped read ships and parses every
    // contributed place's fields to throw most away (the `liveSourcesBySource` cellPrefixes
    // contract, and what `exportPlaces` already does one method up).
    const records = await this.store.liveSourcesBySource(
      CONTRIB_SOURCE,
      boundary ? exportCover(boundaryBBox(boundary)) : undefined,
    );
    const features: PlaceFeature[] = [];
    let truncated = false;

    for (let i = 0; i < records.length && !truncated; i += EXPORT_CHUNK) {
      const chunk = records.slice(i, i + EXPORT_CHUNK);
      const uniques = chunk.map((r) => r.placeUnique);
      // Independent reads, so concurrent — and batched, because the alternative is three round
      // trips per contributed place on a path an operator runs against a remote Postgres.
      const [siblings, contributions] = await Promise.all([
        this.store.sourcesForPlaces(uniques),
        this.store.approvedContributionsForPlaces(uniques),
      ]);
      const siblingsBy = groupBy(siblings, (s) => s.placeUnique);
      const contributionsBy = groupBy(contributions, (c) => c.placeUnique);

      for (const record of chunk) {
        if (features.length >= MAX_PLACE_FEATURES) {
          truncated = true;
          break;
        }
        const approved = contributionsBy.get(record.placeUnique) ?? [];
        // No grant recorded ⇒ nothing was granted. Nothing to publish, and nothing to claim.
        if (approved.length === 0 || approved.some((c) => c.license === undefined)) continue;

        const live = (siblingsBy.get(record.placeUnique) ?? []).filter(
          (s) => s.goneAt === undefined,
        );
        // An *improvement* contributes descriptor fields only — never a point or a category,
        // because moving or recategorizing someone else's place is operator-only. So those two come
        // from the place, through the same per-field merge that produced its canonical row:
        // **positional context, not a contributed claim.** A Feature cannot exist without them, and
        // copying the place's verbatim is the rule Atlas's own derived sources follow — a record
        // that invented its own point would inflate the distance gate its merge stands on.
        const merged = mergeFields(live);
        const point = merged.point;
        const category = merged.category;
        // A contribution whose place has since been retired and purged has nowhere to sit.
        if (point === undefined || category === undefined) continue;
        if (boundary && !pointInBoundary(point, boundary)) continue;

        features.push(
          toContribFeature({
            unique: record.placeUnique,
            fields: record.fields,
            point,
            category,
            contribId: contribSourceId(this.cfg.host, record.placeUnique),
            upstream: live
              .filter((s) => s.source !== CONTRIB_SOURCE)
              .map((s) => s.sourceId)
              .sort(),
            license: licenseEnvelope(approved),
            contributors: contributorDids(approved.filter((c) => c.credited)),
            updatedAt: record.syncedAt,
          }),
        );
      }
    }

    return toFeatureCollection(features, {
      host: this.cfg.host,
      exportedAt: new Date(this.now()).toISOString(),
      // The per-field and per-photo credits carry the terms; a dataset-level attribution line would
      // be a second, weaker statement of the same thing.
      attribution: [],
      truncated,
      profile: "beacon-contrib/1",
    });
  }
}

/**
 * The export pre-filter cover, coarsest-fit with the **real** count enforced: estimate first (the
 * geo cost-trap discipline — never enumerate a continent at a fine precision), then enumerate and
 * accept only a cover that actually fits the cap. Precision 1 (≤ 32 cells) always fits.
 */
function exportCover(bbox: BBox): string[] {
  // Slack 2: the estimate can overshoot ~2× — don't skip a precision that would actually fit.
  return coarsestFitCover(bbox, {
    precision: 5,
    maxCells: EXPORT_COVER_MAX_CELLS,
    estimateSlack: 2,
  });
}
