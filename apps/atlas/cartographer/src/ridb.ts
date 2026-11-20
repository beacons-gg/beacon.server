/**
 * The RIDB source — Recreation.gov's own description, page and photo for federal recreation
 * facilities (campgrounds, trailheads, day-use areas), as a staged source.
 * `apps/atlas/doc/spec/sources.md` §2 scopes it to "`park` and `nature` outside the NPS units";
 * measured against us-west staging the honest scale is **NPS-sized, not corpus-sized** (~150
 * joinable places, not RIDB's 15k facilities), because the join is identity, not proximity — the
 * corpus-wide win needs the deferred conflation matcher.
 *
 * **A derived source, on the NPS template** (`nps.ts` is the reference): one record per enriched
 * place, `derived_from` names the parent, no ids of its own, no `ridb:` upstream namespace. What is
 * new here is that the join has **two sides**, tried in the article stage's own-tag-first order:
 *
 * - **The mapper's**: an OSM `website=` tag pointing at `recreation.gov/camping/campgrounds/<id>`
 *   names the facility as directly as a `wikipedia=` tag names an article ({@link facilityIdFromWebsite}).
 * - **Wikidata's**: a staged `wd:` entity claiming P6747 ("Recreation.gov campground ID" — the value
 *   space IS `FacilityID`) is Wikidata asserting the join ({@link facilityIdClaim} in concordance.ts).
 *
 * **Licensing is gated, twice over, and stricter than NPS.** RIDB's access agreement states no
 * public-domain grant and no per-record licence; per-image `Credits` name federal agencies and
 * third parties alike. So text stages only for facilities **managed by a federal agency** ({@link
 * federalOrg} — a US-government-work presumption, recorded in `apps/atlas/doc/spec/sources.md` §2),
 * and a photo is claimed only when its own credit names a federal agency ({@link fedCredit});
 * everything else is counted, never published. The crawl re-checks the credit from the cache before
 * asserting PD.
 */
import type { MediaCredit } from "@beaconsgg/protocol-types";
import { facilityIdClaim, facilityIdRows } from "./concordance";
import { SOURCE_TERMS } from "./fields";
import {
  collapseWhitespace,
  fetchRidbCandidates,
  recordRef,
  RIDB_CAMPGROUND_PATTERN,
  RIDB_SOURCE,
  writeRidbFacilities,
  writeStaged,
  type Querier,
  type RidbCandidate,
  type RidbFacility,
  type StagedRow,
} from "./store";
import { upstreamId } from "./upstream";

/** Who an RIDB photo is claimed by — stage 4 ranks on it and routes its fetch to recreation.gov. */
export const RIDB_CLAIMER = RIDB_SOURCE;

export { RIDB_SOURCE };

/** The by-id facility endpoint (`?full=true` embeds ORGANIZATION + MEDIA). */
const FACILITY_URL = "https://ridb.recreation.gov/api/v1/facilities";

/** Pause between facility requests — RIDB allows far more, but nobody needs 150 requests faster. */
const REQUEST_INTERVAL_MS = 200;

/** A facility's public page — the staged `website`, the credit's `sourceUrl`, and P6747's formatter. */
export function facilityPage(facilityId: string): string {
  return `https://www.recreation.gov/camping/campgrounds/${facilityId}`;
}

/** The one pattern, compiled — the candidate query and its partial index embed the same source string. */
const CAMPGROUND_URL = new RegExp(RIDB_CAMPGROUND_PATTERN);

/** The mapper-side join: the facility id a `website=` tag names, if it names one. */
export function facilityIdFromWebsite(website: string | undefined): string | undefined {
  const match = website ? CAMPGROUND_URL.exec(website) : undefined;
  return match?.[1];
}

/**
 * The managing agencies whose works are US-government works — RIDB's `OrgID` vocabulary, from its
 * own organizations table. The federal *text* gate: a facility outside this set may be listed on
 * recreation.gov, but its description's author is a state park, a concessionaire, or a partner, and
 * no licence anywhere says we may republish their words.
 */
const FEDERAL_ORGS = new Map([
  ["126", "Bureau of Land Management"],
  ["127", "US Fish and Wildlife Service"],
  ["128", "National Park Service"],
  ["129", "Bureau of Reclamation"],
  ["130", "US Army Corps of Engineers"],
  ["131", "USDA Forest Service"],
]);

/** Whether a facility's managing org is a federal agency — the description gate. */
export function federalOrg(orgId: string | undefined): boolean {
  return orgId !== undefined && FEDERAL_ORGS.has(orgId);
}

/**
 * Whether an image's `Credits` line names a federal agency, making it a US-government work — the
 * photo gate, `pdCredit`'s sibling. Containment with word boundaries rather than `startsWith`,
 * because RIDB credits read "Photo by USFS" as often as "USFS": agency initialisms and full names
 * both count, anything else — a named photographer, a partner org, or **no credit at all** — is
 * treated as third-party, because publishing it would assert a licence nobody stated.
 */
export function fedCredit(credit: string | undefined): boolean {
  if (!credit) return false;
  return /\b(USFS|USDA|FOREST SERVICE|NPS|NATIONAL PARK SERVICE|BLM|BUREAU OF LAND MANAGEMENT|USACE|ARMY CORPS|USFWS|FWS|FISH AND WILDLIFE|BUREAU OF RECLAMATION|RECREATION\.GOV)\b/.test(
    credit.toUpperCase(),
  );
}

/**
 * `FacilityDescription` is HTML (`<h2>Overview</h2>…<br/>`). Strip it to prose at the fetch seam so
 * the cache never stores markup: heading elements go **wholesale** — measured live, their text is
 * section chrome ("Overview", "Recreation", "Natural Features") that glues into the prose as
 * "Overview Download the NPS app…" — then remaining tags become spaces, the handful of entities the
 * corpus actually uses decode, and the shared collapse squeezes the rest. Not a parser on purpose —
 * the fields are shallow fragments, and a places description carrying a stray `&amp;` is the
 * failure this prevents.
 */
export function stripHtml(html: string): string {
  const text = html
    .replace(/<h[1-6][^>]*>[\s\S]*?<\/h[1-6]>/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#0*39;|&apos;/gi, "'");
  return collapseWhitespace(text);
}

export interface RidbReport {
  /** Facility requests made. */
  requests: number;
  /** Facilities the API answered (the cache batch). */
  facilities: number;
  /** Concordance entities claiming a facility id — the Wikidata half of the join population. */
  claims: number;
  /** Staged records that could name a facility, through either join. */
  candidates: number;
  /** Records staged as a `ridb` source. */
  staged: number;
  /** Candidates whose facility the API no longer serves (404) — delisted, a fact not a failure. */
  unknownFacility: number;
  /** Staged records whose facility's org is not federal — description withheld by the text gate. */
  nonFederal: number;
  /** Of the staged records, how many bring a description to a place that had none. */
  fillsDescription: number;
  /** Of the staged records, how many bring a photo reference. */
  withPhoto: number;
  /** Staged records whose facility has images, none federally credited — nothing safely PD. */
  noPdPhoto: number;
}

const emptyReport = (): RidbReport => ({
  requests: 0,
  facilities: 0,
  claims: 0,
  candidates: 0,
  staged: 0,
  unknownFacility: 0,
  nonFederal: 0,
  fillsDescription: 0,
  withPhoto: 0,
  noPdPhoto: 0,
});

export interface RidbOptions {
  dryRun: boolean;
  /** An RIDB key (`CARTOGRAPHER_RIDB_API_KEY`) — free and instant from a recreation.gov profile. */
  apiKey: string;
  /** The same contact-carrying UA policy every other outbound call follows. */
  userAgent: string;
  /** Injectable for tests; the real stage uses global fetch. */
  fetchImpl?: typeof fetch;
  now: () => string;
  log: (message: string) => void;
}

/**
 * The staged record one candidate becomes. The NPS shape throughout (no `name` —
 * `apps/atlas/doc/spec/sources.md` §5 gives names to the mapper), with the text gate on top: a
 * non-federal facility contributes its page and any federally-credited photo, never its prose.
 * Always a row — unlike an NPS unit, every joined facility has at least its canonical page to
 * contribute, which is real value for the Wikidata-joined records whose mapper never tagged a
 * `website=`.
 */
export function stagedFromFacility(candidate: RidbCandidate, facility: RidbFacility): StagedRow {
  const federal = federalOrg(facility.orgId);
  const description = federal ? collapseWhitespace(facility.description ?? "") : "";
  const photo = facility.images.find((image) => fedCredit(image.credit));
  const website = facility.website;

  const row: StagedRow = {
    source: RIDB_SOURCE,
    sourceId: candidate.sourceId,
    category: candidate.category,
    ...(candidate.subcategory ? { subcategory: candidate.subcategory } : {}),
    point: candidate.point,
    ...(description
      ? // The credit names the managing agency, not Recreation.gov: the agency is the author whose
        // federal employment is the whole licence argument. Never separable from the text (OWNED_BY).
        { description, descriptionCredit: ridbCredit(facility) }
      : {}),
    website,
    mediaRefs: photo
      ? // Claimed, not fetched: stage 4 owns bytes. This claimer routes the fetch to recreation.gov's
        // CDN and the credit re-check to the facilities cache instead of the Commons machinery.
        [{ kind: "url", value: photo.url, claimedBy: RIDB_CLAIMER }]
      : [],
    upstreamIds: [],
    derivedFrom: recordRef(candidate),
    raw: {
      facilityId: facility.facilityId,
      name: facility.name,
      ...(facility.type ? { type: facility.type } : {}),
      ...(facility.org ? { org: facility.org } : {}),
    },
  };
  return row;
}

/** The description's credit: the managing agency as author, the facility page as provenance. */
function ridbCredit(facility: RidbFacility): MediaCredit {
  return {
    license: SOURCE_TERMS.ridb.license,
    author: facility.org ?? SOURCE_TERMS.ridb.name,
    sourceUrl: facility.website,
  };
}

/**
 * The concordance's facility-id claims, as `wd:QID → FacilityID` — `npsCodeIndex`'s sibling. The
 * read is SQL-filtered to the claiming rows (~23 on us-west), so the map is the transfer.
 */
export async function ridbIdIndex(db: Querier): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const row of await facilityIdRows(db)) {
    const facilityId = facilityIdClaim(row);
    if (facilityId === undefined) continue;
    const id = upstreamId("wd", row.qid);
    if (id) out.set(id, facilityId);
  }
  return out;
}

/** A candidate's facility id — its own `website=` tag first (the mapper outranks the sitelink-shaped join). */
export function facilityIdOf(
  candidate: RidbCandidate,
  idByWdId: ReadonlyMap<string, string>,
): string | undefined {
  return (
    facilityIdFromWebsite(candidate.website) ??
    candidate.wdIds.map((id) => idByWdId.get(id)).find((fid) => fid !== undefined)
  );
}

/**
 * Resolve which staged places name RIDB facilities, fetch exactly those facilities, and stage what
 * the managing agencies say. Both durable writes land after the whole fetch: a network failure
 * mid-run leaves the cache and staging untouched rather than half-replaced.
 */
export async function stageRidb(db: Querier, opts: RidbOptions): Promise<RidbReport> {
  const report = emptyReport();

  const idByWdId = await ridbIdIndex(db);
  report.claims = idByWdId.size;
  const candidates = await fetchRidbCandidates(db, [...idByWdId.keys()]);
  report.candidates = candidates.length;

  const wanted = new Map<string, RidbCandidate[]>();
  for (const candidate of candidates) {
    const facilityId = facilityIdOf(candidate, idByWdId);
    if (facilityId === undefined) continue; // website matched the host but not the campground shape
    const list = wanted.get(facilityId);
    if (list) list.push(candidate);
    else wanted.set(facilityId, [candidate]);
  }

  const { facilities, missing } = await fetchFacilities([...wanted.keys()], opts);
  // One request per wanted id, exactly — a 404 still spent its request; any other failure threw.
  report.requests = wanted.size;
  report.facilities = facilities.size;
  report.unknownFacility = [...missing].reduce((n, id) => n + (wanted.get(id)?.length ?? 0), 0);
  if (!opts.dryRun) await writeRidbFacilities(db, [...facilities.values()], opts.now());

  const staged: StagedRow[] = [];
  for (const [facilityId, group] of wanted) {
    const facility = facilities.get(facilityId);
    if (!facility) continue; // counted via `missing` above
    for (const candidate of group) {
      const row = stagedFromFacility(candidate, facility);
      staged.push(row);
      if (!federalOrg(facility.orgId)) report.nonFederal += 1;
      if (row.description && !candidate.hasDescription) report.fillsDescription += 1;
      if (row.mediaRefs.length > 0) report.withPhoto += 1;
      else if (facility.images.length > 0) report.noPdPhoto += 1;
    }
  }
  report.staged = staged.length;
  if (!opts.dryRun) await writeStaged(db, staged, opts.now());

  opts.log(
    `${report.claims} claims · ${report.candidates} candidates · ${report.facilities} facilities · ` +
      `${report.staged} staged · ${report.withPhoto} with a photo`,
  );
  return report;
}

/** The by-id endpoint's record — bare, per the spec and the live run (list endpoints envelope, this one doesn't). */
interface FacilityDto {
  FacilityID?: string | number;
  FacilityName?: string;
  FacilityDescription?: string;
  FacilityTypeDescription?: string;
  ORGANIZATION?: { OrgID?: string | number; OrgName?: string; OrgAbbrevName?: string }[];
  MEDIA?: {
    MediaType?: string;
    URL?: string;
    Title?: string;
    Credits?: string;
    IsPrimary?: boolean;
  }[];
}

/**
 * Fetch each wanted facility by id. A `404` is knowledge — the facility is delisted, recorded in
 * `missing` and never retried within the run; a `429` aborts the stage whole (an unanswered API is
 * not knowledge about any facility); any other failure likewise aborts, so the replace-write above
 * can never land a partial batch as if it were the population.
 */
async function fetchFacilities(
  facilityIds: readonly string[],
  opts: RidbOptions,
): Promise<{ facilities: Map<string, RidbFacility>; missing: Set<string> }> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const facilities = new Map<string, RidbFacility>();
  const missing = new Set<string>();
  for (const [i, facilityId] of facilityIds.entries()) {
    if (i > 0) await new Promise((resolve) => setTimeout(resolve, REQUEST_INTERVAL_MS));
    const res = await fetchImpl(`${FACILITY_URL}/${facilityId}?full=true`, {
      headers: { apikey: opts.apiKey, "User-Agent": opts.userAgent, accept: "application/json" },
      signal: AbortSignal.timeout(60_000),
    });
    if (res.status === 404) {
      missing.add(facilityId);
      continue;
    }
    if (res.status === 429) {
      throw new Error(
        "the RIDB API rate-limited this key (HTTP 429) — wait and re-run; nothing was written",
      );
    }
    if (!res.ok) {
      throw new Error(`RIDB /facilities/${facilityId} answered ${res.status} — nothing written`);
    }
    const facility = facilityOf((await res.json()) as FacilityDto, facilityId);
    if (facility) facilities.set(facility.facilityId, facility);
    else missing.add(facilityId);
  }
  return { facilities, missing };
}

/** One facility as the cache stores it — or nothing, for a body missing its name. */
export function facilityOf(dto: FacilityDto, facilityId: string): RidbFacility | undefined {
  const name = dto.FacilityName?.trim();
  if (!name) return undefined;
  const orgs = dto.ORGANIZATION ?? [];
  // The federal org when one manages it (the gate's key); otherwise the first listed, for the report.
  const org =
    orgs.find((entry) => federalOrg(entry.OrgID === undefined ? undefined : String(entry.OrgID))) ??
    orgs[0];
  const description = dto.FacilityDescription ? stripHtml(dto.FacilityDescription) : "";
  // Sort the DTOs (primary first — the facility's own pick leads), then build the cache shape once.
  const images = (dto.MEDIA ?? [])
    .filter((media): media is typeof media & { URL: string } =>
      Boolean(media.MediaType === "Image" && media.URL),
    )
    .sort((a, b) => Number(b.IsPrimary === true) - Number(a.IsPrimary === true))
    .map((media) => ({
      url: media.URL,
      ...(media.Title ? { title: media.Title } : {}),
      ...(media.Credits?.trim() ? { credit: media.Credits.trim() } : {}),
    }));
  return {
    facilityId,
    name,
    ...(description ? { description } : {}),
    ...(dto.FacilityTypeDescription?.trim() ? { type: dto.FacilityTypeDescription.trim() } : {}),
    ...(org?.OrgName?.trim() ? { org: org.OrgName.trim() } : {}),
    ...(org?.OrgID !== undefined ? { orgId: String(org.OrgID) } : {}),
    website: facilityPage(facilityId),
    images,
  };
}
