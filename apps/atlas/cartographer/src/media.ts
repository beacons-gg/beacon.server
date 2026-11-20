/**
 * Stage 4 — the media crawl. `apps/atlas/doc/spec/cartographer.md` §1.4.
 *
 * **The slow stage, and the reason the whole architecture exists.** A Beacon server used to resolve
 * place images inline during a snapshot, hit Wikimedia's per-IP throttle on image *bytes*, and
 * record the deferral as "this place has no photo" — permanently, because nothing distinguished a
 * give-up from an answer (`apps/atlas/doc/spec/cartographer.md` §1.4, fixed in `921d2ae`). Moving
 * the crawl offline is what makes a failed fetch a scheduled retry instead of a fact.
 *
 * So every rule here is about not losing that distinction:
 *
 * - A file is keyed by **the file**, not by the place or by the reference that named it. One logo shared by
 *   200 stores is one fetch; a `wikidata` P18 and a `wikimedia_commons` tag naming the same Commons title
 *   collapse onto one row.
 * - A throttled or timed-out fetch is written `retryable` with a time to try again. Only an answer — a 404,
 *   an unfree licence, an oversize file — is terminal.
 * - Nothing is resolved that would need a network call to reproduce. P18 comes from the concordance's
 *   cached claims; a QID with no concordance row is *not asked*, never "no photo".
 * - The bytes fetched are never larger than the original (`byteUrl`), because MediaWiki will
 *   happily upscale and `apps/atlas/doc/spec/sources.md` §3 forbids publishing an upscale.
 */
import {
  commonsCategoryTitle,
  commonsFileTitle,
  commonsFileTitleFromUrl,
} from "@beaconsgg/place-taxonomy";
import { SOURCE_TERMS, type SourceId } from "./fields";
import { categoryLead, GEO_CLAIMER } from "./commons-geo";
import { imageClaim, logoClaim } from "./concordance";
import { KARTAVIEW_CLAIMER, KARTAVIEW_SOURCE, kartaviewDetailsUrl } from "./kartaview";
import { NPS_CLAIMER, NPS_SOURCE, pdCredit } from "./nps";
import { fedCredit, RIDB_CLAIMER, RIDB_SOURCE } from "./ridb";

import { WIKI_CLAIMER } from "./wikipedia";
import { WEBP_QUALITY, sharpResizer } from "@beaconsgg/image-encode";
import { PLACE_FULL_PX, PLACE_THUMB_PX } from "@beaconsgg/protocol-types";
import { blobPath, hashBytes } from "@beaconsgg/atlas-volume";
import { byteUrl, type CommonsFile, type WikimediaClient } from "@beaconsgg/wikimedia";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  COMMONS_SOURCE,
  CONTRIB_SOURCE,
  OSM_SOURCE,
  fetchEntityMediaRefs,
  fetchRetryableMedia,
  mediaCoverageByCategory,
  placesWithMedia,
  readCommonsCategories,
  readConcordance,
  readContribImageMeta,
  readKartaviewImageMeta,
  readMediaFiles,
  readNpsImageMeta,
  readRidbImageMeta,
  writeMediaFiles,
  writePlaceMedia,
  type ContribImageMeta,
  type KartaviewImageMeta,
  type MediaFileRow,
  type MediaRef,
  type NpsImageMeta,
  type PlaceMediaLink,
  type Querier,
  type RidbImageMeta,
} from "./store";
/** Entities per page. Smaller than stage 3's: each page does paced network work, so a page is a batch. */
const PAGE_SIZE = 500;

/** Commons titles per metadata request — MediaWiki's anonymous cap, and verified to work with a width. */
const METADATA_BATCH = 50;

// `COMMONS_SOURCE` — the source id every Wikimedia-hosted photo carries, whatever reference led us to
// it — moved to `store.ts` when the geo stage began staging records under the same id.

/**
 * How long to wait before retrying a file that was never answered for.
 *
 * Deliberately coarse. The point is not to tune a backoff — the client already honours `Retry-After` within
 * a run — but to keep a `--retry` pass minutes later from re-hitting a host that is still shedding load.
 */
const RETRY_AFTER_MS = 30 * 60 * 1000;

/**
 * `apps/atlas/doc/spec/sources.md` §5's photo ranking, as a rank per `(kind, claimedBy)`. Lower is
 * better.
 *
 * Keyed by both because two of §5's tiers share a `kind`: a mapper's `wikimedia_commons=File:` and an
 * article's lead image are both `commons-file`, so ranking on kind alone would silently collapse them.
 *
 * **A mapper's own file first, then P18, then the article lead.** The chain's own principle is that a photo
 * a human chose *of* the place beats one taken near it, and a `wikimedia_commons=` tag is the most local
 * form of that choice; §5 then puts `Wikidata P18` explicitly **above** `Wikipedia lead`, because P18 is an
 * image of the *subject* while an article's `pageimage` was chosen to illustrate an *article*.
 *
 * The article lead used to sit first here, on the grounds that the enrichment job had already verified it on
 * Commons and only produced one where the mapper had named nothing. Both of those stopped being true when
 * that job was absorbed — verification moved to stage 4 and the gate was deleted — so the order it justified
 * went with them. Measured on us-west: 201 places carry an article lead, 199 of them also a QID, so this is
 * the pair that actually decides.
 *
 * **The Park Service's own shot heads the whole chain** — §5's first entry, "NPS / RIDB (PD)": the
 * owner photographing their own place is the strongest form of "a human chose a photo *of* it", and
 * public domain is the lightest obligation a consumer can inherit (`apps/atlas/doc/spec/sources.md`
 * §5).
 *
 * **A category lead sits between the mapper's file and P18.** §5 ranks "Commons category lead" second in
 * the corpus chain, and both tags are the same mapper's choice — but naming a *file* is the sharper claim
 * (this photo) where a category names a set we pick a lead from, so the file keeps its edge. **The geo
 * stage's containment finds rank last**, below even a mapper's bare `image=` URL: every tier above it is
 * a human choosing a photo of the place, and containment is only geometry agreeing a camera stood inside
 * it.
 */
const RANK: Partial<Record<`${MediaRef["kind"]}:${string}`, number>> = {
  [`url:${NPS_CLAIMER}`]: 1,
  // A player's own photo, taken at the place, for this dataset. The only tier where somebody chose
  // both the subject and the purpose — above a mapper's tagged Commons file, below the two federal
  // owners whose corpora are professionally shot and licence-verified per image. It is also the
  // only photo the emptiest categories will ever get: `park` and `nature` are 128k places at
  // single-digit coverage, and nothing institutional reaches them. The review console is the
  // safety net this ranking leans on.
  [`url:${CONTRIB_SOURCE}`]: 3,
  // RIDB rides just below NPS — the same owner's-own-shot argument, but recreation.gov's photo pool
  // is operational (site markers, maps) where the NPS corpus is curated photography.
  [`url:${RIDB_CLAIMER}`]: 2,
  [`commons-file:${OSM_SOURCE}`]: 4,
  [`commons-category:${OSM_SOURCE}`]: 5,
  [`wikidata:${OSM_SOURCE}`]: 6,
  [`commons-file:${WIKI_CLAIMER}`]: 7,
  [`url:${OSM_SOURCE}`]: 8,
  [`commons-file:${GEO_CLAIMER}`]: 9,
  // A brand's logo sits below the containment find — a photo proven taken inside THE place beats a
  // generic corporate mark — and above every street frame: for a chain shop the crisp logo is the
  // better card than a dashcam's view of it.
  [`brand-wikidata:${OSM_SOURCE}`]: 10,
  // The floor, below even the logo: a street frame only points at the place from the road
  // (`apps/atlas/doc/spec/sources.md` §5 — street imagery is the tail that runs when everything
  // else came up empty).
  [`url:${KARTAVIEW_CLAIMER}`]: 11,
};

/**
 * Where a ref sits in the ranking; an unranked claimant sorts last and is **not published**.
 *
 * The keys are built from the claimant constants rather than typed out, because the failure is quiet: a
 * changed `OSM_SOURCE` would make every ref `unrankedSource`, which the report counts but which publishes
 * zero photos. The `kind` half is compile-checked; the claimant half cannot be, since `MediaRef.claimedBy`
 * is a free string that any future source may set — which is why `unrankedSource` is reported by name.
 */
function rankOf(ref: MediaRef): number {
  return RANK[`${ref.kind}:${ref.claimedBy}`] ?? Number.MAX_SAFE_INTEGER;
}

/** What a reference resolved to, or why it did not. */
type Resolution =
  | { kind: "file"; fileKey: string; title: string; rank: number }
  | { kind: "skipped"; why: SkipReason };

/**
 * Why a reference yielded no file — counted, never silently dropped.
 *
 * `notAsked` is the one that matters: it means the concordance (or the category cache) holds no row for
 * the reference, which is *absent knowledge*, not absent photo. It is reported separately so a re-run can
 * fix it, and it is why `media_refs` referencing 29,094 QIDs against a 28,877-row concordance is visible
 * rather than invisible. `noLead` is a category answered about whose listing yields nothing publishable —
 * empty, absent, or all PDFs and maps. `noLogo` is a brand answered about with no P154 — and deliberately
 * no P18 fallback, which for a brand is typically the company headquarters.
 */
export type SkipReason =
  "notAsked" | "noP18" | "noLead" | "noLogo" | "foreignHost" | "unrankedSource";

/** A file key namespaces its source, so no source's ids can collide with Commons' title space. */
export function commonsKey(title: string): string {
  return `${COMMONS_SOURCE}:${commonsFileTitle(title)}`;
}

/** A cache-backed arm's file key — the source is the namespace, and the key IS the router:
 *  `--retry` has nothing else to route by. */
export function cachedKey(source: SourceId, url: string): string {
  return `${source}:${url}`;
}

/**
 * The local indexes a resolution consults — every map keeps the same presence/value contract: a key
 * **present** with `undefined` is an answer ("asked, and there is none"), a key **absent** was never
 * asked. A bag rather than positional parameters since the third index arrived: two same-typed maps
 * already compiled transposed, and each future cache would have widened the signature again.
 */
export interface ResolveIndexes {
  /** QID → P18 filename, from the concordance. */
  p18: Map<string, string | undefined>;
  /** `Category:Name` → lead file title, from the category cache. */
  categoryLeads: Map<string, string | undefined>;
  /** Brand QID → P154 filename, from the concordance — never P18 (a brand's P18 is its HQ). */
  logos: Map<string, string | undefined>;
}

/**
 * Turn one reference into a file to fetch, using only what is already known locally.
 *
 * The indexes' shared contract is what preserves the distinction this stage exists for: a reference
 * whose key was never asked is *absent knowledge* (`notAsked`, a re-run fixes it), never "no photo".
 */
export function resolveRef(ref: MediaRef, indexes: ResolveIndexes): Resolution {
  const rank = rankOf(ref);
  if (rank === Number.MAX_SAFE_INTEGER) return { kind: "skipped", why: "unrankedSource" };
  /** The indexes' shared contract, implemented once: absent = never asked; empty = asked, none. */
  const fromIndex = (
    index: Map<string, string | undefined>,
    key: string,
    whyNone: SkipReason,
  ): Resolution => {
    if (!index.has(key)) return { kind: "skipped", why: "notAsked" };
    const file = index.get(key);
    if (!file) return { kind: "skipped", why: whyNone };
    const title = commonsFileTitle(file);
    return { kind: "file", fileKey: commonsKey(title), title, rank };
  };
  switch (ref.kind) {
    case "commons-file": {
      const title = commonsFileTitle(ref.value);
      return { kind: "file", fileKey: commonsKey(title), title, rank };
    }
    case "commons-category":
      return fromIndex(indexes.categoryLeads, commonsCategoryTitle(ref.value), "noLead");
    case "wikidata":
      return fromIndex(indexes.p18, ref.value, "noP18");
    case "brand-wikidata":
      return fromIndex(indexes.logos, ref.value, "noLogo");
    case "url": {
      // A cached-arm claimer's URL routes to its own arm: the host is the source's own, the licence
      // is the source's to gate, and the "title" is the URL itself — there is no other name to give
      // it. Membership comes from the registry, so a new arm cannot forget this site.
      if (CACHED_ARM_SOURCES.has(ref.claimedBy)) {
        return {
          kind: "file",
          fileKey: cachedKey(ref.claimedBy as SourceId, ref.value),
          title: ref.value,
          rank,
        };
      }
      // Otherwise only a Wikimedia-hosted URL, and then only because it names a Commons file whose
      // licence we can read per file — `apps/atlas/doc/spec/sources.md` §3's rule. A city's own
      // photo server asserts no licence at all, so it is a refusal with a reason, not a file we
      // might publish later.
      const title = commonsFileTitleFromUrl(ref.value);
      return title
        ? { kind: "file", fileKey: commonsKey(title), title, rank }
        : { kind: "skipped", why: "foreignHost" };
    }
  }
}

/**
 * The concordance's image and logo claims, as `QID → filename | undefined` — two of the resolve
 * indexes from one read.
 *
 * **Presence in a map is the answer to a different question than the value.** A QID with a `undefined`
 * value was asked about and has no image (or logo); a QID *absent* from the map was never asked.
 * Reading the claims through `imageClaim`/`logoClaim` keeps the P-numbers in `concordance.ts`, which
 * is the only file that knows Wikidata has them.
 */
export async function concordanceIndexes(
  db: Querier,
): Promise<Pick<ResolveIndexes, "p18" | "logos">> {
  const p18 = new Map<string, string | undefined>();
  const logos = new Map<string, string | undefined>();
  // One read builds both maps: the table's claims blobs are the crawl's largest local read, and the
  // two indexes cover the identical key set. NOT a pid-filtered read (`readConcordance(db, pid)`) —
  // that ships only the positive population, and presence-with-`undefined` IS the answer here.
  for (const row of await readConcordance(db)) {
    p18.set(row.qid, imageClaim(row));
    logos.set(row.qid, logoClaim(row));
  }
  return { p18, logos };
}

/**
 * The category cache's leads, as `Category:Name → File title | undefined` —
 * {@link concordanceIndexes}' sibling, with the same presence/value contract. The pick runs here, once
 * per category per crawl, so the selection rule (`categoryLead`) has exactly one home and a changed
 * rule takes effect on the next crawl without refetching a single listing.
 */
export async function categoryLeadIndex(db: Querier): Promise<Map<string, string | undefined>> {
  const out = new Map<string, string | undefined>();
  for (const [category, row] of await readCommonsCategories(db)) {
    out.set(category, row.absent ? undefined : categoryLead(row.members));
  }
  return out;
}

export interface MediaReport {
  /** Entity pages walked. */
  pages: number;
  /** Distinct files the crawl considered. */
  files: number;
  /** Files fetched, re-encoded and stored this run. */
  fetched: number;
  /** Files already known from an earlier run — the dedupe and resume win, together. */
  known: number;
  /** Files answered about and refused, by reason. */
  refused: Record<string, number>;
  /**
   * Files Wikimedia never answered for. **The only bucket a re-run can fix**, and deliberately not counted
   * as a refusal — the distinction this whole stage exists to preserve.
   */
  unanswered: number;
  /** References that yielded no file, by why. */
  skipped: Record<SkipReason, number>;
  /** Places that ended up with at least one photo. */
  placesWithMedia: number;
  /** Per-category coverage — the metric `sources.md` calls "which source to add next". */
  byCategory: { category: string; places: number; withMedia: number }[];
  bytes: number;
}

const emptyReport = (): MediaReport => ({
  pages: 0,
  files: 0,
  fetched: 0,
  known: 0,
  refused: {},
  unanswered: 0,
  skipped: { notAsked: 0, noP18: 0, noLead: 0, noLogo: 0, foreignHost: 0, unrankedSource: 0 },
  placesWithMedia: 0,
  byCategory: [],
  bytes: 0,
});

export interface MediaOptions {
  /** A budget on files fetched, not on entities walked — the `osm-enrich` lesson about windows. */
  limit: number;
  /** Read the retry ledger instead of walking entities. */
  retry: boolean;
  /** Ask again about files an earlier run settled — see {@link MediaFlags.refresh}. Ignored under `retry`. */
  refresh: boolean;
  dryRun: boolean;
  /** Where `media/<shard>/<hash>.webp` is written — the version dirs' sibling. */
  outDir: string;
  /** Two clients: the metadata host and the byte host have independent budgets (`apps/atlas/doc/spec/cartographer.md` §4). */
  api: WikimediaClient;
  bytes: WikimediaClient;
  maxBytes: number;
  now: () => string;
  log: (message: string) => void;
}

/**
 * The row for a file we learned nothing about — scheduled, never a verdict.
 *
 * Shared by the two ways that happens (a throttle the client reported, and a fetch that threw) so both
 * produce the same shape. `attempts` counts tries rather than failures, which is what bounds a file that
 * fails forever without ever letting it become "this place has no photo".
 */
/** The row for a file we have a definite, terminal answer about. */
function refusedRow(
  fileKey: string,
  source: SourceId,
  prior: MediaFileRow | undefined,
  reason: string,
): MediaFileRow {
  return {
    fileKey,
    source,
    state: "rejected",
    reason,
    attempts: (prior?.attempts ?? 0) + 1,
  };
}

function retryableRow(
  fileKey: string,
  source: SourceId,
  prior: MediaFileRow | undefined,
  reason: string,
  now: string,
): MediaFileRow {
  return {
    fileKey,
    source,
    state: "retryable",
    reason,
    attempts: (prior?.attempts ?? 0) + 1,
    nextAttemptAt: new Date(Date.parse(now) + RETRY_AFTER_MS).toISOString(),
  };
}

/**
 * What a source's metadata arm resolved a file to, before any bytes move: where the bytes live and the
 * terms they carry. For Commons both come from the per-file API answer; for NPS the URL is the claim
 * itself and the terms are the corpus's — which is exactly the difference between the two arms, stated
 * as data so the fetch below can stay one code path.
 */
interface Fetchable {
  url: string;
  license: string;
  author?: string;
  licenseUrl?: string;
  sourceUrl?: string;
}

/**
 * Fetch, verify, re-encode and store one file — the arm-independent half of the crawl.
 *
 * **Always returns a row**, whatever throws: a blob write or hash failure is scheduled, never recorded,
 * and never allowed to abandon the batch — whose durable write is at the end. The catch lives here
 * rather than at the call sites so an arm added later cannot forget it. The three outcomes stay
 * distinct all the way out: a `retryable` row keeps its attempt count so a file that fails forever is
 * bounded, while never claiming anything about the photo.
 */
async function crawlFile(
  fileKey: string,
  source: SourceId,
  file: Fetchable,
  prior: MediaFileRow | undefined,
  opts: MediaOptions,
): Promise<{ row: MediaFileRow; wrote: number }> {
  try {
    const got = await opts.bytes.bytes(file.url, opts.maxBytes);
    if (got.kind === "unanswered") {
      return { row: retryableRow(fileKey, source, prior, "throttled", opts.now()), wrote: 0 };
    }
    if (got.kind === "refused") {
      return { row: refusedRow(fileKey, source, prior, got.reason), wrote: 0 };
    }

    let thumb: Buffer;
    let full: Buffer;
    try {
      [thumb, full] = await Promise.all([
        sharpResizer.toWebp(got.bytes, PLACE_THUMB_PX, WEBP_QUALITY),
        sharpResizer.toWebp(got.bytes, PLACE_FULL_PX, WEBP_QUALITY),
      ]);
    } catch {
      // Not an image, or one sharp cannot decode. An answer: re-fetching will not change it.
      return { row: refusedRow(fileKey, source, prior, "undecodable"), wrote: 0 };
    }

    const thumbHash = hashBytes(thumb);
    const fullHash = hashBytes(full);
    if (!opts.dryRun) {
      await writeBlob(opts.outDir, thumbHash, thumb);
      await writeBlob(opts.outDir, fullHash, full);
    }
    return {
      row: {
        fileKey,
        source,
        attempts: (prior?.attempts ?? 0) + 1,
        state: "published",
        thumbHash,
        fullHash,
        bytes: thumb.length + full.length,
        license: file.license,
        ...(file.author ? { author: file.author } : {}),
        ...(file.licenseUrl ? { licenseUrl: file.licenseUrl } : {}),
        ...(file.sourceUrl ? { sourceUrl: file.sourceUrl } : {}),
      },
      wrote: thumb.length + full.length,
    };
  } catch {
    return { row: retryableRow(fileKey, source, prior, "network", opts.now()), wrote: 0 };
  }
}

/**
 * A Commons metadata answer as a {@link Fetchable}, or the refusal reason — the per-file licence
 * gate. A file with no resolvable licence is one we may not redistribute, and
 * `apps/atlas/doc/spec/volume-format.md` §7 has to be able to state terms for everything published.
 * The gate runs before any bytes move.
 */
function commonsFetchable(file: CommonsFile): Fetchable | { refused: string } {
  if (!file.license) return { refused: "no-license" };
  const url = byteUrl(file, PLACE_FULL_PX);
  if (!url) return { refused: "no-url" };
  return {
    url,
    license: file.license,
    ...(file.author ? { author: file.author } : {}),
    ...(file.licenseUrl ? { licenseUrl: file.licenseUrl } : {}),
    ...(file.sourceUrl ? { sourceUrl: file.sourceUrl } : {}),
  };
}

/**
 * The units cache's answer as a {@link Fetchable}, or the refusal — `commonsFetchable`'s sibling, and
 * the second place the PD gate runs on purpose. Staging gates what to *claim*; this gates what the
 * crawl *asserts* into `media_files.license`, and they can disagree: a `--retry` re-derives metadata
 * from a cache the `nps` stage has since refreshed, so an image NPS re-credited to a third party in the
 * meantime must be refused here — not published as public domain under the old claim.
 */
function npsFetchable(meta: NpsImageMeta, url: string): Fetchable | { refused: string } {
  if (!pdCredit(meta.credit)) return { refused: "not-pd" };
  return {
    url,
    license: SOURCE_TERMS.nps.license,
    // The API's own credit line ("NPS / Jacob W. Frank") — always present past the gate, and the
    // honest answer to who made the picture.
    ...(meta.credit ? { author: meta.credit } : {}),
    ...(meta.website ? { sourceUrl: meta.website } : {}),
  };
}

/**
 * The facilities cache's answer as a {@link Fetchable} — `npsFetchable`'s sibling, with the stricter
 * gate the RIDB corpus needs ({@link fedCredit}: mixed federal/third-party credits, no per-image
 * licence field). Same second-gate reasoning: a `--retry` re-derives from a cache the `ridb` stage
 * has since refreshed, so a re-credited image must be refused, not published under the old claim.
 */
function ridbFetchable(meta: RidbImageMeta, url: string): Fetchable | { refused: string } {
  if (!fedCredit(meta.credit)) return { refused: "not-pd" };
  return {
    url,
    license: SOURCE_TERMS.ridb.license,
    ...(meta.credit ? { author: meta.credit } : {}),
    ...(meta.website ? { sourceUrl: meta.website } : {}),
  };
}

/**
 * A contributed photo as a {@link Fetchable} — **no gate function, because the gate already ran.**
 *
 * The other arms re-derive publishability here because their upstreams state terms per image and
 * may revise them. A contribution's grant is the contributor's own, made once at submit, refused by
 * the wire without one and refused again by the staging pass — so a URL that reached this table has
 * a licence by construction. Re-deciding it here would be a fourth opinion with no new information.
 */
function contribFetchable(meta: ContribImageMeta, url: string): Fetchable {
  return {
    url,
    license: meta.license,
    ...(meta.licenseUrl ? { licenseUrl: meta.licenseUrl } : {}),
    ...(meta.author ? { author: meta.author } : {}),
  };
}

/**
 * The street catalog's answer as a {@link Fetchable} — no gate function, and that is the licensing
 * judgment, not an omission: KartaView's grant is corpus-wide CC BY-SA (`fields.ts` has the
 * verification note), so a photo the catalog still lists is publishable as-is. A photo the catalog
 * *dropped* is still refused upstream by `crawlCachedArm`'s missing rule, which is the only
 * re-gating this corpus has to offer.
 */
function kartaviewFetchable(meta: KartaviewImageMeta, url: string): Fetchable {
  return {
    url,
    license: SOURCE_TERMS.kartaview.license,
    author: SOURCE_TERMS.kartaview.attribution,
    ...(SOURCE_TERMS.kartaview.licenseUrl ? { licenseUrl: SOURCE_TERMS.kartaview.licenseUrl } : {}),
    sourceUrl: kartaviewDetailsUrl(meta.sequenceId, meta.sequenceIndex),
  };
}

/** One cache-backed arm, as the registry holds it — `readMeta`/`toFetchable` erased to `unknown`
 *  because each arm's Meta type is its own business and the pairing is sealed per row. */
interface CachedArm {
  source: SourceId;
  readMeta: (db: Querier, urls: string[]) => Promise<Map<string, unknown>>;
  toFetchable: (meta: unknown, url: string) => Fetchable | { refused: string };
}

/**
 * The cache-backed arms, **as data** — adding a source is one row here plus its `RANK` entry, and
 * every routing site (the `resolveRef` url branch, `titleOf`, `crawlBatch`'s dispatch and its
 * Commons complement) derives from this table. It became a table at the fourth arm, when the wiring
 * was five hand-synced sites and the quiet failure was real: an arm missing from the complement set
 * would have its keys crawled as Commons titles and terminally refused `missing` — over keys its own
 * arm had just answered.
 */
const CACHED_ARMS: readonly CachedArm[] = [
  {
    source: NPS_SOURCE,
    readMeta: (db, urls) => readNpsImageMeta(db, urls),
    toFetchable: (meta, url) => npsFetchable(meta as NpsImageMeta, url),
  },
  {
    source: RIDB_SOURCE,
    readMeta: (db, urls) => readRidbImageMeta(db, urls),
    toFetchable: (meta, url) => ridbFetchable(meta as RidbImageMeta, url),
  },
  {
    source: CONTRIB_SOURCE,
    readMeta: (db, urls) => readContribImageMeta(db, urls),
    toFetchable: (meta, url) => contribFetchable(meta as ContribImageMeta, url),
  },
  {
    source: KARTAVIEW_SOURCE,
    readMeta: (db, urls) => readKartaviewImageMeta(db, urls),
    toFetchable: (meta, url) => kartaviewFetchable(meta as KartaviewImageMeta, url),
  },
];

/** The claimers whose url refs route to a cached arm — `resolveRef`'s membership test. */
const CACHED_ARM_SOURCES: ReadonlySet<string> = new Set(CACHED_ARMS.map((arm) => arm.source));

/**
 * Write one content-addressed blob, skipping a file already on disk.
 *
 * Idempotent because the path *is* the hash: a re-run rewriting identical bytes is harmless, and skipping
 * the write is what makes `media/` shared across versions cheap rather than a copy per publish.
 */
async function writeBlob(outDir: string, hash: string, bytes: Buffer): Promise<void> {
  const path = blobPath(outDir, hash);
  try {
    const existing = await stat(path);
    if (existing.size === bytes.length) return;
  } catch {
    // Not there — fall through and write it.
  }
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, bytes);
}

/**
 * Whether a prior row settles the question, so the file needs no network at all.
 *
 * **It cannot see the disk**, so a `published` row whose bytes were lost reads as settled here and the walk
 * skips it. That is repaired from `publish` instead — `demoteMissingBlobs` has the reasoning — and the
 * constraint that puts it there is not the cost of stat-ing (publish stats ~17,000 blobs in milliseconds):
 * it is that this stage's `--out` need not be the tree a publish reads, and a walk only ever reaches files
 * something currently references.
 */
function settled(prior: MediaFileRow | undefined, nowMs: number): boolean {
  if (!prior) return false;
  if (prior.state !== "retryable") return true;
  return prior.nextAttemptAt !== undefined && Date.parse(prior.nextAttemptAt) > nowMs;
}

/**
 * The crawl.
 *
 * Two shapes in one stage: the default walks entities and resolves their references, `--retry`
 * reads the ledger. Both end in the same per-batch durable write, because an interrupted run
 * keeping its work is the property `apps/atlas/doc/spec/cartographer.md` §0 calls non-negotiable.
 */
export async function crawlMedia(db: Querier, opts: MediaOptions): Promise<MediaReport> {
  const report = emptyReport();
  if (opts.retry) await crawlDue(db, report, opts);
  else await crawlWalk(db, report, opts);
  // Not in `--dry-run`: nothing was written, so these would report the *previous* run's coverage as this
  // run's result — and the category query scans all 225k merged places to do it.
  if (!opts.dryRun) {
    report.placesWithMedia = await placesWithMedia(db);
    report.byCategory = await mediaCoverageByCategory(db);
  }
  return report;
}

/**
 * `--retry`: the files a previous run left scheduled, and nothing else.
 *
 * Needs no resolve indexes, no entity walk and no budget bookkeeping — the ledger query is already bounded, and
 * every row in it is by definition a file we resolved once. **It also writes no links**, and does not need
 * to: {@link crawlWalk} links every file it resolved regardless of state, so a file that becomes
 * `published` here is picked up by publish's own `state = 'published'` filter with nothing to re-link.
 */
async function crawlDue(db: Querier, report: MediaReport, opts: MediaOptions): Promise<void> {
  const due = await fetchRetryableMedia(db, { limit: opts.limit, now: opts.now() });
  opts.log(`retrying ${due.length} deferred file(s)`);
  report.files = due.length;
  const prior = new Map(due.map((row) => [row.fileKey, row]));
  for (let at = 0; at < due.length; at += METADATA_BATCH) {
    const slice = due.slice(at, at + METADATA_BATCH);
    await crawlBatch(
      db,
      new Map(slice.map((r) => [r.fileKey, titleOf(r.fileKey)])),
      prior,
      report,
      opts,
    );
  }
}

/** The default pass: walk every entity, resolve what it claims, fetch what is not already known. */
async function crawlWalk(db: Querier, report: MediaReport, opts: MediaOptions): Promise<void> {
  const indexes: ResolveIndexes = {
    ...(await concordanceIndexes(db)),
    categoryLeads: await categoryLeadIndex(db),
  };
  /** Every file key considered this run → what we know about it. Doubles as the cross-page dedupe. */
  const seen = new Map<string, MediaFileRow | undefined>();
  let budget = opts.limit;
  let pages = 0;
  let cursor: string | undefined;

  for (;;) {
    // One query, and it returns the cursor: the page window is a `DISTINCT entity_id` keyset and the rows
    // are LEFT-joined onto it, so an entity with no references still yields the cursor. Deriving the cursor
    // from the returned *refs* would stall on the first page that filtered to empty — 82.5% of entities
    // carry none — and a second query for it was 450 extra round trips on an RTT-bound stage.
    const page = await fetchEntityMediaRefs(db, {
      limit: PAGE_SIZE,
      ...(cursor ? { after: cursor } : {}),
    });
    if (page.cursor === undefined) break;
    cursor = page.cursor;
    pages += 1;

    // Resolve locally first, so one batched metadata request covers the whole page's files.
    const wanted = new Map<string, string>();
    const perPlace = new Map<string, { fileKey: string; rank: number }[]>();
    for (const entity of page.entities) {
      const picks: { fileKey: string; rank: number }[] = [];
      for (const ref of entity.refs) {
        const resolved = resolveRef(ref, indexes);
        if (resolved.kind === "skipped") {
          report.skipped[resolved.why] += 1;
          continue;
        }
        wanted.set(resolved.fileKey, resolved.title);
        if (!picks.some((pick) => pick.fileKey === resolved.fileKey)) {
          picks.push({ fileKey: resolved.fileKey, rank: resolved.rank });
        }
      }
      if (picks.length > 0) perPlace.set(entity.entityId, picks);
    }

    // Only ask about keys this run has not already resolved. The crawl's own dedupe ratio — 39,415 refs to
    // 8,363 files — is exactly the repeat rate this avoids paying per page.
    const fresh = [...wanted.keys()].filter((key) => !seen.has(key));
    for (const [key, row] of await readMediaFiles(db, fresh)) seen.set(key, row);
    for (const key of fresh) if (!seen.has(key)) seen.set(key, undefined);

    const nowMs = Date.parse(opts.now());
    const todo: [string, string][] = [];
    for (const [fileKey, title] of wanted) {
      const known = seen.get(fileKey);
      if (!opts.refresh && settled(known, nowMs)) {
        if (fresh.includes(fileKey)) report.known += 1;
      } else {
        todo.push([fileKey, title]);
      }
    }

    for (let at = 0; at < todo.length && budget > 0; at += METADATA_BATCH) {
      const slice = new Map(todo.slice(at, at + METADATA_BATCH));
      const prior = new Map([...slice.keys()].map((k) => [k, seen.get(k)] as const));
      // `crawlBatch` hands back what it wrote, so the states below need no second read of the same keys.
      for (const row of await crawlBatch(db, slice, prior, report, opts))
        seen.set(row.fileKey, row);
      budget -= slice.size;
    }

    // Link every file we have a row for, in rank order — **not** only the publishable ones. `media_files`
    // holds the state and publish filters on it, so linking unconditionally is what lets a later
    // `--retry` publish a photo without anything having to re-link it. (A file with no row at all is
    // skipped: `place_media` has a foreign key, and a budget-exhausted file has nothing to point at.)
    const links: PlaceMediaLink[] = [];
    for (const [entityId, picks] of perPlace) {
      picks
        .filter((pick) => seen.get(pick.fileKey) !== undefined)
        .sort((a, b) => a.rank - b.rank || (a.fileKey < b.fileKey ? -1 : 1))
        .forEach((pick, index) => links.push({ entityId, fileKey: pick.fileKey, rank: index }));
    }
    if (!opts.dryRun) await writePlaceMedia(db, [...perPlace.keys()], links);

    opts.log(
      `page ${pages}: ${wanted.size} file(s) referenced, ${report.fetched} fetched so far` +
        (budget <= 0 ? " — file budget reached" : ""),
    );
    if (budget <= 0) break;
  }
  report.files = seen.size;
}

/** A file key's fetchable name — the URL for a cached-arm key, the Commons title otherwise. */
function titleOf(fileKey: string): string {
  for (const arm of CACHED_ARMS) {
    if (fileKey.startsWith(`${arm.source}:`)) return fileKey.slice(arm.source.length + 1);
  }
  return fileKey.startsWith(`${COMMONS_SOURCE}:`)
    ? fileKey.slice(COMMONS_SOURCE.length + 1)
    : fileKey;
}

/**
 * One cache-backed arm's outcomes — the shape every {@link CACHED_ARMS} row shares, factored so a
 * new source cannot re-implement it with a subtly different missing/refused split. Per entry: the
 * cache no longer listing a claimed URL is an *answer* (the source dropped or replaced the image →
 * refused `missing`); a listed URL runs the source's own licence gate; only then do bytes move.
 */
async function crawlCachedArm(
  entries: readonly (readonly [string, string])[],
  arm: CachedArm,
  db: Querier,
  prior: Map<string, MediaFileRow | undefined>,
  opts: MediaOptions,
): Promise<{ row: MediaFileRow; wrote: number }[]> {
  if (entries.length === 0) return [];
  const meta = await arm.readMeta(
    db,
    entries.map(([, url]) => url),
  );
  const outcomes: { row: MediaFileRow; wrote: number }[] = [];
  for (const [fileKey, url] of entries) {
    const known = prior.get(fileKey);
    const found = meta.get(url);
    const fetchable = found === undefined ? { refused: "missing" } : arm.toFetchable(found, url);
    outcomes.push(
      "refused" in fetchable
        ? { row: refusedRow(fileKey, arm.source, known, fetchable.refused), wrote: 0 }
        : await crawlFile(fileKey, arm.source, fetchable, known, opts),
    );
  }
  return outcomes;
}

/**
 * One batch's metadata resolution plus its byte fetches, written durably — routed per file key to the
 * arm that owns its namespace.
 *
 * Returns the rows it wrote, so a caller needs no second read of the same keys to learn their new states.
 * (The *budget* is spent per file **attempted**, which the caller counts from what it handed in: spending it
 * on successes instead makes `--limit 300` unbounded whenever files are failing — measured, a run with a
 * byte cap small enough to refuse everything walked past ten minutes and every page of the dataset.)
 */
async function crawlBatch(
  db: Querier,
  todo: Map<string, string>,
  prior: Map<string, MediaFileRow | undefined>,
  report: MediaReport,
  opts: MediaOptions,
): Promise<MediaFileRow[]> {
  if (todo.size === 0) return [];
  const outcomes: { row: MediaFileRow; wrote: number }[] = [];

  // The cache-backed arms: each source's own cache is the metadata service, so the only network is
  // the bytes themselves (and `--retry` re-derives credits offline). The Commons arm below takes the
  // COMPLEMENT of what these consumed — accumulated inside the registry loop, by construction, so an
  // arm added to {@link CACHED_ARMS} can never leave its keys to be crawled twice.
  const cachedKeys = new Set<string>();
  for (const arm of CACHED_ARMS) {
    const armTodo = [...todo].filter(([key]) => key.startsWith(`${arm.source}:`));
    for (const [key] of armTodo) cachedKeys.add(key);
    outcomes.push(...(await crawlCachedArm(armTodo, arm, db, prior, opts)));
  }

  // The Commons arm: one batched metadata request for everything else. No local `.catch()` around it:
  // the client reports a socket that never opened as `unavailable`, the same bucket as a throttle, which
  // is what lets this stage "take days if needed" rather than dying on one reset.
  const commonsTodo = [...todo].filter(([key]) => !cachedKeys.has(key));
  if (commonsTodo.length > 0) {
    const answer = await opts.api.commonsFiles(
      commonsTodo.map(([, title]) => title),
      PLACE_FULL_PX,
    );
    if (answer.unavailable) {
      // Nothing written for these. A throttled metadata batch is not knowledge about any of them, and a
      // row would turn "we never asked successfully" into a record — the exact conflation this stage
      // exists to avoid. They stay candidates for the next run; the NPS arm's rows above still land.
      report.unanswered += commonsTodo.length;
    } else {
      for (const [fileKey, title] of commonsTodo) {
        const file = answer.files.get(commonsFileTitle(title));
        const known = prior.get(fileKey);
        let outcome: { row: MediaFileRow; wrote: number };
        if (!file) {
          // In the reply's scope but not in it: Commons says there is no such file. An answer.
          outcome = { row: refusedRow(fileKey, COMMONS_SOURCE, known, "missing"), wrote: 0 };
        } else {
          const fetchable = commonsFetchable(file);
          outcome =
            "refused" in fetchable
              ? { row: refusedRow(fileKey, COMMONS_SOURCE, known, fetchable.refused), wrote: 0 }
              : await crawlFile(fileKey, COMMONS_SOURCE, fetchable, known, opts);
        }
        outcomes.push(outcome);
      }
    }
  }

  const rows = outcomes.map((outcome) => outcome.row);
  for (const { row, wrote } of outcomes) {
    if (row.state === "published") {
      report.fetched += 1;
      report.bytes += wrote;
    } else if (row.state === "rejected") {
      report.refused[row.reason ?? "unknown"] = (report.refused[row.reason ?? "unknown"] ?? 0) + 1;
    } else {
      report.unanswered += 1;
    }
  }
  if (!opts.dryRun) await writeMediaFiles(db, rows, opts.now());
  return rows;
}
