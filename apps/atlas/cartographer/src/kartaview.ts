/**
 * The KartaView source — street-level photos aimed at a place, staged as `kartaview` records; the
 * Atlas half of `apps/atlas/doc/spec/sources.md` §3's street-imagery slot.
 *
 * **KartaView-first is a measured inversion of §3's original ordering** (the measurements are in
 * §3). Panoramax — the slot's named first choice — matched 2 of 60 photo-less point places in the
 * four best-covered us-west cities, and half its picks were 360° panos needing reprojection nothing
 * else needs. KartaView's older dashcam archive matched 30/60 within 35 m and 9/60 through the aim
 * gate, in flat frames with plates and faces already blurred upstream. Panoramax stays deferred
 * with a coverage-growth trigger, not rejected.
 *
 * **The licence is the corpus's, verified, not assumed** (the RIDB lesson): KartaView's terms grant
 * CC BY-SA 4.0 across the imagery. The API is anonymous — no key, no client id — so no platform
 * terms bind us beyond the imagery licence itself, which is the exact clause-by-clause problem that
 * keeps Mapillary out of Atlas (`apps/atlas/doc/spec/sources.md` §4). Attribution is to the
 * contributors collectively (the API exposes no per-photo author), with every published photo's
 * credit linking its own KartaView details page, where the uploader is shown.
 *
 * **The aim gate is the honest part.** A dashcam photo *near* a place is a photo of the street —
 * `apps/atlas/doc/spec/sources.md` §3's Panoramax correction, measured again here. A hit passes
 * only when the camera's recorded heading points within {@link BEARING_TOLERANCE_DEG} of the place;
 * no heading, no pick. What survives is floor-tier by design (§5 ranks it last, below even a
 * containment find): a 2017 storefront may have changed tenants, which is the staleness §3 accepts
 * as "a mediocre photo beats none" — thumb confidently, full cautiously.
 *
 * **The sweep resumes at two granularities.** The sequence listing is one cheap bbox-paged pass; the
 * slow half (one photo listing per sequence, against a ~3.5 s/request API with no bulk product) marks
 * each sequence held as it lands, so `--limit N` bounds a run to N sequences and the next run
 * continues where it stopped. The join then runs entirely locally, like commons-geo's.
 */
import {
  fetchKartaviewCandidates,
  KARTAVIEW_SOURCE,
  recordRef,
  kartaviewSweepStats,
  stagedCells,
  unfetchedKartaviewSequences,
  writeKartaviewPhotos,
  writeKartaviewSequences,
  writeStaged,
  type KartaviewCandidate,
  type KartaviewHit,
  type KartaviewPhoto,
  type KartaviewSequence,
  type Querier,
  type RecordRef,
  type StagedRow,
} from "./store";
import { IMAGERY_EXCLUDED_CATEGORY } from "./commons-geo";

/** Who a street photo is claimed by — stage 4 ranks it last of all (`apps/atlas/doc/spec/sources.md` §5's floor). */
export const KARTAVIEW_CLAIMER = KARTAVIEW_SOURCE;

export { KARTAVIEW_SOURCE };

/** How far a camera may stand from the place's point. Past ~35 m a storefront is scenery. */
export const KARTAVIEW_RADIUS_M = 35;

/**
 * How far off the camera's heading may point from the camera→place bearing. Generous half-fov for
 * phone and dashcam lenses (the probe's sequences report ~62° horizontal fov), tight enough that a
 * camera driving *past* the place — heading perpendicular to it — fails.
 */
export const BEARING_TOLERANCE_DEG = 50;

/** Refs staged per place — street frames are the floor tier; two candidates is plenty. */
const REFS_PER_PLACE = 2;

/** Nearby photos fetched per record — enough to survive the aim gate on a busy street. */
const HIT_CAP = 24;

/** Primary records per join page. */
const PAGE_SIZE = 5_000;

/**
 * Listing/photo page sizes, and the pause between paced requests.
 *
 * The API's stated `itemsPerPage` maximum is 150, but its **timeout scales with the page, not the
 * bbox** — measured: 150 rows timed out on a tiny bbox while 1 row answered for 5°, and 100 answered
 * minutes later. Sequence rows are heavy (dozens of fields hydrated per row), so the listing stays
 * well under the knee rather than riding it. The interval exists so a fast day is still polite.
 */
const SEQUENCE_PAGE = 50;
const PHOTO_PAGE = 100;
const API_INTERVAL_MS = 250;

/** Backoff before re-asking a declinable answer — used only by the photos pass, where a known-dense
 *  query declining is their load wobbling and a re-ask usually lands. The listing never retries: a
 *  decline there usually *means empty*, at ~26 s of their server timeout apiece. */
const RETRY_BACKOFF_MS = [3_000, 9_000] as const;

/** The `sleep` default, once — three functions pace against it. */
const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The listing tile is exactly one staged 1° cell, and a declined cell is skipped, not subdivided.
 *
 * Three measured facts shape this. The API refuses a continent bbox outright. Its "query timeout —
 * narrow your filter" (apiCode 408) fires **persistently on empty regions at any size** — proving
 * absence full-scans their table, and the timeout itself costs ~26 s server-side before answering —
 * while a dense city cell answers in ~1.6 s. And there is no non-spatial listing (state/country
 * filters answer "Restricted access!"). So subdividing a declined tile multiplies 26-second waits
 * over emptiness, and retrying triples them: the sweep reads a declined cell as *probably empty*,
 * counts it in the report, and lets the next `--sweep` re-ask — the listing is cheap to re-run and
 * the upsert is cumulative, which is what heals the rare dense cell declined during a load spike.
 */
const LIST_TILE_DEG = 1;

const API = "https://api.openstreetcam.org/2.0";

/** The human page a published credit links — where KartaView shows the photo and its uploader. */
export function kartaviewDetailsUrl(sequenceId: number, sequenceIndex?: number): string {
  return `https://kartaview.org/details/${sequenceId}/${sequenceIndex ?? 0}`;
}

/** Degrees between two bearings, shortest way round. */
export function angleDiff(a: number, b: number): number {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

/**
 * The refs one record's nearby photos become — the aim gate, pure and in one place.
 *
 * A photo with no recorded heading never passes: distance alone is the dashcam trap this slice's
 * whole design exists to avoid. Survivors order by angular error (the most squarely-aimed frame is
 * the most likely to actually show the place), then distance, then photo id for determinism.
 */
export function pickKartaviewRefs(hits: readonly KartaviewHit[]): string[] {
  return hits
    .flatMap((hit) => {
      if (hit.heading === undefined) return [];
      const error = angleDiff(hit.heading, hit.toPlace);
      return error <= BEARING_TOLERANCE_DEG ? [{ hit, error }] : [];
    })
    .sort((a, b) => a.error - b.error || a.hit.distM - b.hit.distM || a.hit.photoId - b.hit.photoId)
    .slice(0, REFS_PER_PLACE)
    .map((pick) => pick.hit.url);
}

/**
 * The staged record one candidate becomes, or nothing when no nearby frame passed the gate — the
 * template's orphan guard. Photos-only, like the commons records: no name, no prose, category and
 * point copied verbatim, `derivedFrom` naming the parent.
 */
export function stagedFromKartaview(candidate: KartaviewCandidate): StagedRow | undefined {
  const picks = pickKartaviewRefs(candidate.hits);
  if (picks.length === 0) return undefined;
  return {
    source: KARTAVIEW_SOURCE,
    sourceId: candidate.sourceId,
    category: candidate.category,
    ...(candidate.subcategory ? { subcategory: candidate.subcategory } : {}),
    point: candidate.point,
    mediaRefs: picks.map((url) => ({ kind: "url", value: url, claimedBy: KARTAVIEW_CLAIMER })),
    upstreamIds: [],
    derivedFrom: recordRef(candidate),
    // Build-side provenance: which catalog frames were considered, so a human can ask why.
    raw: { photos: candidate.hits.map((hit) => hit.photoId).join(" ") },
  };
}

export interface KartaviewReport {
  /** Listing pages walked and sequences newly listed — only under `--sweep`. */
  listPages: number;
  sequencesListed: number;
  /** Cells the API declined — probably empty (the 26-second 408), healed by the next `--sweep`. */
  tilesSkipped: number;
  /** A bounded sweep left backlog, so the join did not run — the next drain would overwrite it. */
  joinSkipped: boolean;
  /** Sequences whose photos landed this run, and photos written. */
  sequencesFetched: number;
  photosFetched: number;
  /** The catalog after this run: sequences held / total listed, photos total. */
  sequencesHeld: number;
  sequencesTotal: number;
  photosTotal: number;
  /** The join. */
  candidates: number;
  withNearby: number;
  staged: number;
  refs: number;
}

const emptyReport = (): KartaviewReport => ({
  listPages: 0,
  sequencesListed: 0,
  tilesSkipped: 0,
  joinSkipped: false,
  sequencesFetched: 0,
  photosFetched: 0,
  sequencesHeld: 0,
  sequencesTotal: 0,
  photosTotal: 0,
  candidates: 0,
  withNearby: 0,
  staged: 0,
  refs: 0,
});

export interface KartaviewOptions {
  /** Run the API sweep (listing + photo pass) before the join. Omit to re-join what is held. */
  sweep: boolean;
  /** Bound on sequences whose photos this run fetches — the slow half's resumable budget. */
  limit: number;
  dryRun: boolean;
  /** The same contact-carrying UA policy every outbound call follows. */
  userAgent: string;
  fetchImpl?: typeof fetch;
  now: () => string;
  log: (message: string) => void;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * List (when asked), drain the photo backlog, then join the catalog against every primary record and
 * stage the survivors.
 *
 * The photo pass runs whenever unfetched sequences exist, `--sweep` or not — `media` sets the
 * precedent of draining a known backlog without a flag. `--sweep` controls only the *listing*,
 * because that is the half with a real cost decision in it (~26 s per empty cell), while the backlog
 * is work already committed to.
 */
export async function stageKartaview(
  db: Querier,
  opts: KartaviewOptions,
): Promise<KartaviewReport> {
  const report = emptyReport();
  if (opts.sweep) await listSequences(db, report, opts);
  if (!opts.dryRun) await fetchPhotoBacklog(db, report, opts);

  const stats = await kartaviewSweepStats(db);
  report.sequencesTotal = stats.sequences;
  report.sequencesHeld = stats.fetched;
  report.photosTotal = stats.photos;

  // A `--limit`-bounded sweep that left backlog skips the join: its result would be overwritten by
  // the next drain run anyway, and the join is minutes of PostGIS per pass. A run *without* `--sweep`
  // always joins — that is the documented re-join mode, partial catalog and all.
  if (opts.sweep && report.sequencesHeld < report.sequencesTotal) {
    report.joinSkipped = true;
    opts.log("backlog remains — join skipped; drain it with --limit runs, or run without --sweep");
    return report;
  }

  let cursor: RecordRef | undefined;
  for (;;) {
    const page = await fetchKartaviewCandidates(db, {
      limit: PAGE_SIZE,
      ...(cursor ? { after: cursor } : {}),
      excludeCategory: IMAGERY_EXCLUDED_CATEGORY,
      radiusM: KARTAVIEW_RADIUS_M,
      hitCap: HIT_CAP,
    });
    if (page.length === 0) break;
    cursor = recordRef(page[page.length - 1]!);
    report.candidates += page.length;
    const withNearby = page.filter((candidate) => candidate.hits.length > 0);
    report.withNearby += withNearby.length;

    const staged = withNearby
      .map(stagedFromKartaview)
      .filter((row): row is StagedRow => row !== undefined);
    report.staged += staged.length;
    report.refs += staged.reduce((sum, row) => sum + row.mediaRefs.length, 0);
    if (!opts.dryRun) await writeStaged(db, staged, opts.now());

    opts.log(
      `${report.candidates} record(s) walked · ${report.withNearby} with nearby frames · ` +
        `${report.staged} staged`,
    );
    if (page.length < PAGE_SIZE) break;
  }
  return report;
}

/** The listing, one staged cell at a time ({@link LIST_TILE_DEG} has the economics). `tLeft`/
 * `bRight` are `lat,lng` corner pairs — the one bbox spelling the API accepts. A sequence
 * straddling cells is listed by each and deduped by the upsert; a declined cell discards nothing,
 * because every page that DID answer was written before the decline. */
async function listSequences(
  db: Querier,
  report: KartaviewReport,
  opts: KartaviewOptions,
): Promise<void> {
  const pause = opts.sleep ?? defaultSleep;
  // The listing covers the 1° cells that hold staged places — no config, nothing to get stale, and
  // never a bbox over the ocean (whose emptiness this API times out proving).
  const cells = await stagedCells(db);
  if (cells.length === 0) {
    throw new Error("nothing staged yet — run normalize before a kartaview sweep");
  }
  for (const [at, cell] of cells.entries()) {
    for (let pageAt = 1; ; pageAt++) {
      const answer = await getJson(
        `${API}/sequence/?tLeft=${cell.south + LIST_TILE_DEG},${cell.west}` +
          `&bRight=${cell.south},${cell.west + LIST_TILE_DEG}` +
          `&itemsPerPage=${SEQUENCE_PAGE}&page=${pageAt}`,
        opts,
        0,
      );
      report.listPages += 1;
      if (answer.kind === "declined") {
        report.tilesSkipped += 1;
        break;
      }
      const sequences: KartaviewSequence[] = (answer.body.result?.data ?? []).flatMap((s) => {
        const sequenceId = Number(s.id);
        const photoCount = Number(s.countActivePhotos);
        if (!Number.isInteger(sequenceId) || !s.storage || !(photoCount > 0)) return [];
        return [{ sequenceId, storage: String(s.storage), photoCount }];
      });
      report.sequencesListed += sequences.length;
      if (!opts.dryRun) await writeKartaviewSequences(db, sequences, opts.now());
      if (answer.body.result?.hasMoreData !== true) break;
      await pause(API_INTERVAL_MS);
    }
    if ((at + 1) % 25 === 0) {
      opts.log(
        `listing: ${at + 1}/${cells.length} cell(s) · ${report.sequencesListed} listed · ` +
          `${report.tilesSkipped} declined (probably empty — a re-sweep re-asks)`,
      );
    }
    await pause(API_INTERVAL_MS);
  }
  opts.log(`${report.sequencesListed} sequence listing(s) over ${report.listPages} page(s)`);
}

/** The slow half. Photos land before the mark, so an interruption between the two re-fetches the
 * sequence rather than losing it. `--limit` bounds this pass, never the listing or the join. */
async function fetchPhotoBacklog(
  db: Querier,
  report: KartaviewReport,
  opts: KartaviewOptions,
): Promise<void> {
  const pause = opts.sleep ?? defaultSleep;
  const todo = await unfetchedKartaviewSequences(db, opts.limit);
  for (const seq of todo) {
    const photos: KartaviewPhoto[] = [];
    let skipped = false;
    for (let pageAt = 1; ; pageAt++) {
      const answer = await getJson(
        `${API}/photo/?sequenceId=${seq.sequenceId}&itemsPerPage=${PHOTO_PAGE}&page=${pageAt}`,
        opts,
      );
      if (answer.kind === "declined") {
        // A single-sequence query has nothing left to narrow — their side is struggling with this
        // one right now. Leave it unmarked (it stays in the work queue for the next run) and move
        // on rather than aborting a pass that is succeeding on everything else.
        opts.log(`sequence ${seq.sequenceId} kept failing — left for the next run`);
        skipped = true;
        break;
      }
      const body = answer.body;
      for (const p of body.result?.data ?? []) {
        const photoId = Number(p.id);
        const lat = Number(p.lat);
        const lon = Number(p.lng);
        const heading = p.heading === null || p.heading === undefined ? NaN : Number(p.heading);
        if (!Number.isInteger(photoId) || !Number.isFinite(lat) || !Number.isFinite(lon)) continue;
        if (p.status !== "active" || p.visibility !== "public" || !p.filepathProc) continue;
        const index = Number(p.sequenceIndex);
        photos.push({
          photoId,
          sequenceId: seq.sequenceId,
          ...(Number.isInteger(index) ? { sequenceIndex: index } : {}),
          lat,
          lon,
          ...(Number.isFinite(heading) ? { heading } : {}),
          // The blurred processed file on the sequence's own storage host — verified live; the bare
          // `kartaview.org/<path>` form answers 200 with the SPA shell instead, which is worse than
          // a 404 because it looks like bytes until sharp refuses it.
          url: `https://${seq.storage}.openstreetcam.org/${String(p.filepathProc)}`,
        });
      }
      if (body.result?.hasMoreData !== true) break;
      await pause(API_INTERVAL_MS);
    }
    if (skipped) continue;
    await writeKartaviewPhotos(db, seq.sequenceId, photos, opts.now());
    report.sequencesFetched += 1;
    report.photosFetched += photos.length;
    if (report.sequencesFetched % 25 === 0) {
      opts.log(
        `${report.sequencesFetched}/${todo.length} sequence(s) fetched · ` +
          `${report.photosFetched} photo(s)`,
      );
    }
    await pause(API_INTERVAL_MS);
  }
}

/** The API's envelope, narrowed to what the sweep reads. */
interface KartaviewEnvelope {
  result?: {
    data?: {
      id?: unknown;
      storage?: unknown;
      countActivePhotos?: unknown;
      lat?: unknown;
      lng?: unknown;
      heading?: unknown;
      sequenceIndex?: unknown;
      status?: unknown;
      visibility?: unknown;
      filepathProc?: unknown;
    }[];
    hasMoreData?: boolean;
  };
}

/**
 * One JSON GET, with the API's recoverable refusals made a value.
 *
 * Two shapes come back as `declined` rather than throwing: "query timeout — narrow your filter"
 * (apiCode 408 inside an HTTP 400 — how this API says both "too heavy" and, persistently, "empty"),
 * and any 5xx — measured live, a page that answered four times can 500 on the fifth, and an
 * acquisition measured in hours must not abort on one. What `declined` means is the caller's call:
 * the listing skips the cell, the photos pass leaves the sequence queued. Everything else throws
 * and aborts the sweep whole — the durable marks keep what is held, and a partially-listed page is
 * nothing worth recording (the nps stage's reasoning).
 */
async function getJson(
  url: string,
  opts: KartaviewOptions,
  /** How many times a declinable answer is re-asked before it comes back as `declined`. The photos
   *  pass retries ({@link RETRY_BACKOFF_MS} — a known-dense query declining is their load wobbling);
   *  the listing passes 0, because there a decline usually *means empty* at ~26 s apiece. */
  retries: number = RETRY_BACKOFF_MS.length,
): Promise<{ kind: "ok"; body: KartaviewEnvelope } | { kind: "declined" }> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const pause = opts.sleep ?? defaultSleep;
  for (let attempt = 0; ; attempt++) {
    const res = await fetchImpl(url, {
      headers: { "User-Agent": opts.userAgent, accept: "application/json" },
      signal: AbortSignal.timeout(120_000),
    });
    if (res.status === 429) {
      throw new Error("KartaView rate-limited the sweep (HTTP 429) — wait and re-run; it resumes");
    }
    if (res.ok) return { kind: "ok", body: (await res.json()) as KartaviewEnvelope };

    let apiCode: number | undefined;
    let apiMessage = "";
    try {
      const body = (await res.json()) as { status?: { apiCode?: number; apiMessage?: string } };
      apiCode = body.status?.apiCode;
      apiMessage = body.status?.apiMessage ?? "";
    } catch {
      // Not JSON — a bare 5xx still lands in the declinable branch below.
    }
    if (apiCode === 408 || res.status >= 500) {
      const wait = attempt < retries ? RETRY_BACKOFF_MS[attempt] : undefined;
      if (wait !== undefined) {
        await pause(wait);
        continue;
      }
      return { kind: "declined" };
    }
    throw new Error(
      `KartaView answered ${res.status}${apiMessage ? ` (${apiMessage})` : ""} for ${url} — ` +
        "nothing lost, re-run",
    );
  }
}
