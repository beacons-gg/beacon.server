/**
 * Stage 2a — the Wikidata concordance.
 *
 * `apps/atlas/doc/spec/place-identity.md` §2's realization: **most of the cross-source linking has
 * already been done by someone else.** Wikidata carries external-identifier properties for exactly
 * the datasets Atlas wants to join, it is CC0, and it has been human-reviewed at a scale we could
 * never fund. This stage copies the part of it that concerns places in our staging, once, into a
 * local table — so identity resolution is a local, deterministic, instantly re-runnable pass rather
 * than 29,000 network calls.
 *
 * **Taken over the API, not from the dump** (`apps/atlas/doc/spec/sources.md` §1). A us-west
 * extract asserts 28,877 distinct QIDs; at 50 per request that is ~578 paced requests, about five
 * minutes, against a 71 GB download plus a streaming pass. The dump earns its keep when a build
 * goes continental — treat it as an optimization with a trigger, not a prerequisite.
 *
 * Separate from `resolve` on purpose. `apps/atlas/doc/spec/cartographer.md` §1 requires that
 * re-running a later stage never mean re-running an earlier one, and identity is the thing we
 * expect to re-derive repeatedly while the gate's thresholds are still being argued with.
 * Re-deriving it must not re-ask Wikidata.
 */
import { commonsCategoryTitle } from "@beaconsgg/place-taxonomy";
import { BATCH, type WikidataEntity, type WikimediaClient } from "@beaconsgg/wikimedia";
import type { Evidence } from "./identity";
import type { ConcordanceRow, Querier } from "./store";
import { fetchQidsToFetch, readConcordance, writeConcordance } from "./store";
import { upstreamId, type UpstreamNamespace } from "./upstream";

/**
 * The properties this stage reads, with what each must **still** be.
 *
 * `apps/atlas/doc/spec/place-identity.md` §2 asks for this check by name: property ids get
 * deprecated, split and reused, and a property that quietly changed meaning resolves nothing while
 * looking exactly like a region with no cross-references — the same failure shape as a batch of
 * throttled lookups looking like places without articles. Existence alone does not catch it; P8460
 * and P2528 are live ids meaning "applies if regular expression matches" and "earthquake
 * magnitude". So the datatype and the label are both asserted.
 *
 * Every id and datatype below was **verified against the live ontology on 2026-08-05**, including
 * two that `apps/atlas/doc/spec/place-identity.md` hedged about: P11693 and P10689 exist, so the
 * concordance bridges OSM nodes and ways, not only relations.
 */
export const CONCORDANCE_PROPERTIES = [
  { pid: "P402", datatype: "external-id", label: "OpenStreetMap relation ID", into: osmRef("r") },
  { pid: "P10689", datatype: "external-id", label: "OpenStreetMap way ID", into: osmRef("w") },
  { pid: "P11693", datatype: "external-id", label: "OpenStreetMap node ID", into: osmRef("n") },
  { pid: "P649", datatype: "external-id", label: "NRHP reference number", into: ref("nrhp") },
  { pid: "P590", datatype: "external-id", label: "GNIS Feature ID", into: ref("gnis") },
  { pid: "P373", datatype: "string", label: "Commons category", into: commonsCategory },
  /** Not an identifier — stage 4's image claim, stored now because it costs nothing extra to ask. */
  { pid: "P18", datatype: "commonsMedia", label: "image" },
  /**
   * Not an identifier either — the **logo** claim, P18's sibling for `brand-wikidata` media refs
   * (`apps/atlas/doc/spec/sources.md` §3's brand-logo tier). A brand QID reaches the concordance
   * through the media-ref half of `fetchQidsToFetch`'s population, never as an upstream id — a
   * chain's QID on 40 branches is the tier-1 non-identity case by definition. Stage 4 reads it
   * through {@link logoClaim}, and deliberately never falls back to a brand's P18: that is
   * typically the company headquarters, the wrong image for a local branch. Measured 2026-08-07:
   * 106 of the 226 brand QIDs staging references carry one, covering 4,547 places.
   */
  { pid: "P154", datatype: "commonsMedia", label: "logo image" },
  /**
   * Not an identifier either — the NPS source's **join key** (`apps/atlas/doc/spec/sources.md` §2:
   * "NPS unit codes, plus `wd:` bridging"). Deliberately no `into`: an NPS record is *derived* — it
   * joins its parent's entity by naming it, never by asserting ids — so turning this into an `nps:`
   * upstream id would create a shared-identifier population for a source that the place identity
   * spec's template keeps out of the graph entirely. The nps stage reads it through {@link
   * parkCodeClaim}, the `imageClaim` pattern.
   *
   * Verified live 2026-08-06: datatype `external-id`, label "Park Alpha Code". (P3749 is Google Maps;
   * P8649 numbers nps.gov *pages*, not units.)
   */
  { pid: "P4083", datatype: "external-id", label: "Park Alpha Code" },
  /**
   * P4083's sibling for the ridb stage — the same derived-source join (no `into`, same reasoning as
   * above): a `wd:` entity claiming a Recreation.gov campground id is Wikidata asserting "this place
   * is that RIDB facility". Verified live 2026-08-07: datatype `external-id`, formatter
   * `recreation.gov/camping/campgrounds/$1`, and that id space **is** RIDB's `FacilityID` (the spec's
   * own facility example fits the formatter). P3714 "Recreation.gov point of interest ID" is
   * deliberately NOT asked for: which RIDB entity a `/camping/poi/` id names is unverified, and a
   * join into the wrong id space would misdescribe places silently.
   */
  { pid: "P6747", datatype: "external-id", label: "Recreation.gov campground ID" },
  /**
   * Not an identifier either, and the single most useful thing here: whether the entity **is somewhere**.
   * It is how the gate tells a lighthouse from the surveillance company that operates 54 cameras.
   */
  { pid: "P625", datatype: "globe-coordinate", label: "coordinate location" },
] as const;

/** Properties whose values become upstream ids — the concordance proper. */
const ID_PROPERTIES = CONCORDANCE_PROPERTIES.filter(
  (property): property is (typeof CONCORDANCE_PROPERTIES)[number] & { into: RefBuilder } =>
    "into" in property,
);

/** The one property whose *presence* is the answer. */
const COORDINATE_PID = "P625";

/** The image claim, read by stage 4 through {@link imageClaim}. */
const IMAGE_PID = "P18";

/** The logo claim, read by stage 4 through {@link logoClaim}. */
const LOGO_PID = "P154";

/** The NPS unit-code claim, read by the nps stage through {@link parkCodeClaim}. */
const PARK_CODE_PID = "P4083";

/** The RIDB facility-id claim, read by the ridb stage through {@link facilityIdClaim}. */
const RIDB_FACILITY_PID = "P6747";

type RefBuilder = (value: string) => string | undefined;

function osmRef(letter: string): RefBuilder {
  return (value) => upstreamId("osm", `${letter}/${value}`);
}

function ref(namespace: UpstreamNamespace): RefBuilder {
  return (value) => upstreamId(namespace, value);
}

/**
 * Wikidata states a Commons category as a bare name; OSM's `wikimedia_commons` tag states the `Category:`
 * form. They must be spelled identically or the bridge silently misses, so both go through the shared
 * normalizer rather than each knowing the prefix.
 */
function commonsCategory(value: string): string | undefined {
  return upstreamId("commons", commonsCategoryTitle(value));
}

export interface ConcordanceReport {
  /** QIDs this run set out to ask about. */
  wanted: number;
  fetched: number;
  /** Wikidata answered that there is no such entity — a fact, recorded so we never ask again. */
  absent: number;
  /** Never answered for. **Deliberately left unrecorded**, so the next run asks again. */
  unanswered: number;
  requests: number;
}

/**
 * Fetch and store the concordance for every QID staging asserts that we have no answer for yet.
 *
 * Durable per batch, so an interrupted run keeps its work — the property
 * `apps/atlas/doc/spec/cartographer.md` §0 calls non-negotiable, and the reason `osm-enrich` costs
 * minutes rather than hours to resume.
 */
export async function buildConcordance(
  db: Querier,
  wiki: WikimediaClient,
  opts: {
    limit: number;
    refresh: boolean;
    dryRun: boolean;
    now: () => string;
    log: (message: string) => void;
  },
): Promise<ConcordanceReport> {
  await preflight(wiki);

  const qids = await fetchQidsToFetch(db, { limit: opts.limit, refresh: opts.refresh });
  const report: ConcordanceReport = {
    wanted: qids.length,
    fetched: 0,
    absent: 0,
    unanswered: 0,
    requests: 0,
  };

  for (let start = 0; start < qids.length; start += BATCH.ids) {
    const batch = qids.slice(start, start + BATCH.ids);
    const answer = await wiki.entities(batch);
    report.requests += 1;

    if (answer.unavailable) {
      // Nothing written. A throttled batch is not knowledge, and writing an empty row for it would
      // turn "we never asked successfully" into "this QID has no claims" — permanently, since the
      // next run's `NOT EXISTS` check would then skip it.
      report.unanswered += batch.length;
      continue;
    }

    const rows: ConcordanceRow[] = [];
    for (const qid of batch) {
      const entity = answer.entities.get(qid);
      if (entity) {
        rows.push({
          qid,
          claims: keptClaims(entity),
          ...(entity.enwikiTitle ? { enwikiTitle: entity.enwikiTitle } : {}),
          absent: false,
        });
        report.fetched += 1;
      } else if (answer.absent.has(qid)) {
        rows.push({ qid, claims: null, absent: true });
        report.absent += 1;
      } else {
        // In the reply's scope but not in it — neither an entity nor declared missing. Treated as
        // unanswered rather than absent, for the same reason as the batch case above.
        report.unanswered += 1;
      }
    }

    if (!opts.dryRun) await writeConcordance(db, rows, opts.now());
    opts.log(
      `concordance ${Math.min(start + batch.length, qids.length)}/${qids.length} — ` +
        `${report.fetched} entities, ${report.absent} absent, ${report.unanswered} unanswered`,
    );
  }

  return report;
}

/**
 * Assert every property still exists, still has its expected datatype, and still carries its expected
 * label — **before** a run that would otherwise resolve nothing and look like a thin dataset.
 *
 * A batch Wikidata never answered fails too. That is not a give-up recorded as a fact; it is the
 * opposite — refusing to build a concordance on assumptions we could not check.
 */
async function preflight(wiki: WikimediaClient): Promise<void> {
  const answer = await wiki.properties(CONCORDANCE_PROPERTIES.map((property) => property.pid));
  if (answer.unavailable) {
    throw new Error(
      "could not verify the Wikidata property set (Wikidata did not answer) — not building a " +
        "concordance on unverified property ids; try again",
    );
  }

  const problems: string[] = [];
  for (const property of CONCORDANCE_PROPERTIES) {
    const actual = answer.properties.get(property.pid);
    if (!actual) {
      problems.push(`${property.pid} (${property.label}) no longer exists`);
      continue;
    }
    if (actual.datatype !== property.datatype) {
      problems.push(
        `${property.pid} is now datatype "${actual.datatype}", expected "${property.datatype}"`,
      );
    }
    if (actual.label?.toLowerCase().trim() !== property.label.toLowerCase()) {
      problems.push(
        `${property.pid} is now labelled "${actual.label}", expected "${property.label}"`,
      );
    }
  }
  if (problems.length > 0) {
    throw new Error(
      `the Wikidata property set has changed under us:\n  ${problems.join("\n  ")}\n` +
        "Check each against wikidata.org and update CONCORDANCE_PROPERTIES. Resolving against a " +
        "repurposed property yields no matches, which is indistinguishable from a dataset with none.",
    );
  }
}

/**
 * The claims worth storing — ours, not all of them.
 *
 * `wbgetentities` cannot filter properties server-side, so a busy entity arrives with hundreds of
 * claims. Storing them all would make this table many times larger than the staging it serves, for
 * data no stage reads.
 */
function keptClaims(entity: WikidataEntity): Record<string, WikidataEntity["claims"][string]> {
  const kept: Record<string, WikidataEntity["claims"][string]> = {};
  for (const property of CONCORDANCE_PROPERTIES) {
    const values = entity.claims[property.pid];
    if (values && values.length > 0) kept[property.pid] = values;
  }
  return kept;
}

/**
 * A stored concordance row as `identity.ts` sees it: what it asserts, and whether it may establish
 * identity at all.
 *
 * This is the whole translation layer, and it is why `identity.ts` never learns that Wikidata has
 * P-numbers — the same seam that keeps OSM's tags out of everything downstream of stage 1. "Has P625"
 * becomes the generic "establishes identity", so the next source that carries cross-references reuses the
 * machinery instead of adding a branch to the resolver.
 *
 * An **absent** entity asserts nothing and establishes nothing, which is correct rather than merely safe:
 * Wikidata told us there is nothing there, so there is nothing to merge on.
 */
/**
 * The Commons file name an entity's image claim names, if it has one.
 *
 * Here rather than in the media stage because **this file is the whole translation layer** — the reason
 * `identity.ts` never learns that Wikidata has P-numbers, and the reason the property is declared in
 * `CONCORDANCE_PROPERTIES` above with a datatype the preflight checks. Stage 4 asking for `claims["P18"]`
 * itself would put a P-number in a second file with nothing tying it to that declaration.
 *
 * `undefined` covers both "answered, no image" and a claim whose value is not a string; the *caller*
 * distinguishes those from "no row at all", which is the state that means we never asked.
 */
export function imageClaim(row: ConcordanceRow): string | undefined {
  return firstStringClaim(row, IMAGE_PID);
}

/**
 * The logo an entity claims, if it claims one — {@link imageClaim}'s sibling for `brand-wikidata`
 * refs. **This function is the no-P18-fallback rule's one home**: a brand's P18 is typically its
 * headquarters, and a Sunnyvale candy shop wearing a photo of an Illinois office park is worse than
 * the shop having no photo. Every other site that mentions the rule points here.
 */
export function logoClaim(row: ConcordanceRow): string | undefined {
  return firstStringClaim(row, LOGO_PID);
}

/** A row's first string-valued claim for a property — the core the four claim readers share. */
function firstStringClaim(row: ConcordanceRow, pid: string): string | undefined {
  const first = row.claims?.[pid]?.find((value) => value.kind === "string");
  return first?.kind === "string" ? first.value : undefined;
}

/**
 * The NPS unit code an entity claims, if it claims one — {@link imageClaim}'s sibling, and the same
 * seam: the nps stage asks "which park unit is this entity", never "what does P4083 hold".
 *
 * **Lowercased here**, because the two sides disagree and this is the one place that sees both: the NPS
 * API's `parkCode` is lowercase (`olym`), while Wikidata's values are mixed (`bela`, `GREE`, `ARCH`).
 * Normalizing at the seam means neither the index nor the API mapping ever learns the mismatch existed.
 */
export function parkCodeClaim(row: ConcordanceRow): string | undefined {
  const first = row.claims?.[PARK_CODE_PID]?.find((value) => value.kind === "string");
  return first?.kind === "string" && first.value ? first.value.trim().toLowerCase() : undefined;
}

/**
 * The RIDB facility id an entity claims, if it claims one — {@link parkCodeClaim}'s sibling for the
 * ridb stage. Digits-only by the property's own format constraint; trimmed, no case to normalize.
 */
export function facilityIdClaim(row: ConcordanceRow): string | undefined {
  const first = row.claims?.[RIDB_FACILITY_PID]?.find((value) => value.kind === "string");
  const value = first?.kind === "string" ? first.value?.trim() : undefined;
  return value && /^\d+$/.test(value) ? value : undefined;
}

/**
 * The concordance rows claiming a park code / facility id — the join populations, filtered in SQL.
 * Here rather than at the call sites for the P-number rule three docblocks up: the stages consume
 * rows and claims, never property ids, and shipping ~100 matching rows beats shipping all 28k to
 * find them in JS.
 */
export function parkCodeRows(db: Querier): Promise<ConcordanceRow[]> {
  return readConcordance(db, PARK_CODE_PID);
}

export function facilityIdRows(db: Querier): Promise<ConcordanceRow[]> {
  return readConcordance(db, RIDB_FACILITY_PID);
}

export function evidenceOf(row: ConcordanceRow): Evidence {
  const claims = row.claims ?? {};
  const asserts: string[] = [];
  for (const property of ID_PROPERTIES) {
    for (const value of claims[property.pid] ?? []) {
      // Only a string snak can be an external id. A coordinate or an item in an `external-id` slot is
      // malformed data, and building an id out of it would be inventing one.
      if (value.kind !== "string" || value.value === undefined) continue;
      const id = property.into(value.value);
      if (id) asserts.push(id);
    }
  }
  return { asserts, establishesIdentity: (claims[COORDINATE_PID] ?? []).length > 0 };
}

/**
 * The concordance as an evidence map, keyed by the **full** `wd:` id.
 *
 * Keyed here rather than by bare QID so no downstream file spells the prefix or slices it back off — the
 * one place that knows the form is `upstream.ts`. A row whose QID is malformed is skipped rather than
 * turned into a plausible-looking id.
 */
export function evidenceMap(rows: readonly ConcordanceRow[]): Map<string, Evidence> {
  const map = new Map<string, Evidence>();
  for (const row of rows) {
    const id = upstreamId("wd", row.qid);
    if (id) map.set(id, evidenceOf(row));
  }
  return map;
}
