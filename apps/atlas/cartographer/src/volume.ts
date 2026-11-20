/**
 * The published artifact, as values — `volume-format.md` made executable.
 *
 * **Pure.** No filesystem, no clock, no signing key, no database. `publish.ts` is the thin shell that
 * hashes, signs and writes what this returns, and the split is what lets stage 6 be a real check rather
 * than a smoke test: the format's correctness is decidable without publishing anything.
 *
 * **Built cell at a time, not dataset at a time.** 225k places carrying descriptions is hundreds of
 * megabytes; one tile is a few dozen records. So the dictionary and the running totals are an explicit
 * {@link BuildState} the caller threads through, and nothing here ever holds more than one cell.
 *
 * **This is where a field meets a length limit.** Stage 1 deliberately applies no wire caps —
 * "staging holds what the source said" (`osm.ts`) — which leaves exactly one place that can, and it
 * is the last one before the bytes become immutable (`apps/atlas/doc/spec/volume-format.md` §10).
 * Every clamp is counted, because a silently truncated field is the same failure class as a
 * throttled fetch recorded as "no photo".
 */
import { DESCRIPTION_MAX, TAXONOMY_VERSION } from "@beaconsgg/place-taxonomy";
import {
  MAX_PLACE_ALT_NAMES,
  MAX_PLACE_MEDIA,
  MAX_PLACE_NAME_LEN,
  PLACE_MEDIA_TYPE,
  MAX_PLACE_URL_LEN,
  canonicalJson,
  placeGeometrySchema,
  type MediaCredit,
  type PlaceGeometry,
} from "@beaconsgg/protocol-types";
import {
  CELL_PRECISION,
  COORD_DECIMALS,
  VOLUME_FORMAT,
  type Bounds,
  type CellSummary,
  type Dictionary,
  type FileRef,
  type ManifestBody,
  type SourceTerms,
  type TileMedia,
  type TileRecord,
  type VolumeIndex,
} from "@beaconsgg/atlas-volume";
import { SOURCE_TERMS } from "./fields";
import type { PublishablePlace, PublishedMedia } from "./store";

/** How many leading characters of a cell name the manifest's `coverage` summarises. */
const COVERAGE_PREFIX = 2;

/**
 * Caps the wire will enforce later, applied here so no consumer ever rejects a place.
 *
 * Imported, not retyped. The claim above is only true while these *are* the wire's numbers, and a copy is
 * how that stops being true — in bytes that can never be corrected, since a version's bytes never change.
 */
const NAME_MAX = MAX_PLACE_NAME_LEN;
const ALT_NAMES_MAX = MAX_PLACE_ALT_NAMES;
const URL_MAX = MAX_PLACE_URL_LEN;

/** The identity stage 2 assigned, as the tile publishes it. */
export interface EntityRefs {
  upstream: string[];
  aliases: string[];
}

/**
 * One interning table while it is being built: the values in order, plus where each already is.
 *
 * The index is the point. Without it `intern` has to scan, re-canonicalizing every existing entry per
 * insert, and **`credits` is not a small table** — a `descriptionCredit` carries a per-article
 * `sourceUrl`, so there is roughly one distinct credit per Wikipedia-sourced description (18.7k on a
 * us-west run once the enrichment has been re-run). Scanning that is ~10⁸ `canonicalJson` calls, a
 * quadratic term in the one stage that is otherwise linear. It did not show on the first real run only
 * because the enrichment columns were empty and the dictionary held exactly one credit.
 */
interface Interner<T> {
  values: T[];
  at: Map<string, number>;
}

/** The interning tables while the volume is being built. {@link dictJson} projects them for publication. */
interface Interners {
  categories: Interner<string>;
  subcategories: Interner<string>;
  credits: Interner<MediaCredit>;
  sources: Interner<SourceTerms & { id: string }>;
}

/** What the publisher had to shorten or drop, so the report can say so out loud. */
export interface Clamps {
  description: number;
  name: number;
  altNames: number;
  website: number;
  wikipedia: number;
  geometry: number;
  /** Photos dropped because a place named more than `MAX_PLACE_MEDIA` allows — see `tileMedia`. */
  media: number;
}

/**
 * Everything that accrues across cells while a volume is built.
 *
 * There is no running place count: the manifest's `places` is summed from the per-cell counts the index
 * already carries, so the two cannot disagree — and `verify` asserts the manifest's total against what the
 * tiles actually hold, which only means something if the manifest's total is not a third tally.
 */
export interface BuildState {
  dict: Interners;
  clamps: Clamps;
  bounds?: Bounds;
}

export function newBuildState(): BuildState {
  const table = <T>(): Interner<T> => ({ values: [], at: new Map() });
  return {
    dict: {
      categories: table<string>(),
      subcategories: table<string>(),
      credits: table<MediaCredit>(),
      sources: table<SourceTerms & { id: string }>(),
    },
    clamps: {
      description: 0,
      name: 0,
      altNames: 0,
      website: 0,
      wikipedia: 0,
      geometry: 0,
      media: 0,
    },
  };
}

/**
 * The index of `value` in its table, appending it if this is the first time it has been seen.
 *
 * Keyed by `canonicalJson` rather than by identity or a hand-written comparison, so two credits that
 * differ only in key order intern to one entry — the same canonicalization the signature and the server's
 * own refresh no-op use, which keeps "equal" meaning one thing across the whole pipeline.
 */
function intern<T>(table: Interner<T>, value: T): number {
  const key = canonicalJson(value);
  const seen = table.at.get(key);
  if (seen !== undefined) return seen;
  const at = table.values.length;
  table.values.push(value);
  table.at.set(key, at);
  return at;
}

/** Round to the published precision, normalising `-0` so two runs canonicalize identically. */
export function round(value: number): number {
  const out = Number(value.toFixed(COORD_DECIMALS));
  return out === 0 ? 0 : out;
}

/**
 * One place's tile record, interning what it references and counting what had to be clamped.
 *
 * `state` is mutated: the dictionary grows, the clamp counters rise, the bounds widen. That is the point
 * of threading it — a `Dictionary` returned by value per place would either be copied 225,000 times or
 * be a lie about what the tiles reference.
 */
export function tileRecord(
  state: BuildState,
  place: PublishablePlace,
  refs: EntityRefs,
): TileRecord {
  const fields = place.fields;
  const point = parsePoint(place.point);
  widen(state, point);

  const record: TileRecord = {
    id: place.entityId,
    upstream: [...refs.upstream].sort(),
    category: intern(state.dict.categories, fields.category),
    point,
    sources: place.sources.map((id) => internSource(state.dict, id)).sort((a, b) => a - b),
  };

  if (refs.aliases.length > 0) record.aliases = [...refs.aliases].sort();

  if (fields.subcategory) record.subcategory = intern(state.dict.subcategories, fields.subcategory);
  if (fields.name) record.name = clamp(fields.name, NAME_MAX, state.clamps, "name");

  if (fields.altNames?.length) {
    // Both limits count. Trimming the list and shortening a name are different losses, and the second
    // one used to happen silently — a published alt name could be shortened with nothing reporting it.
    if (fields.altNames.length > ALT_NAMES_MAX) state.clamps.altNames += 1;
    record.altNames = fields.altNames
      .slice(0, ALT_NAMES_MAX)
      .map((alt) => clamp(alt, NAME_MAX, state.clamps, "name"));
  }

  if (fields.description) {
    record.description = clamp(fields.description, DESCRIPTION_MAX, state.clamps, "description");
    // The credit travels with the text or not at all — `fields.ts`'s `OWNED_BY` established that the
    // pairing is a licensing fact, and dropping the description while keeping its credit here would
    // reintroduce the same bug from the other end.
    if (fields.descriptionCredit) {
      record.descriptionCredit = intern(state.dict.credits, fields.descriptionCredit);
    }
  }

  // A URL is dropped rather than truncated, following `enwikiArticleUrl`: a shortened URL is not a
  // shorter answer, it is a wrong one.
  const website = url(fields.website, state.clamps, "website");
  if (website) record.website = website;
  const wikipedia = url(fields.wikipedia, state.clamps, "wikipedia");
  if (wikipedia) record.wikipedia = wikipedia;

  const media = tileMedia(state, place.media ?? []);
  // Absent, never `[]`. The server's media policy tests `fields.media !== undefined`, so an empty array
  // would count as "this source supplies media", blank the place's photos and block its fallback — the
  // hazard `atlas.ts` documents from the reading end.
  if (media.length > 0) record.media = media;

  return record;
}

/**
 * A place's photos as tile entries: adjacent pairs, thumb first, capped by pair.
 *
 * **Capped here** because this is where every other wire cap is spent, and the failure it prevents
 * is not local: the server accepts over-cap media on the connector path without complaint, and the
 * refusal surfaces later at a *downstream* server's `places.import`, where one over-capped place
 * fails the whole 2,000-feature collection. Measured on us-west the cap does not bind — refs per
 * place run 1, 2 or 3, so at most 6 entries against a limit of 8 — so this is a guard for sources
 * added later, not a live fix.
 *
 * **By pair, never by entry count.** Truncating mid-pair would publish a `full` with no `thumb`, and
 * adjacency is the only thing joining a pair at either end of the wire.
 */
function tileMedia(state: BuildState, media: readonly PublishedMedia[]): TileMedia[] {
  const pairs = Math.floor(MAX_PLACE_MEDIA / 2);
  if (media.length > pairs) state.clamps.media += media.length - pairs;
  const out: TileMedia[] = [];
  for (const file of media.slice(0, pairs)) {
    // The licence pair is interned; the author and the file's own page are not. They vary per file,
    // so interning them would make `dict.credits` about as long as the media list and save nothing
    // (`apps/atlas/doc/spec/volume-format.md` §7).
    const credit = intern(state.dict.credits, {
      license: file.license,
      ...(file.licenseUrl ? { licenseUrl: file.licenseUrl } : {}),
    });
    const source = internSource(state.dict, file.source);
    const shared = {
      credit,
      source,
      ...(file.author ? { author: file.author } : {}),
      ...(file.sourceUrl ? { sourceUrl: file.sourceUrl } : {}),
    };
    out.push({ hash: file.thumbHash, role: "thumb", ...shared });
    out.push({ hash: file.fullHash, role: "full", ...shared });
  }
  return out;
}

/**
 * A place's polygon for the geometry sibling, rounded — or nothing when it exceeds the wire caps.
 *
 * Dropped rather than simplified: a boundary we thinned would be a shape no source asserted, and
 * `apps/atlas/doc/spec/volume-format.md` §5 already ranks geometry below every other field, so a
 * place without one is still complete.
 */
export function geometryFor(state: BuildState, place: PublishablePlace): PlaceGeometry | undefined {
  if (!place.geometry) return undefined;
  const parsed: unknown = JSON.parse(place.geometry);
  const geometry = roundGeometry(parsed);
  if (!geometry || !withinCaps(geometry)) {
    state.clamps.geometry += 1;
    return undefined;
  }
  return geometry;
}

/** `index.json` — the cell list, which is what makes partial import possible (§3). */
export function indexJson(cells: readonly CellSummary[]): VolumeIndex {
  return {
    cellPrecision: CELL_PRECISION,
    cells: [...cells].sort((a, b) => (a.cell < b.cell ? -1 : 1)),
  };
}

/** `dict.json` — the interners projected to the plain arrays a tile's indices point into. */
export function dictJson(dict: Interners): Dictionary {
  return {
    categories: dict.categories.values,
    subcategories: dict.subcategories.values,
    credits: dict.credits.values,
    sources: dict.sources.values,
  };
}

/** What the caller knows that this module cannot compute. */
export interface ManifestInput {
  volume: string;
  version: string;
  revision: number;
  createdAt: string;
  publisher: string;
  index: FileRef;
  dict: FileRef;
  mediaBase: string;
  inputs: { source: string; artifact: string; hash: string }[];
  thumbPx: number;
  fullPx: number;
  /** Distinct media hashes the tiles reference, and their total bytes — derived, never counted. */
  mediaCount: number;
  mediaBytes: number;
  /** Place ids a reviewer removed — see `ManifestBody.retired` for why the artifact must say so. */
  retired: readonly string[];
}

/**
 * The signed root (`apps/atlas/doc/spec/volume-format.md` §2) — small by design, because it must
 * not grow with the dataset.
 *
 * `mediaProfile` carries **no `aspect`**: place images are resized fit-inside a single max
 * dimension with no crop (`sharpResizer` in `@beaconsgg/image-encode`), and a 16:9 aspect belongs
 * to a game's item media. Advertising an aspect no consumer honours would be a contract this volume
 * cannot keep.
 *
 * `media.count` is 0 for now — stage 4 is where photos arrive — and `mediaProfile` is still emitted,
 * because it describes the publisher's conventions rather than the current contents.
 */
export function manifestBody(
  state: BuildState,
  cells: readonly CellSummary[],
  input: ManifestInput,
): ManifestBody {
  return {
    format: VOLUME_FORMAT,
    volume: input.volume,
    version: input.version,
    revision: input.revision,
    createdAt: input.createdAt,
    publisher: input.publisher,
    bounds: state.bounds ?? { minLat: 0, minLng: 0, maxLat: 0, maxLng: 0 },
    coverage: coverageOf(cells),
    cellPrecision: CELL_PRECISION,
    // Summed from the per-cell counts rather than tallied separately, so the manifest's total and the
    // index's cannot disagree — and `verify`'s check of the manifest against what the tiles actually hold
    // stays a real check rather than a comparison of two numbers written by the same counter.
    places: cells.reduce((total, cell) => total + cell.places, 0),
    index: input.index,
    dict: input.dict,
    // The distinct hashes **this version's tiles reference**, and the bytes behind them — not the contents
    // of `media/`, which is shared across versions and legitimately holds an older version's photos.
    media: { base: input.mediaBase, count: input.mediaCount, bytes: input.mediaBytes },
    // Absent rather than `[]` when nothing was removed — the field says "a curator took these out",
    // and an empty list would be a claim where there is nothing to claim.
    ...(input.retired.length > 0 ? { retired: [...input.retired].sort() } : {}),
    taxonomy: TAXONOMY_VERSION,
    mediaProfile: { thumbPx: input.thumbPx, fullPx: input.fullPx, format: PLACE_MEDIA_TYPE },
    inputs: input.inputs,
    licenses: state.dict.sources.values.map((source) => ({
      id: source.id,
      name: source.name,
      license: source.license,
      // Omitted, never `undefined`: public domain has no licence to link to, and `canonicalJson` — which
      // the signature is taken over — refuses an explicit undefined rather than dropping it.
      ...(source.licenseUrl ? { licenseUrl: source.licenseUrl } : {}),
    })),
  };
}

/** The distinct cell prefixes that contain data — enough for a consumer to skip a whole region. */
function coverageOf(cells: readonly CellSummary[]): string[] {
  return [...new Set(cells.map((c) => c.cell.slice(0, COVERAGE_PREFIX)))].sort();
}

/** Look a source up in {@link SOURCE_TERMS}, interning its terms. */
function internSource(dict: Interners, id: string): number {
  const seen = dict.sources.at.get(id);
  if (seen !== undefined) return seen;
  // Widened deliberately: `id` comes out of `merged_places.sources`, so the question this asks is
  // "does the table know this source" — which is exactly what the type would refuse to let us ask.
  const terms = (SOURCE_TERMS as Record<string, SourceTerms | undefined>)[id];
  if (!terms) {
    // Refused rather than defaulted. A published field whose licence nobody declared is the one
    // publishing mistake a later version cannot repair, because a version's bytes never change.
    throw new Error(
      `source "${id}" has no redistribution terms — add it to SOURCE_TERMS in fields.ts before publishing it`,
    );
  }
  const at = dict.sources.values.length;
  dict.sources.values.push({ id, ...terms });
  // Keyed by the source id, not by canonical JSON: the id *is* the identity here, and two entries for one
  // id would put the same attribution in the dictionary twice.
  dict.sources.at.set(id, at);
  return at;
}

function widen(state: BuildState, [lng, lat]: [number, number]): void {
  const bounds = state.bounds;
  if (!bounds) {
    state.bounds = { minLat: lat, minLng: lng, maxLat: lat, maxLng: lng };
    return;
  }
  bounds.minLat = Math.min(bounds.minLat, lat);
  bounds.minLng = Math.min(bounds.minLng, lng);
  bounds.maxLat = Math.max(bounds.maxLat, lat);
  bounds.maxLng = Math.max(bounds.maxLng, lng);
}

/**
 * GeoJSON `Point` text → the `[lng, lat]` the tile publishes, at the published precision.
 *
 * Exported because `merge.ts` needs **exactly this rounding** to pick a place's cell: the cell is only
 * correct if it is derived from the coordinate that gets published, and 31 of 225,084 us-west places sit
 * close enough to a cell edge for the difference to matter. Two parsers would let the next edit to one
 * reopen that silently, with the test that caught it still passing.
 */
export function parsePoint(geojson: string): [number, number] {
  const parsed: unknown = JSON.parse(geojson);
  const coordinates = (parsed as { coordinates?: unknown }).coordinates;
  if (!Array.isArray(coordinates) || coordinates.length < 2) {
    throw new Error(`not a GeoJSON Point: ${geojson.slice(0, 80)}`);
  }
  return [round(Number(coordinates[0])), round(Number(coordinates[1]))];
}

function clamp(value: string, max: number, clamps: Clamps, field: keyof Clamps): string {
  if (value.length <= max) return value;
  clamps[field] += 1;
  // Cut on a word boundary when there is one reasonably near the limit, rather than mid-word.
  //
  // A bare `slice` ends a published description with "…the Cascade Ra", which is worse than the sentence
  // being shorter — and this is the last chance to decide, because a version's bytes never change. The 0.6
  // floor is what stops a long unbroken token (a URL, a run-on transliteration) from cutting the text to
  // almost nothing in pursuit of a boundary. Carried over from the enrichment job this pipeline absorbed,
  // whose own truncation rule would otherwise have been lost with it.
  const cut = value.slice(0, max);
  const lastSpace = cut.lastIndexOf(" ");
  return (lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd();
}

function url(value: string | undefined, clamps: Clamps, field: keyof Clamps): string | undefined {
  if (!value) return undefined;
  if (value.length > URL_MAX) {
    clamps[field] += 1;
    return undefined;
  }
  return value;
}

/** Round every position of a `Polygon`/`MultiPolygon`, rejecting any other geometry type. */
function roundGeometry(parsed: unknown): PlaceGeometry | undefined {
  const type = (parsed as { type?: unknown }).type;
  const coordinates = (parsed as { coordinates?: unknown }).coordinates;
  if (!Array.isArray(coordinates)) return undefined;
  if (type === "Polygon") {
    return { type: "Polygon", coordinates: coordinates.map(roundRing) };
  }
  if (type === "MultiPolygon") {
    return {
      type: "MultiPolygon",
      coordinates: coordinates.map((polygon: unknown) =>
        Array.isArray(polygon) ? polygon.map(roundRing) : [],
      ),
    };
  }
  return undefined;
}

function roundRing(ring: unknown): [number, number][] {
  if (!Array.isArray(ring)) return [];
  return ring.map((position: unknown) => {
    const pair = position as [number, number];
    return [round(Number(pair[0])), round(Number(pair[1]))] as [number, number];
  });
}

/**
 * Whether the **published** geometry is one the wire will accept.
 *
 * `placeGeometrySchema` rather than a hand-written cap check, which is the rule both of the server's own
 * connectors already follow — "validity (≥4 positions, closed ring, caps) is the schema's job, one rule
 * set, expressed once" (`places/connectors/osm.ts`). A first draft here hand-rolled it and the copy in
 * `verify.ts` hand-rolled it differently: one checked ring closure and the other did not, so the
 * publisher's rule and the verifier's rule were quietly two rules.
 *
 * It has to run on the **rounded** geometry, not the source's. Rounding to 5 decimals moves positions, so
 * a ring whose ends differed only in the 7th decimal closes by accident and one that was closed can come
 * apart — and the ring a consumer validates is the one we published.
 *
 * `.success` only, never `.data`: the value is already the right shape, and this is a gate rather than a
 * parse.
 */
export function withinCaps(geometry: PlaceGeometry): boolean {
  return placeGeometrySchema.safeParse(geometry).success;
}
