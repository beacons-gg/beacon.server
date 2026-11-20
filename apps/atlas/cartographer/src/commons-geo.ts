/**
 * The Commons geo source — photos proven to be *inside* a place, staged as `commons` records, plus the
 * category listings that un-defer the mapper's `wikimedia_commons=Category:…` refs.
 *
 * **Containment is the only signal that survived measurement** (`apps/atlas/doc/spec/sources.md`
 * §3). Radius proximity finds photos of the *town* — a dog park's nearest geotagged files were the
 * county courthouse; a candy shop's was an Apple Store. Name-in-title matched 0 of 176 candidates.
 * `depicts` (P180) matched 1 of 40 QID holders, because our photo-less QIDs are bot-created GNIS
 * items nobody photographs. What held was the polygon: of the files geosearch offered for 40 parks,
 * the two whose coordinate fell **inside** the park's own geometry were both genuinely photos of
 * the place. So the join here is `ST_Contains` against the record's area geometry, nothing weaker —
 * point features get no arm at all, because no honest gate exists for them.
 *
 * **Discovery is a local join, not an API walk.** Commons publishes `geo_tags` — the coordinate of
 * every geotagged page — as a ~0.7 GB dump, and §3 already committed to "metadata via the dump; bytes
 * only one at a time". `--dump` loads it whole; the containment join then runs in PostGIS across every
 * candidate polygon at once, and only the *matched* page ids ever touch the API (title resolution,
 * batched 50 at a time, cached three-state). ~175,000 per-place searches become ~a hundred requests.
 *
 * **A derived source on the `wikipedia.ts` template**: one record per enriched place, `derivedFrom`
 * naming its parent, no identifiers of its own, category and point copied verbatim, no name and no
 * prose. The source id is `commons` — the media source the volume already declares — because the record
 * asserts nothing except "Wikimedia Commons offers these photos here", and stage 4's existing Commons
 * arm does the per-file licence gate exactly as it does for every other Commons reference.
 */
import { commonsCategoryTitle, commonsFileTitle } from "@beaconsgg/place-taxonomy";
import { BATCH, type WikimediaClient } from "@beaconsgg/wikimedia";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { createGunzip } from "node:zlib";
import { recordInput } from "./inputs";
import {
  clearCommonsGeoTags,
  COMMONS_SOURCE,
  distinctCategoryRefs,
  fetchGeoCandidates,
  finishCommonsGeoTags,
  knownCategories,
  overCapPolygons,
  readGeoPages,
  recordRef,
  writeCommonsCategories,
  writeCommonsGeoTags,
  writeGeoPages,
  writeStaged,
  type CommonsCategoryRow,
  type GeoCandidate,
  type GeoHit,
  type GeoPageRow,
  type GeoTagRow,
  type Querier,
  type RecordRef,
  type StagedRow,
} from "./store";

/** Who a containment-found photo is claimed by — stage 4 ranks it last, below every human choice. */
export const GEO_CLAIMER = COMMONS_SOURCE;

/**
 * Polygons above this stop meaning "the place is the frame". Measured on us-west: 2 km² keeps 94.8% of
 * the 75,202 candidate polygons and excludes exactly the Central-Park-and-up scale where a contained
 * photo is a photo of *somewhere in a district* — and those places have articles and photos already.
 */
export const GEO_AREA_CAP_M2 = 2_000_000;

/**
 * The category no imagery slice searches — `apps/atlas/doc/spec/sources.md` §3: a street photo of a
 * pole-mounted camera is a waste of volume bytes; the category's value is the location.
 * Category-driven on purpose, never name-driven, and only about *search* — a mapper's explicit
 * photo ref on such a place still resolves through the normal machinery.
 */
export const IMAGERY_EXCLUDED_CATEGORY = "surveillance";

/** Contained files fetched per polygon — enough to survive the extension filter, bounded under a campus. */
const HIT_CAP = 24;

/** Refs staged per place. Stage 4 fetches every ref it links, so this is also a byte budget. */
const REFS_PER_PLACE = 3;

/** Polygon candidates per containment page — each page is one PostGIS query plus its API resolution. */
const PAGE_SIZE = 5_000;

/** Dump rows per INSERT batch. */
const LOAD_BATCH = 5_000;

/** Category answers per durable write. */
const CATEGORY_WRITE_BATCH = 20;

/**
 * A file the crawl can actually publish: an extension sharp decodes and a photograph plausibly wears.
 * The probe's rural polygons surfaced the counterexample this exists for — USDA NAIP aerial-survey
 * TIFF tiles are geotagged on a grid across the whole country, land inside every rural polygon, and
 * are not a photo of anything in particular.
 */
const PHOTO_EXT = /\.(jpe?g|png|webp|gif)$/i;

export interface CommonsGeoReport {
  /** Dump rows loaded and rows dropped (wrong globe, unparseable coordinate) — only under `--dump`. */
  loaded?: { rows: number; skipped: number };
  /** Distinct categories the staged records reference. */
  categories: number;
  /** Categories asked about this run / already answered / answered-absent this run / never answered. */
  categoriesFetched: number;
  categoriesKnown: number;
  categoriesAbsent: number;
  categoriesUnanswered: number;
  /** Polygons the containment join walked, and the ones the area cap excluded from it. */
  polygons: number;
  overCap: number;
  /** Polygons with at least one contained file. */
  withHits: number;
  /** Page ids asked about this run / already answered / answered-absent this run / never answered. */
  pagesFetched: number;
  pagesKnown: number;
  pagesAbsent: number;
  pagesUnanswered: number;
  /** Records staged as a `commons` source, and the refs they carry. */
  staged: number;
  refs: number;
}

const emptyReport = (): CommonsGeoReport => ({
  categories: 0,
  categoriesFetched: 0,
  categoriesKnown: 0,
  categoriesAbsent: 0,
  categoriesUnanswered: 0,
  polygons: 0,
  overCap: 0,
  withHits: 0,
  pagesFetched: 0,
  pagesKnown: 0,
  pagesAbsent: 0,
  pagesUnanswered: 0,
  staged: 0,
  refs: 0,
});

export interface CommonsGeoOptions {
  /** Path to `commonswiki-*-geo_tags.sql.gz` — load (replacing the table) before the join. */
  dump?: string;
  /** Re-ask about categories and page ids already answered for — the negative-cache door. */
  refresh: boolean;
  dryRun: boolean;
  client: WikimediaClient;
  now: () => string;
  log: (message: string) => void;
}

/**
 * The lead a category listing yields, or nothing worth claiming.
 *
 * A category is a human-curated set of photos *of exactly this place*, so any member is on-subject and
 * the pick only has to be publishable and deterministic: publishable means {@link PHOTO_EXT} (a
 * category's PDFs, SVG maps and archival TIFFs are real members and wrong leads), deterministic means
 * first by title — re-running the pick against an unchanged listing must stage an unchanged ref.
 */
export function categoryLead(members: readonly string[]): string | undefined {
  return members.filter((title) => PHOTO_EXT.test(title)).sort()[0];
}

/**
 * The refs one polygon's contained files become — the selection rule, pure and in one place.
 *
 * Preference order: an {@link GeoHit.isPrimary object-location} row beats a camera position (it is an
 * explicit claim about the *subject*), then nearer the record's point, then page id for determinism.
 * A page with both coordinate kinds inside the polygon counts once, as its stronger kind. Unresolved
 * and non-photo titles drop out; the survivors cap at {@link REFS_PER_PLACE}.
 */
export function pickGeoRefs(
  hits: readonly GeoHit[],
  titles: ReadonlyMap<number, string>,
): string[] {
  const byPage = new Map<number, GeoHit>();
  for (const hit of hits) {
    const seen = byPage.get(hit.pageId);
    if (!seen || (seen.isPrimary && !hit.isPrimary)) byPage.set(hit.pageId, hit);
  }
  return [...byPage.values()]
    .map((hit) => ({ hit, title: titles.get(hit.pageId) }))
    .filter((c): c is { hit: GeoHit; title: string } => Boolean(c.title && PHOTO_EXT.test(c.title)))
    .sort(
      (a, b) =>
        Number(a.hit.isPrimary) - Number(b.hit.isPrimary) ||
        a.hit.distM - b.hit.distM ||
        a.hit.pageId - b.hit.pageId,
    )
    .slice(0, REFS_PER_PLACE)
    .map((c) => c.title);
}

/**
 * The staged record one polygon becomes, or nothing when no contained file survived selection — the
 * template's orphan guard: a record with no refs would publish nothing and still join an entity.
 *
 * `category`, `subcategory` and `point` are the parent's own, verbatim — the span-inflation reasoning
 * `StagedIdentity.derivedFrom` records. No `name`, no description: this source says nothing *about*
 * the place; it only offers photos taken inside it.
 */
export function stagedFromGeo(
  candidate: GeoCandidate,
  titles: ReadonlyMap<number, string>,
): StagedRow | undefined {
  const picks = pickGeoRefs(candidate.hits, titles);
  if (picks.length === 0) return undefined;
  return {
    source: COMMONS_SOURCE,
    sourceId: candidate.sourceId,
    category: candidate.category,
    ...(candidate.subcategory ? { subcategory: candidate.subcategory } : {}),
    point: candidate.point,
    mediaRefs: picks.map((title) => ({
      kind: "commons-file",
      value: commonsFileTitle(title),
      claimedBy: GEO_CLAIMER,
    })),
    upstreamIds: [],
    derivedFrom: recordRef(candidate),
    // Build-side provenance: which dump rows put these files here, so a human can ask why.
    raw: { pages: candidate.hits.map((hit) => hit.pageId).join(" ") },
  };
}

/**
 * Load the dump (when named), resolve the category listings, run the containment join, stage the
 * records. Durable per batch throughout — an interrupted run keeps its work.
 */
export async function stageCommonsGeo(
  db: Querier,
  opts: CommonsGeoOptions,
): Promise<CommonsGeoReport> {
  const report = emptyReport();
  if (opts.dump !== undefined) {
    if (opts.dryRun) {
      opts.log(`--dry-run: not loading ${opts.dump}`);
    } else {
      report.loaded = await loadGeoDump(db, opts.dump, opts.log);
      await recordInput(db, {
        source: "commons-geo",
        path: opts.dump,
        now: opts.now(),
        onHash: (path) => opts.log(`hashing ${path} …`),
      });
    }
  }

  await resolveCategories(db, report, opts);

  report.overCap = await overCapPolygons(db, {
    excludeCategory: IMAGERY_EXCLUDED_CATEGORY,
    areaCapM2: GEO_AREA_CAP_M2,
  });

  /** Page ids this run has resolved → title, absent, or `undefined` for never-answered. */
  const seen = new Map<number, GeoPageRow | undefined>();
  let cursor: RecordRef | undefined;
  for (;;) {
    const page = await fetchGeoCandidates(db, {
      limit: PAGE_SIZE,
      ...(cursor ? { after: cursor } : {}),
      excludeCategory: IMAGERY_EXCLUDED_CATEGORY,
      areaCapM2: GEO_AREA_CAP_M2,
      hitCap: HIT_CAP,
    });
    if (page.length === 0) break;
    cursor = recordRef(page[page.length - 1]!);
    report.polygons += page.length;
    const withHits = page.filter((candidate) => candidate.hits.length > 0);
    report.withHits += withHits.length;

    const pageIds = [...new Set(withHits.flatMap((c) => c.hits.map((h) => h.pageId)))];
    await resolvePages(db, pageIds, seen, report, opts);

    // Only this page's ids — `seen` is the whole run's cache, and most of it is other pages'.
    const titles = new Map<number, string>();
    for (const id of pageIds) {
      const title = seen.get(id)?.title;
      if (title) titles.set(id, title);
    }
    const staged = withHits
      .map((candidate) => stagedFromGeo(candidate, titles))
      .filter((row): row is StagedRow => row !== undefined);
    report.staged += staged.length;
    report.refs += staged.reduce((sum, row) => sum + row.mediaRefs.length, 0);
    if (!opts.dryRun) await writeStaged(db, staged, opts.now());

    opts.log(
      `${report.polygons} polygon(s) walked · ${report.withHits} with contained files · ` +
        `${report.staged} staged`,
    );
    if (page.length < PAGE_SIZE) break;
  }
  return report;
}

/**
 * Resolve every distinct `wikimedia_commons=Category:…` reference to its file listing, durably.
 *
 * One category per paced request (the API offers no batch here), written every
 * {@link CATEGORY_WRITE_BATCH} answers. An unanswered category writes nothing — it stays a candidate
 * for the next run, the three-state contract every cache in this pipeline keeps.
 */
async function resolveCategories(
  db: Querier,
  report: CommonsGeoReport,
  opts: CommonsGeoOptions,
): Promise<void> {
  const referenced = [
    ...new Set((await distinctCategoryRefs(db)).map(commonsCategoryTitle)),
  ].sort();
  report.categories = referenced.length;
  const known = opts.refresh ? new Set<string>() : await knownCategories(db, referenced);
  report.categoriesKnown = known.size;
  const todo = referenced.filter((category) => !known.has(category));

  let pending: CommonsCategoryRow[] = [];
  const flush = async (): Promise<void> => {
    if (!opts.dryRun) await writeCommonsCategories(db, pending, opts.now());
    pending = [];
  };
  for (const category of todo) {
    const answer = await opts.client.categoryFiles(category);
    if (answer.unavailable) {
      report.categoriesUnanswered += 1;
      continue;
    }
    // `exists` already folds "no page and no members" — `categoryFiles` owns that judgment.
    const absent = !answer.exists;
    report.categoriesFetched += 1;
    if (absent) report.categoriesAbsent += 1;
    pending.push({ category, members: answer.files, absent });
    if (pending.length >= CATEGORY_WRITE_BATCH) await flush();
  }
  await flush();
  if (todo.length > 0) {
    opts.log(
      `${report.categories} categorie(s) referenced · ${report.categoriesFetched} fetched · ` +
        `${report.categoriesUnanswered} unanswered`,
    );
  }
}

/**
 * Resolve page ids to `File:` titles through the cache, asking Commons only about ids never answered
 * for. Fills `seen` for every id it can; an id Commons never answered stays `undefined` in `seen` (so
 * one run never re-asks it) and unwritten (so the next run does).
 */
async function resolvePages(
  db: Querier,
  pageIds: readonly number[],
  seen: Map<number, GeoPageRow | undefined>,
  report: CommonsGeoReport,
  opts: CommonsGeoOptions,
): Promise<void> {
  const fresh = pageIds.filter((id) => !seen.has(id));
  const known = opts.refresh ? new Map<number, GeoPageRow>() : await readGeoPages(db, fresh);
  for (const [id, row] of known) seen.set(id, row);
  report.pagesKnown += known.size;

  const todo = fresh.filter((id) => !seen.has(id));
  for (let at = 0; at < todo.length; at += BATCH.ids) {
    const slice = todo.slice(at, at + BATCH.ids);
    const answer = await opts.client.titlesForPageIds(slice);
    if (answer.unavailable) {
      report.pagesUnanswered += slice.length;
      for (const id of slice) seen.set(id, undefined);
      continue;
    }
    const rows: GeoPageRow[] = slice
      .filter((id) => answer.titles.has(id) || answer.missing.has(id))
      .map((id) => {
        const title = answer.titles.get(id);
        return { pageId: id, absent: title === undefined, ...(title ? { title } : {}) };
      });
    report.pagesFetched += rows.filter((row) => !row.absent).length;
    report.pagesAbsent += rows.filter((row) => row.absent).length;
    if (!opts.dryRun) await writeGeoPages(db, rows, opts.now());
    for (const row of rows) seen.set(row.pageId, row);
    for (const id of slice) if (!seen.has(id)) seen.set(id, undefined);
  }
}

// ── the dump loader ───────────────────────────────────────────────────────────────────────────────

/**
 * Column names in dump order, read from the dump's own `CREATE TABLE` — never assumed. MediaWiki has
 * renumbered this table before; parsing positions against a hardcoded order would load garbage
 * coordinates silently, which is the one failure mode a loader must not have.
 */
export function dumpColumns(createBlock: readonly string[]): string[] {
  const cols: string[] = [];
  for (const line of createBlock) {
    const match = /^\s*`(\w+)`/.exec(line);
    if (match?.[1]) cols.push(match[1]);
  }
  return cols;
}

/**
 * The rows of one mysqldump `VALUES (…),(…)` payload, each value a string or SQL `NULL`.
 *
 * A real tokenizer rather than a split: `gt_name` carries file names with quotes and backslashes in
 * them, and a parser that mis-tracks one string boundary shears every row after it. Handles backslash
 * escapes and doubled `''` inside strings; everything else is structure.
 *
 * Unquoted fields — the numeric majority of all ~50M tuples — are taken as **slices**, not built one
 * character at a time; only quoted strings accumulate, because escapes force copying there. The
 * difference is billions of small-string concats on the load's CPU-bound critical path.
 */
export function parseTuples(payload: string): (string | null)[][] {
  const rows: (string | null)[][] = [];
  let fields: (string | null)[] = [];
  let buffer = "";
  /** Span start of the current unquoted field; -1 when none is open. */
  let start = -1;
  let quoted = false;
  let inString = false;
  let inRow = false;

  const endField = (at: number): void => {
    const text = quoted ? buffer : start === -1 ? "" : payload.slice(start, at);
    fields.push(!quoted && text === "NULL" ? null : text);
    buffer = "";
    start = -1;
    quoted = false;
  };

  for (let i = 0; i < payload.length; i++) {
    const char = payload[i]!;
    if (inString) {
      if (char === "\\") {
        buffer += payload[++i] ?? "";
      } else if (char === "'") {
        if (payload[i + 1] === "'") {
          buffer += "'";
          i++;
        } else {
          inString = false;
        }
      } else {
        buffer += char;
      }
      continue;
    }
    if (char === "'") {
      inString = true;
      quoted = true;
    } else if (char === "(" && !inRow) {
      inRow = true;
      fields = [];
    } else if (char === "," && inRow) {
      endField(i);
    } else if (char === ")" && inRow) {
      endField(i);
      rows.push(fields);
      inRow = false;
    } else if (inRow && !quoted && start === -1) {
      start = i;
    }
  }
  return rows;
}

/** Where each needed column sits in a dump tuple — derived from the dump's own `CREATE TABLE`. */
export interface DumpColumnAt {
  pageId: number;
  globe: number;
  primary: number;
  lat: number;
  lon: number;
}

/** One dump tuple as a row to keep, or nothing — wrong globe, missing or out-of-range coordinates. */
export function geoTagOf(
  tuple: readonly (string | null)[],
  at: DumpColumnAt,
): GeoTagRow | undefined {
  if (tuple[at.globe] !== "earth") return undefined;
  const pageId = Number(tuple[at.pageId]);
  const lat = Number(tuple[at.lat]);
  const lon = Number(tuple[at.lon]);
  if (!Number.isInteger(pageId) || pageId <= 0) return undefined;
  if (tuple[at.lat] === null || tuple[at.lon] === null) return undefined;
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return undefined;
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return undefined;
  return { pageId, isPrimary: tuple[at.primary] === "1", lat, lon };
}

/**
 * Stream the gzipped dump into `commons_geo_tags`, replacing whatever load came before.
 *
 * The gist index is dropped for the load and rebuilt after — inserting twenty-odd million rows under
 * it measured ~3× slower than rebuilding it once.
 */
async function loadGeoDump(
  db: Querier,
  path: string,
  log: (message: string) => void,
): Promise<{ rows: number; skipped: number }> {
  await clearCommonsGeoTags(db);
  log(`loading ${path} — the gist index rebuilds when the load finishes`);

  const lines = createInterface({
    input: createReadStream(path).pipe(createGunzip()),
    crlfDelay: Number.POSITIVE_INFINITY,
  });

  let createBlock: string[] | undefined;
  let at: DumpColumnAt | undefined;
  let batch: GeoTagRow[] = [];
  let rows = 0;
  let skipped = 0;

  const flush = async (): Promise<void> => {
    await writeCommonsGeoTags(db, batch);
    rows += batch.length;
    if (rows % 1_000_000 < batch.length) log(`${(rows / 1e6).toFixed(0)}M rows loaded …`);
    batch = [];
  };

  for await (const line of lines) {
    if (line.startsWith("CREATE TABLE")) {
      createBlock = [];
      continue;
    }
    if (createBlock && !at) {
      if (line.startsWith(")")) {
        const cols = dumpColumns(createBlock);
        const index = (name: string): number => {
          const found = cols.indexOf(name);
          if (found === -1) throw new Error(`${path}: CREATE TABLE lists no ${name} column`);
          return found;
        };
        at = {
          pageId: index("gt_page_id"),
          globe: index("gt_globe"),
          primary: index("gt_primary"),
          lat: index("gt_lat"),
          lon: index("gt_lon"),
        };
      } else {
        createBlock.push(line);
      }
      continue;
    }
    if (!at || !line.startsWith("INSERT INTO")) continue;
    const from = line.indexOf("VALUES ");
    if (from === -1) continue;
    for (const tuple of parseTuples(line.slice(from + 7))) {
      const row = geoTagOf(tuple, at);
      if (row) batch.push(row);
      else skipped += 1;
      if (batch.length >= LOAD_BATCH) await flush();
    }
  }
  await flush();
  if (!at) throw new Error(`${path}: no geo_tags CREATE TABLE found — is this the right dump?`);

  log(`rebuilding the point index over ${rows} rows …`);
  await finishCommonsGeoTags(db);
  return { rows, skipped };
}
