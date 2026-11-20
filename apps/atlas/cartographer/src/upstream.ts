/**
 * The namespaced upstream-identifier vocabulary — `apps/atlas/doc/spec/place-identity.md` §1.
 *
 * One table answering the questions that must never disagree: **is this a well-formed id in that
 * namespace**, **may identity be established with it**, and **does something have to vouch for it first**.
 * They are asked from two directions — stage 1 builds ids out of OSM tags, stage 2 builds them out of
 * Wikidata claims — and a form accepted on one side and rejected on the other is a merge that half-happens.
 * The first cut had the regexes inline in `osm.ts`, which is exactly where a second copy would have appeared.
 *
 * **Never invented** (`apps/atlas/doc/spec/place-identity.md` §1): a value that does not match its
 * namespace's form yields nothing rather than a plausible-looking id. A guessed id is worse than a
 * missing one, because it will match something — a missing id costs one unmatched record, a wrong
 * one corrupts a place.
 */
import { parseContribSourceId } from "@beaconsgg/place-taxonomy";

interface Namespace {
  /**
   * The valid form of the bare value, after the `namespace:` prefix.
   *
   * A `test`-shaped thing rather than a `RegExp`, because one namespace's form is **owned by
   * another module** and borrowing its parser is the point: three programs spell a contribution id
   * and a fourth copy of the pattern would be a divergence nothing errors on.
   */
  pattern: { test(value: string): boolean };
  /**
   * Whether two records sharing this id may be merged on it, before the gate in `identity.ts` has
   * its say. `apps/atlas/doc/spec/place-identity.md` §3 tier 1 lists exactly these id kinds.
   */
  mergeKey: boolean;
  /**
   * Whether something must **vouch** for the id before it can establish identity.
   *
   * True for `wd:` alone today: a QID is only an identity claim if the entity it names is a place, and
   * only the concordance knows that. An id awaiting evidence is neither usable nor refused — a third
   * state, and keeping it distinct is what stops an unrun concordance reading as a dataset with no
   * cross-references.
   */
  needsEvidence?: true;
}

const NAMESPACES = {
  /** `osm:w/586464226`. Wikidata's own one-letter convention, not the `way/…` form a `sourceId` uses. */
  osm: { pattern: /^[nwr]\/\d+$/, mergeKey: true },
  wd: { pattern: /^Q\d+$/, mergeKey: true, needsEvidence: true },
  /** Eight digits. Six us-west rows put a *URL* in `ref:nrhp`, which this is what refuses. */
  nrhp: { pattern: /^\d{8}$/, mergeKey: true },
  gnis: { pattern: /^\d+$/, mergeKey: true },
  /**
   * A Commons category is a *set of photos of this place* — useful to stage 4, and **never** an
   * identity claim. `apps/atlas/doc/spec/place-identity.md` §3 tier 1 omits it, and mappers
   * routinely tag a parent category (`Category:Churches in Seattle` on each church), which merging
   * on would fuse a city's churches.
   */
  commons: { pattern: /^Category:.+$/, mergeKey: false },
  /**
   * `contrib:beacon.example/01ARZ3NDEKTSV4RRFFQ69G5FAV` — a place a player submitted to a Beacon
   * server, exported back here (`apps/atlas/doc/spec/beacon-integration.md` §9). Host, then that
   * server's place unique.
   *
   * **`mergeKey: true`, and it is safe here in a way `wd:` is not.** The gate exists because a QID
   * is asserted by *third parties* about things that are not places — `wikidata=Q108485435` on 54
   * cameras means "Flock Safety, a surveillance company". Nobody but the issuing server ever asserts
   * a contribution id, and two records carrying one are the same submission exported twice. The
   * distance gate still applies; it just never has anything to refuse.
   *
   * The id is also what keeps the round trip honest in the other direction: it lets a builder tell
   * "an independent source agrees with this" from "this is the assertion I published last month",
   * and it is how the originating server recognises its own contribution coming home instead of
   * duplicating it (`apps/atlas/doc/spec/place-identity.md` §7).
   */
  contrib: {
    pattern: { test: (value) => parseContribSourceId(value) !== undefined },
    mergeKey: true,
  },
} as const satisfies Record<string, Namespace>;

/**
 * `nps:` is listed by `apps/atlas/doc/spec/place-identity.md` §1 and is deliberately **absent**:
 * the NPS source landed without adding it, which settled the question rather than deferring it.
 *
 * The first cut had it here with `mergeKey: true` and no pattern, which read as "the day an NPS source
 * lands its ids join up" — and was unreachable, because the sanctioned builder refuses a namespace whose
 * form it does not know. A promise nothing can keep is worse than an absence: `canEstablishIdentity`
 * returns false for an unknown namespace, so an `nps:` id would be carried rather than merged on, quietly.
 *
 * The source then shipped **derived** (`nps.ts`): it names its parent record and asserts no ids at all,
 * so nothing produces an `nps:` id and a row here would still be the same unkeepable promise. The unit
 * code lives where a join key belongs — a concordance claim (`parkCodeClaim`), like P18. If a future
 * *non-derived* federal source ever asserts unit codes, this is where its namespace lands, with a form
 * verified against the live API (`^[a-z]{4}$` — but verify; codes like `npsa` and `wwii` are 4-letter
 * lowercase today, and today is doing the load-bearing work in that sentence).
 */
export type UpstreamNamespace = keyof typeof NAMESPACES;

/** Every namespace and its rules — exported so a test can assert the table is internally consistent. */
export const UPSTREAM_NAMESPACES: Readonly<Record<UpstreamNamespace, Namespace>> = NAMESPACES;

/** The namespace prefix of an id — `osm:w/123` → `osm`. Empty for anything unprefixed. */
export function namespaceOf(id: string): string {
  const colon = id.indexOf(":");
  return colon > 0 ? id.slice(0, colon) : "";
}

/** The bare value inside an id — `wd:Q2680081` → `Q2680081`. The inverse of {@link upstreamId}. */
export function upstreamValue(id: string): string {
  return id.slice(id.indexOf(":") + 1);
}

/**
 * Whether identity may be established with this id — **known namespace, valid form, and a merge key**.
 *
 * The form check matters because ids arrive read back out of `source_records`, not only freshly built:
 * checking the prefix alone would trust `wd:not-a-qid` and `nrhp:https://…`, which is the "a guessed id
 * is worse than an absent one" failure arriving through the door this module forgot to lock.
 */
export function canEstablishIdentity(id: string): boolean {
  const namespace = NAMESPACES[namespaceOf(id) as UpstreamNamespace] as Namespace | undefined;
  return namespace !== undefined && namespace.mergeKey && namespace.pattern.test(upstreamValue(id));
}

/** Whether something must vouch for this id before it can establish identity. See {@link Namespace}. */
export function needsEvidence(id: string): boolean {
  const namespace = NAMESPACES[namespaceOf(id) as UpstreamNamespace] as Namespace | undefined;
  return namespace?.needsEvidence === true;
}

/**
 * A namespaced upstream id, or nothing when the value is not a well-formed member of that namespace.
 *
 * The value is trimmed but otherwise taken as given — no case folding, no zero-stripping, no
 * reformatting. Two sources spelling the same id differently is a real problem, and the honest place to
 * solve it is a stated rule per namespace, not a normalizer that quietly makes unequal things equal.
 */
export function upstreamId(namespace: UpstreamNamespace, raw: string): string | undefined {
  const value = raw.trim();
  return NAMESPACES[namespace].pattern.test(value) ? `${namespace}:${value}` : undefined;
}
