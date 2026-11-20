/**
 * The NPS source — the US National Park Service's own description, page and photo for its units, as
 * a staged source of its own. `apps/atlas/doc/spec/sources.md` §2 calls it "the best single fit for
 * the largest gap": deep, not broad — federal units only, but written by the place's *owner*, which
 * is why `OWNER_FIRST` ranks `nps` above everything for `description` while `MAPPER_FIRST` still
 * gives OSM the name.
 *
 * **A derived source, on the Wikipedia template** (`wikipedia.ts` is the reference, and the shape
 * the other derived sources inherit). One record per enriched *place*, never per unit; it names the
 * record it was built out of (`derived_from`) and asserts no identifiers of its own. The join runs
 * the other way from the article stage's title tags: the API exposes no external ids at all, so the
 * bridge is Wikidata — a staged record's `wd:` entity claiming a P4083 park code *is* the assertion
 * "this place is that unit", made by Wikidata, not by us ({@link parkCodeClaim} normalizes the two
 * sides' case disagreement). An `nps:` upstream-id namespace stays deliberately absent from
 * `upstream.ts`: a derived record cannot assert one, so the namespace would be a row nothing
 * produces.
 *
 * **The corpus is fetched whole, every run.** ~474 units in one listing request makes the cache a
 * snapshot rather than a per-key ledger — no `absent` bookkeeping, no budget, no `--refresh`. The cache
 * still matters: the media crawl reads per-image credits from it offline, so an NPS photo's `--retry`
 * needs no NPS API at all.
 *
 * **Public domain, gated per image.** NPS-authored works are US federal public domain, but the API
 * serves some third-party-credited photos and marks no per-image licence. The stager claims only images
 * whose credit names the Park Service ({@link pdCredit}); everything else is counted, not published —
 * the per-corpus analogue of the Commons per-file licence gate.
 */
import type { MediaCredit } from "@beaconsgg/protocol-types";
import { parkCodeClaim, parkCodeRows } from "./concordance";
import { SOURCE_TERMS } from "./fields";
import {
  collapseWhitespace,
  fetchNpsCandidates,
  NPS_SOURCE,
  recordRef,
  writeNpsUnits,
  writeStaged,
  type NpsCandidate,
  type NpsUnit,
  type Querier,
  type StagedRow,
} from "./store";
import { upstreamId } from "./upstream";

/** Who an NPS photo is claimed by — stage 4 ranks on it (head of the chain: verified-PD owner's shot). */
export const NPS_CLAIMER = NPS_SOURCE;

export { NPS_SOURCE };

/** The listing endpoint. One page usually covers the whole corpus. */
const PARKS_URL = "https://developer.nps.gov/api/v1/parks";

/** Units per listing request — verified live to return the full corpus in one page. */
const PAGE_LIMIT = 500;

/** Pause between listing pages, on the off chance the corpus ever needs more than one. */
const PAGE_INTERVAL_MS = 200;

export interface NpsReport {
  /** Listing requests made. */
  requests: number;
  /** Units the API serves. */
  units: number;
  /** Wikidata entities in the concordance claiming a park code — the join population. */
  codes: number;
  /** Staged records carrying one of those entities. */
  candidates: number;
  /** Records staged as an `nps` source. */
  staged: number;
  /**
   * Candidates whose code Wikidata knows but the API no longer serves — former and affiliated units
   * (Wikidata's P4083 population is ~489 against ~474 live units). A fact about the data, not a failure.
   */
  unknownUnit: number;
  /** Units with nothing to contribute — no description, no page, no publishable photo. */
  emptyUnit: number;
  /** Of the staged records, how many bring a description to a place that had none. */
  fillsDescription: number;
  /** Of the staged records, how many bring a photo reference. */
  withPhoto: number;
  /** Staged records whose unit has images, all third-party-credited — nothing safely public domain. */
  noPdPhoto: number;
}

const emptyReport = (): NpsReport => ({
  requests: 0,
  units: 0,
  codes: 0,
  candidates: 0,
  staged: 0,
  unknownUnit: 0,
  emptyUnit: 0,
  fillsDescription: 0,
  withPhoto: 0,
  noPdPhoto: 0,
});

export interface NpsOptions {
  dryRun: boolean;
  /** An api.data.gov key (`CARTOGRAPHER_NPS_API_KEY`) — free and instant; `DEMO_KEY` works at 30/hour. */
  apiKey: string;
  /** The same contact-carrying UA policy every other outbound call follows. */
  userAgent: string;
  /** Injectable for tests; the real stage uses global fetch. */
  fetchImpl?: typeof fetch;
  now: () => string;
  log: (message: string) => void;
}

/**
 * Whether an image's credit marks it as the Park Service's own work, and therefore public domain.
 *
 * The API states no per-image licence; the credit line is the only signal. "NPS", "NPS Photo" and
 * "NPS / Jane Doe" (~all of the corpus's own photography) are federal works; anything else — a
 * named photographer, a partner organisation, or **no credit at all** — is treated as third-party,
 * because publishing it would assert a licence nobody stated (`apps/atlas/doc/spec/sources.md` §2's
 * "no guarantee" caveat).
 */
export function pdCredit(credit: string | undefined): boolean {
  return credit !== undefined && credit.trim().toUpperCase().startsWith("NPS");
}

/**
 * The credit for a description taken from a unit's page. Built from the terms table, not restated:
 * `SOURCE_TERMS.nps` is the one declaration of what the Park Service is called and what its works are
 * licensed as, and a second spelling here is the drift `fields.ts` exists to prevent.
 */
function npsCredit(unit: NpsUnit): MediaCredit {
  return {
    license: SOURCE_TERMS.nps.license,
    author: SOURCE_TERMS.nps.name,
    ...(unit.website ? { sourceUrl: unit.website } : {}),
  };
}

/**
 * The staged record one candidate becomes — or nothing, for a unit with nothing to contribute (the one
 * way that happens; the article stage's `SkipReason` union exists because it has two).
 *
 * `category`, `subcategory` and `point` are the candidate's own, for {@link NpsCandidate}'s reason.
 * **No `name`**, though the Park Service certainly has one: `apps/atlas/doc/spec/sources.md` §5
 * gives names to the mapper outright, and a "Fort Vancouver National Historic Site" replacing a
 * place everyone calls Fort Vancouver is exactly why. The unit's page does ride as `website` — it
 * loses to a mapper's own tag in `MAPPER_FIRST` and fills the gap everywhere else.
 */
export function stagedFromUnit(candidate: NpsCandidate, unit: NpsUnit): StagedRow | undefined {
  const description = collapseWhitespace(unit.description ?? "");
  const photo = unit.images.find((image) => pdCredit(image.credit));
  if (!description && !photo && !unit.website) return undefined;

  const row: StagedRow = {
    source: NPS_SOURCE,
    sourceId: candidate.sourceId,
    category: candidate.category,
    ...(candidate.subcategory ? { subcategory: candidate.subcategory } : {}),
    point: candidate.point,
    ...(description
      ? // A description and its credit are never separable — `OWNED_BY` enforces it downstream.
        { description, descriptionCredit: npsCredit(unit) }
      : {}),
    ...(unit.website ? { website: unit.website } : {}),
    mediaRefs: photo
      ? // Claimed, not fetched: stage 4 owns bytes. `url` + this claimer is what routes the fetch to
        // nps.gov with corpus-level PD terms instead of through the Commons licence machinery.
        [{ kind: "url", value: photo.url, claimedBy: NPS_CLAIMER }]
      : [],
    upstreamIds: [],
    derivedFrom: recordRef(candidate),
    // Build-side provenance: which unit said this, so a human can ask why a place says it.
    raw: {
      unitCode: unit.unitCode,
      name: unit.name,
      ...(unit.designation ? { designation: unit.designation } : {}),
    },
  };
  return row;
}

/**
 * The concordance's park-code claims, as `wd:QID → unit code`.
 *
 * The `p18Index` pattern with a SQL-filtered read: the P-number stays in `concordance.ts`, and the
 * transfer is the join population itself (~100 claiming rows), never the 28k-row concordance.
 */
export async function npsCodeIndex(db: Querier): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const row of await parkCodeRows(db)) {
    const code = parkCodeClaim(row);
    if (code === undefined) continue;
    const id = upstreamId("wd", row.qid);
    if (id) out.set(id, code);
  }
  return out;
}

/**
 * Fetch the unit corpus, resolve which staged places are units, and stage what the Park Service says.
 *
 * The corpus fetch comes first and a failure aborts the stage whole — the API not answering is not
 * knowledge about any unit, and there is nothing partial worth keeping when one request is the entire
 * network cost.
 */
export async function stageNps(db: Querier, opts: NpsOptions): Promise<NpsReport> {
  const report = emptyReport();

  const units = await fetchUnits(opts, report);
  report.units = units.length;
  if (!opts.dryRun) await writeNpsUnits(db, units, opts.now());

  const codeByWdId = await npsCodeIndex(db);
  report.codes = codeByWdId.size;
  const unitByCode = new Map(units.map((unit) => [unit.unitCode, unit]));
  const candidates = await fetchNpsCandidates(db, [...codeByWdId.keys()]);
  report.candidates = candidates.length;

  const staged: StagedRow[] = [];
  for (const candidate of candidates) {
    // `wdIds` comes back sorted, so the first id naming a code is a deterministic pick even when a
    // record carries several QIDs. The overlap query guarantees at least one maps.
    const code = candidate.wdIds.map((id) => codeByWdId.get(id)).find((c) => c !== undefined);
    if (code === undefined) continue;
    const unit = unitByCode.get(code);
    if (!unit) {
      report.unknownUnit += 1;
      continue;
    }
    const row = stagedFromUnit(candidate, unit);
    if (!row) {
      report.emptyUnit += 1;
      continue;
    }
    staged.push(row);
    if (row.description && !candidate.hasDescription) report.fillsDescription += 1;
    if (row.mediaRefs.length > 0) report.withPhoto += 1;
    else if (unit.images.length > 0) report.noPdPhoto += 1;
  }
  report.staged = staged.length;
  if (!opts.dryRun) await writeStaged(db, staged, opts.now());

  opts.log(
    `${report.units} units · ${report.candidates} candidates · ${report.staged} staged · ` +
      `${report.withPhoto} with a photo`,
  );
  return report;
}

/** The `/parks` envelope — `total` arrives as a string, as do `limit` and `start`. */
interface ParksEnvelope {
  total: string;
  data: ParkDto[];
}

interface ParkDto {
  parkCode?: string;
  fullName?: string;
  name?: string;
  description?: string;
  designation?: string;
  states?: string;
  url?: string;
  images?: { url?: string; title?: string; credit?: string; altText?: string }[];
}

/** Fetch every unit, paging on the envelope's own `total` in case the corpus ever outgrows a page. */
async function fetchUnits(opts: NpsOptions, report: NpsReport): Promise<NpsUnit[]> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const units: NpsUnit[] = [];
  for (let start = 0; ;) {
    const res = await fetchImpl(`${PARKS_URL}?limit=${PAGE_LIMIT}&start=${start}`, {
      headers: {
        "X-Api-Key": opts.apiKey,
        "User-Agent": opts.userAgent,
        accept: "application/json",
      },
      signal: AbortSignal.timeout(60_000),
    });
    report.requests += 1;
    if (res.status === 429) {
      throw new Error(
        "the NPS API rate-limited this key (HTTP 429) — api.data.gov budgets are hourly, so wait " +
          "and re-run (DEMO_KEY allows 30/hour; a registered key 1,000/hour)",
      );
    }
    if (!res.ok) throw new Error(`NPS /parks answered ${res.status} — nothing staged, try again`);
    const body = (await res.json()) as ParksEnvelope;
    for (const park of body.data) {
      const unit = unitOf(park);
      if (unit) units.push(unit);
    }
    const total = Number.parseInt(body.total, 10);
    start += body.data.length;
    if (!Number.isFinite(total) || start >= total || body.data.length === 0) break;
    await new Promise((resolve) => setTimeout(resolve, PAGE_INTERVAL_MS));
  }
  return units;
}

/** One park record as the cache stores it — or nothing, for a row missing its code or name. */
function unitOf(park: ParkDto): NpsUnit | undefined {
  const unitCode = park.parkCode?.trim().toLowerCase();
  const name = park.fullName?.trim() || park.name?.trim();
  if (!unitCode || !name) return undefined;
  return {
    unitCode,
    name,
    ...(park.description?.trim() ? { description: park.description.trim() } : {}),
    ...(park.designation?.trim() ? { designation: park.designation.trim() } : {}),
    ...(park.states?.trim() ? { states: park.states.trim() } : {}),
    ...(park.url?.trim() ? { website: park.url.trim() } : {}),
    images: (park.images ?? []).flatMap((image) =>
      image.url
        ? [
            {
              url: image.url,
              ...(image.title ? { title: image.title } : {}),
              ...(image.credit ? { credit: image.credit } : {}),
              ...(image.altText ? { altText: image.altText } : {}),
            },
          ]
        : [],
    ),
  };
}
