import { coarsen } from "@beaconsgg/geo";
import type {
  PlaceCategory,
  PlaceDetail,
  PlaceSummary,
  PlacesQueryResult,
  PlaceTaxonomy,
} from "@beaconsgg/protocol-types";
import { Injectable } from "@nestjs/common";
import type { ServerConfig } from "../config";
import { liveView } from "../settings/live-config";
import {
  contributorDids,
  type PlaceQueryRecord,
  type PlaceRecord,
  type PlaceStore,
} from "../stores/place-store";
import { PLACE_VOCABULARY } from "@beaconsgg/place-taxonomy";

/** The places read knobs, lifted out of {@link ServerConfig} so the service is easy to test. */
export interface PlacesConfig {
  enabled: boolean;
  cellPrecision: number;
  /** Default + max places per page (`BEACON_PLACES_PAGE_SIZE`) — the read path, decoupled from the connector budget. */
  pageSize: number;
  queryMaxCells: number;
}
/** The places read slice, as accessors over the live config — see settings/live-config.ts. */
export function placesConfigFrom(c: ServerConfig): PlacesConfig {
  return liveView(c, {
    enabled: "placesEnabled",
    cellPrecision: "placesCellPrecision",
    pageSize: "placesQueryPageSize",
    queryMaxCells: "placesQueryMaxCells",
  });
}

/** Optional per-query paging levers (both absent ⇒ the default first page of `pageSize`). */
export interface PlacesQueryOptions {
  /** Keyset cursor — the `cursor` from a prior page's result (a place `unique`). */
  cursor?: string;
  /** Page size request, clamped to `[1, pageSize]`. Omitted ⇒ the full `pageSize`. */
  limit?: number;
  /** One page spread evenly over the area, for a map; never paged (see `PlaceStore.queryByCells`). */
  spread?: boolean;
}

/**
 * The places read path (`doc/spec/places.md` §5): serve the server's **owned dataset**, always — a
 * pure indexed store read, no upstream call, no cache, no freshness contract for games to handle.
 * An unpopulated area returns an honest empty list (each server curates the geo ranges it covers;
 * population is the admin snapshot surface).
 */
@Injectable()
export class PlacesService {
  constructor(
    private readonly store: PlaceStore,
    private readonly cfg: PlacesConfig,
  ) {}

  /** Whether the capability is enabled (routes 404 when off). */
  get enabled(): boolean {
    return this.cfg.enabled;
  }
  /** Per-query `cells` cap (the shared discovery bound — the geo cost trap). */
  get queryMaxCells(): number {
    return this.cfg.queryMaxCells;
  }
  /**
   * The coarsest query cell accepted. A very coarse prefix (`b`) would make the semijoin enumerate
   * the whole cell index before LIMIT could bound anything — the v1 floor, kept in v2.
   */
  get minCellPrecision(): number {
    return this.cfg.cellPrecision - 2;
  }

  /**
   * Places in the queried cells, category-filtered, one page at a time. Cells finer than the index
   * precision are coarsened (they can't cache-bust or over-specify); coarser cells prefix-match
   * everything under them. Result attribution is derived from the sources actually present.
   *
   * Paging is keyset (`doc/spec/places.md` §5): a full page sets `truncated` and returns `cursor`
   * (the last place's `unique`); re-issue the same query with `{ cursor }` to advance. A
   * single-page caller just reads the first page (up to `pageSize`). A `spread` page is the one
   * exception: it is `truncated` when the area holds more, with no `cursor`, because it is the only
   * page.
   */
  async query(
    cells: string[],
    categories: PlaceCategory[],
    opts: PlacesQueryOptions = {},
  ): Promise<PlacesQueryResult> {
    // coarsen() already returns a shorter hash as-is, so this is one unconditional map.
    const prefixes = [...new Set(cells.map((c) => coarsen(c, this.cfg.cellPrecision)))];
    const limit = Math.min(Math.max(opts.limit ?? this.cfg.pageSize, 1), this.cfg.pageSize);
    const { places, truncated } = await this.store.queryByCells(
      prefixes,
      categories,
      limit,
      opts.cursor,
      opts.spread,
    );
    const attribution = await this.store.attributionsForPlaces(places.map((p) => p.unique));
    return {
      places: places.map(toSummary),
      attribution,
      truncated,
      // A full page (truncated) always has a last row, and its unique is the next keyset cursor;
      // a spread page has no next page.
      cursor: truncated && !opts.spread ? places[places.length - 1]?.unique : undefined,
    };
  }

  /**
   * The curated category → subcategory vocabulary (`doc/spec/place-proposals.md` §4.2). Derived
   * from the tag map at module load, so this is a pure read of a constant — no store, no upstream.
   *
   * The slug arrays are copied, not shared: `PLACE_VOCABULARY` lives for the process, and handing
   * out its inner arrays would let one caller's mutation corrupt every later response.
   */
  taxonomy(): PlaceTaxonomy {
    return {
      categories: PLACE_VOCABULARY.map((v) => ({ ...v, subcategories: [...v.subcategories] })),
    };
  }

  /** One place with its full geometry + provenance summary, or `undefined` (unknown/retired). */
  async detail(unique: string, withContributors = false): Promise<PlaceDetail | undefined> {
    const place = await this.store.getPlace(unique);
    if (!place || place.status !== "active") return undefined;
    return placeDetail(this.store, place, withContributors);
  }
}

/**
 * A place record as the wire's `PlaceDetail`: what `GET /places/:unique` answers, and what the
 * operator's `places.create` and `places.edit` answer with too, so no route serves the store's own
 * record shape. Takes the record whatever its status; the public read refuses a retired one first.
 */
export async function placeDetail(
  store: PlaceStore,
  place: PlaceRecord,
  withContributors = false,
): Promise<PlaceDetail> {
  const unique = place.unique;
  // Independent reads, so concurrent — this is a public read path and the second one is opt-in.
  const [records, credited] = await Promise.all([
    store.sourcesForPlace(unique),
    withContributors ? store.creditedContributionsFor(unique) : Promise.resolve([]),
  ]);
  const sources = records
    .filter((s) => s.goneAt === undefined)
    .map((s) => ({
      source: s.source,
      ...(s.attribution !== undefined ? { attribution: s.attribution } : {}),
    }));
  return {
    ...toSummary({
      ...place,
      hasGeometry: place.geometry !== undefined,
      hasDescription: place.description !== undefined,
    }),
    ...(place.geometry !== undefined ? { geometry: place.geometry } : {}),
    ...(place.description !== undefined ? { description: place.description } : {}),
    ...(place.descriptionCredit !== undefined
      ? { descriptionCredit: place.descriptionCredit }
      : {}),
    ...(place.website !== undefined ? { website: place.website } : {}),
    ...(place.wikipedia !== undefined ? { wikipedia: place.wikipedia } : {}),
    ...(place.altNames !== undefined ? { altNames: place.altNames } : {}),
    // Only when asked. `placeDetailSchema` is `.strict()`, so an unconditional key would fail the
    // parse of every already-deployed client; opting in lets this ship before they read it.
    // The extra read is skipped entirely rather than fetched-and-dropped.
    // Deduped by `contributorDids`, not in SQL: the read is deliberately not DISTINCT because
    // one person may contribute twice under different grants and the export needs both.
    ...(withContributors ? { contributors: contributorDids(credited) } : {}),
    sources,
  };
}

/** The light list shape: no polygon (the detail route carries it), `hasGeometry` as the pointer. */
function toSummary(place: PlaceQueryRecord): PlaceSummary {
  return {
    unique: place.unique,
    category: place.category,
    ...(place.subcategory !== undefined ? { subcategory: place.subcategory } : {}),
    ...(place.name !== undefined ? { name: place.name } : {}),
    point: place.point,
    hasGeometry: place.hasGeometry,
    hasDescription: place.hasDescription,
    ...(place.media !== undefined ? { media: place.media } : {}),
    updatedAt: place.updatedAt,
  };
}
