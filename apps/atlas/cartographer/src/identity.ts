/**
 * Stage 2's rules: which staged records are the same place, and which Atlas id that place keeps.
 *
 * **Pure.** No database, no network, no clock, and no randomness —
 * `apps/atlas/doc/spec/cartographer.md` §4 requires that a rebuild from the same inputs and the
 * same decisions produce the same entities, which is what makes a volume auditable. Even the id
 * minter is injected, so a test can watch identity assignment happen deterministically and a real
 * run can hand it `ulid()`.
 *
 * ## The correction this file makes to `apps/atlas/doc/spec/place-identity.md` §3
 *
 * Tier 1 as designed says a shared explicit identifier is "deterministic; no confidence score; no
 * review". Measured against the real us-west staging, that is **not safe**. 422 identifiers are shared
 * by more than one record, and 188 of them by records more than 500 m apart — because a mapper who
 * writes `wikidata=Q108485435` on a surveillance camera means *Flock Safety, an American video
 * surveillance company*, not "this camera is that company". Taken literally, tier 1 collapses 54
 * cameras 1,715 km apart into one place.
 *
 * So the rule here is narrower than the design's, and the difference is worth stating exactly:
 *
 * > **Tier 1 is deterministic about the _claim_, not about the _merge_.** A shared identifier is strong
 * > evidence. An identifier asserted by many records spread over kilometres, or naming an entity that
 * > is not a place at all, is evidence that the tag does not mean identity. Recognizing that is
 * > deterministic too — no human needed — but it is a **gate**, and a gate's refusals must be visible.
 *
 * A refused identifier is still **carried** (the source did say it) and simply is not merged on, and
 * every refusal is recorded with its evidence. Never letting "this evidence is ambiguous" collapse into
 * either "these are one place" or "there was no evidence" is the same rule this pipeline already lives
 * by everywhere else.
 *
 * ## Derivation is not evidence
 *
 * A record built out of another record — a Wikipedia article staged against the OSM record that cited it —
 * joins its parent's entity by **naming** it, through `StagedIdentity.derivedFrom`, and never by restating
 * its identifiers. The claim it makes is `record: → record:`, so it contributes no identifier node, no
 * asserter to the span measurement and nothing to either tier's count. The ids in `upstreamIds` are what
 * sources said and the gate rules on how many records said each one, so a copy made to buy a union-find edge
 * corrupts both readings at once — `StagedIdentity.derivedFrom` measures what that cost.
 */
import type {
  AmbiguousId,
  DecisionRow,
  EntityWrite,
  PriorEntity,
  RecordRef,
  StagedIdentity,
  UpstreamSpan,
} from "./store";
import { canEstablishIdentity, needsEvidence } from "./upstream";

/**
 * How far apart two records sharing an identifier may be and still be one place, in metres.
 *
 * 500 m is generous for a place mapped twice (duplicates land metres apart) and far short of the
 * cases this exists to refuse. Deliberately **not** paired with a geometry-intersection escape
 * hatch for large features yet: a refusal is two pins near each other, which the place identity
 * spec (§3, "No fuzzy tier") calls the cheap error, and `ambiguous_ids` names every one — so
 * evidence can decide whether the hatch is needed instead of a guess now.
 */
export const MERGE_SPAN_M = 500;

/**
 * What some source vouches for about one identifier — namespace-neutral, on purpose.
 *
 * This file must not know that Wikidata has P-numbers, in the same way stage 1's downstream never learns
 * that OSM has tags. `concordance.ts` owns that vocabulary and translates it into these two statements;
 * `upstream.ts` says which namespaces need vouching for at all. Without that seam, every future source
 * that carries cross-references — GNIS, NPS, NRHP — needs its own branch here, its own map and its own
 * report counter.
 */
export interface Evidence {
  /** Other namespaced ids this identifier's entity asserts are itself — the tier-2 bridge. */
  asserts: readonly string[];
  /**
   * Whether the entity it names may establish identity at all.
   *
   * For Wikidata that is "does it have coordinates" — the cheapest true statement about whether a QID is
   * an identity claim. Flock Safety has no `P625`; a lighthouse does. It refuses 252 of 28,877 QIDs on
   * us-west, including all 54 of those cameras.
   */
  establishesIdentity: boolean;
}

export interface IdentityInput {
  records: readonly StagedIdentity[];
  /** Keyed by the **full** namespaced id, so nothing here has to spell a prefix. */
  evidence: ReadonlyMap<string, Evidence>;
  spans: readonly UpstreamSpan[];
  decisions: readonly DecisionRow[];
  prior: readonly PriorEntity[];
}

/** One place, with the id it keeps and everything it was built from, plus how it got that id. */
export interface ResolvedEntity extends EntityWrite {
  via: "new" | "reused" | "merged";
}

/** An identifier the gate refused, and why — the shape `ambiguous_ids` stores. */
export type GatedId = AmbiguousId;

export interface IdentityReport {
  records: number;
  entities: number;
  minted: number;
  reused: number;
  /** Components that absorbed more than one prior entity — a merge, shipped as aliases. */
  merged: number;
  /** Ids retired into aliases this run. */
  aliased: number;
  /** Prior entities whose merge keys landed in more than one component. */
  split: number;
  /** Prior entities that hold no record this build. Their rows and ids stay; absence is not an alias. */
  withdrawn: string[];
  /** Records that share an identifier with another record, before the concordance is applied. */
  tier1Records: number;
  /** Records that only join up *because* of the concordance — what tier 2 is actually buying. */
  tier2Records: number;
  /**
   * Records that joined their entity by naming the record they were derived from.
   *
   * Its own counter, and excluded from both tiers above, because a derived record is not a second source
   * agreeing — it is the same source read a second way. `StagedIdentity.derivedFrom` has what folding it in
   * cost, measured.
   */
  derivedRecords: number;
  /**
   * Ids that need vouching for and have none yet — the concordance has not run, or not reached them.
   *
   * Reported apart from the gate's refusals because it is a stage that has not run, not a finding about
   * the data, and one counter for both would make the two indistinguishable.
   */
  awaitingEvidence: number;
  /**
   * `distinct` verdicts whose two ends stayed connected anyway — a veto that did nothing.
   *
   * `alsoVia` names the asserter's *other* claims that still reach the same place, because a bare "that
   * changed nothing" is a dead end: measured on the real extract, two records that share an NRHP number
   * usually share a QID too, so severing one claim leaves them merged. Naming the rest turns the warning
   * into the next thing to do.
   */
  ineffectiveVetoes: { a: string; b: string; alsoVia: string[] }[];
}

export interface IdentityResult {
  entities: ResolvedEntity[];
  gated: GatedId[];
  report: IdentityReport;
}

/**
 * Resolve every staged record into an entity, reusing the ids the previous build assigned.
 *
 * `mintId` is injected rather than called here so this stays pure. `ulid()` is the one place
 * `apps/atlas/doc/spec/cartographer.md` §4 permits non-determinism ("never into matching or id
 * assignment beyond the initial ULID"), and confining it to the caller is what makes that
 * auditable.
 */
export function resolveIdentity(
  input: IdentityInput,
  opts: { mintId: () => string },
): IdentityResult {
  const { gated, pending } = gateIdentifiers(input);
  const blocked = new Set([...gated.map((entry) => entry.upstreamId), ...pending]);
  // `pending` is in here for the same reason `gated` is, and for a *different* reason: nothing is known
  // about that QID, so merging on it would be acting on evidence we never obtained. It is reported apart
  // from the refusals precisely because it is a stage that has not run, not a finding about the data.
  const usable = (id: string): boolean => canEstablishIdentity(id) && !blocked.has(id);

  // Filtered once: the same rows drive both the suppression set and the effectiveness check, and two
  // separately-written filters that must select the same rows are one place for them to disagree.
  const distinct = input.decisions.filter((d) => d.verdict === "distinct");
  const forbidden = new Set(distinct.map((d) => pairKey(d.a, d.b)));

  // Every claim is an edge from **the thing that made it** to the id it named: a record to each of its
  // ids, a Wikidata entity to each id it asserts. Two records sharing an id are connected *through* it.
  //
  // Modelling the asserter as a node rather than linking a group's ids to each other is what makes a
  // `distinct` verdict mean something precise — "this record's claim to that id is wrong" — and always
  // effective. Linking ids pairwise instead left a veto that removed the only edge naming the record
  // still merging it, because the record was looked up *by* the id it had just been separated from.
  const recordClaims = input.records.map((record): Claim => ({
    by: recordNode(record),
    sameAs: record.upstreamIds.filter(usable),
  }));
  // A derived record's parent, naming the record itself — the one claim with a `record:` node on *both*
  // ends, and so the one that contributes no identifier to the graph. Subject to `forbidden` like any
  // other, so a reviewer can sever a derivation that turned out to be about a different place.
  const derivedClaims: Claim[] = [];
  for (const record of input.records) {
    if (record.derivedFrom) {
      derivedClaims.push({ by: recordNode(record.derivedFrom), sameAs: [recordNode(record)] });
    }
  }
  const bridgeClaims: Claim[] = [];
  for (const [by, evidence] of [...input.evidence].sort(([a], [b]) => (a < b ? -1 : 1))) {
    // An id the gate refused asserts nothing about a place we are mapping. `usable` already covers the
    // "does not establish identity" case, because that is what put it in `blocked`.
    if (!usable(by)) continue;
    const sameAs = evidence.asserts.filter(usable);
    if (sameAs.length > 0) bridgeClaims.push({ by, sameAs });
  }
  const forced: Claim[] = input.decisions
    .filter((d) => d.verdict === "same")
    .map((d) => ({ by: d.a, sameAs: [d.b] }));

  // What the sources and the build assert without the concordance: a record's own ids, plus which records
  // were built out of which. Named once because it is linked twice and reported on twice, and two
  // separately-written lists that must hold the same claims are one place for them to disagree.
  const baseClaims = [...recordClaims, ...derivedClaims];

  // Every identifier that is a **node** of the graph — the ones a claim actually named, which are
  // therefore the ones identity was established with. A `record:` node is bookkeeping and never an id.
  const graphNodes = new Set<string>();
  for (const claim of [...baseClaims, ...bridgeClaims, ...forced]) {
    for (const node of claim.sameAs) if (isIdentifier(node)) graphNodes.add(node);
    if (isIdentifier(claim.by)) graphNodes.add(claim.by);
  }

  // Two unions over the same claims, so the report can say what the concordance is worth. They are
  // named for the bridge rather than for the tiers because that is the only difference between
  // them: derivation is in **both**, since it holds unconditionally —
  // `apps/atlas/doc/spec/place-identity.md` calls it "not a tier" for that reason, and a base graph
  // missing it would be one that also lost every article record.
  const withoutBridge = new Union();
  for (const claim of baseClaims) withoutBridge.link(claim, forbidden);
  const withBridge = new Union();
  for (const claim of baseClaims) withBridge.link(claim, forbidden);
  for (const claim of bridgeClaims) withBridge.link(claim, forbidden);
  for (const claim of forced) withBridge.link(claim, new Set()); // a human's verdict outranks the gate

  // ── components ────────────────────────────────────────────────────────────────────────────────
  const components = new Map<string, Component>();
  const componentFor = (root: string): Component => {
    let component = components.get(root);
    if (!component) {
      component = { ids: new Map(), records: [] };
      components.set(root, component);
    }
    return component;
  };

  // Every id a source named lands on the entity as **carried**: `upstream` is a record of what the
  // sources said, and stage 4 reads the carried ones.
  for (const record of input.records) {
    const component = componentFor(withBridge.find(recordNode(record)));
    component.records.push(record);
    for (const id of record.upstreamIds) if (!component.ids.has(id)) component.ids.set(id, false);
  }
  // A bridge's own assertions belong on the entity too — that is how
  // `apps/atlas/doc/spec/place-identity.md` §8's lighthouse publishes an NRHP number that no OSM
  // record carries.
  for (const claim of bridgeClaims) {
    const component = components.get(withBridge.find(claim.by));
    if (!component) continue;
    for (const id of [claim.by, ...claim.sameAs])
      if (!component.ids.has(id)) component.ids.set(id, false);
  }

  // Then promote to **merge key** the ids that are graph nodes, on the one component that owns each.
  //
  // Derived from the union rather than accumulated per claim, and that is the whole point: an id node
  // has exactly one root, so it can be established on exactly one entity — structurally, with nothing
  // to assert afterwards. Accumulating per claim did not have that property, and the consequences were
  // subtle: a vetoed claim still marked its id established (recording the identity the veto denied),
  // and the bridge loop marked its assertions established without checking ownership at all. Both put
  // one merge key on two entities, which made continuity oscillate — every rebuild found the id on the
  // wrong side and re-split the place, forever. The only symptom was a stubborn "1 entity split".
  for (const id of graphNodes) {
    components.get(withBridge.find(id))?.ids.set(id, true);
  }

  // Ordered by first member rather than by internal root, so a report reads in source-id order and a
  // test's expectations don't depend on which namespace happens to sort first.
  const ordered = [...components.values()]
    .filter((component) => component.records.length > 0)
    .map((component) => {
      component.records.sort(
        (a, b) => a.source.localeCompare(b.source) || a.sourceId.localeCompare(b.sourceId),
      );
      return component;
    })
    .sort((a, b) => {
      const [first, second] = [a.records[0], b.records[0]];
      if (!first || !second) return 0;
      return (
        first.source.localeCompare(second.source) || first.sourceId.localeCompare(second.sourceId)
      );
    });
  const reconciled = reconcile(ordered, input.prior, opts.mintId);

  // One tally over `via`, rather than counters kept in step with it: the three-way decision is made
  // once, per entity, and the report counts the answers.
  const tally = (via: ResolvedEntity["via"]): number =>
    reconciled.entities.filter((entity) => entity.via === via).length;

  // The two tier counters answer "how many records joined up **on evidence**", so they are taken over the
  // records that assert something rather than over every record: a derived record is the same source read a
  // second way, and counting it as agreement is circular. Narrowed once, here, where both populations are
  // named — rather than as a skip inside `joinedRecords`, which would leave a general counter quietly
  // knowing about one kind of record and every future counter rediscovering the rule.
  const asserting = input.records.filter((record) => !record.derivedFrom);
  const tier1Records = joinedRecords(asserting, withoutBridge);

  return {
    entities: reconciled.entities,
    gated,
    report: {
      records: input.records.length,
      entities: reconciled.entities.length,
      minted: tally("new"),
      reused: tally("reused"),
      merged: tally("merged"),
      aliased: reconciled.aliased,
      split: reconciled.split,
      withdrawn: reconciled.withdrawn,
      tier1Records,
      tier2Records: joinedRecords(asserting, withBridge) - tier1Records,
      derivedRecords: input.records.length - asserting.length,
      awaitingEvidence: pending.size,
      // The claim lists are passed unflattened, so the ~236k-element concatenation happens only when there
      // is actually an ineffective verdict to explain — which is what that function's docblock promises and
      // an argument-position spread quietly took away.
      ineffectiveVetoes: ineffectiveVetoes(distinct, withBridge, [baseClaims, bridgeClaims]),
    },
  };
}

/**
 * `distinct` verdicts whose two ends stayed connected anyway, each with the claims to veto next.
 *
 * Computed here rather than inline in the report because it is graph analysis, and because it should
 * cost nothing in the overwhelming case: `decisions` is empty until a human writes one, so the maps this
 * needs are built only when there is actually an ineffective verdict to explain.
 */
function ineffectiveVetoes(
  distinct: readonly DecisionRow[],
  union: Union,
  claimLists: readonly (readonly Claim[])[],
): IdentityReport["ineffectiveVetoes"] {
  const ineffective = distinct.filter((d) => union.find(d.a) === union.find(d.b));
  // Before anything is flattened or allocated, so "costs nothing when there is nothing to explain" is true
  // of the whole call and not only of this function's body.
  if (ineffective.length === 0) return [];

  const claimedBy = new Map<string, string[]>();
  /** How many distinct things assert each node — "what links them" vs "just its own name". */
  const asserters = new Map<string, number>();
  for (const claim of claimLists.flat()) {
    claimedBy.set(claim.by, [...(claimedBy.get(claim.by) ?? []), ...claim.sameAs]);
    for (const node of claim.sameAs) asserters.set(node, (asserters.get(node) ?? 0) + 1);
  }

  return ineffective.map((d) => {
    const root = union.find(d.a);
    return {
      a: d.a,
      b: d.b,
      // Only what something *else* also asserts. A record's own OSM id is in its component and is not
      // what connects it to anything, so listing it would tell the reviewer to veto a record's claim to
      // itself. A derived record's node is excluded by the same test rather than by a type check, and
      // rightly: exactly one claim names it, but if two ever did, "veto the derivation as well" is the
      // correct advice — a `decisions` row can name a record node, which is how a derivation is severed.
      alsoVia: (claimedBy.get(d.a) ?? [])
        .filter(
          (node) => node !== d.b && (asserters.get(node) ?? 0) > 1 && union.find(node) === root,
        )
        .sort(),
    };
  });
}

interface Component {
  /** Every upstream id on this entity → whether it was used to establish identity. */
  ids: Map<string, boolean>;
  records: StagedIdentity[];
}

/**
 * One node and the nodes it says are the same thing — a record, a Wikidata entity, or a reviewer.
 *
 * `sameAs` is deliberately not called `ids`: since derivation, a claim's far end can be a `record:` node
 * rather than an identifier, and a field named `ids` invited each read site to assume otherwise. Whether an
 * element is an identifier is one question with one answer — {@link isIdentifier}.
 */
interface Claim {
  by: string;
  sameAs: readonly string[];
}

/**
 * A staged record's node in the identifier graph — `record:osm/way/586464226`.
 *
 * Prefixed and filtered out of `upstream`: it is bookkeeping, not something a source asserted, and
 * `apps/atlas/doc/spec/place-identity.md` §1 forbids inventing ids. Giving every record a node also
 * means a record with no usable identifier is its own place for free, rather than needing a special
 * case — and without it, all such records would share one empty-string root and fuse into a single
 * entity.
 *
 * **Exported because this is the form a `decisions` row names.** A reviewer's `distinct` verdict says
 * "this record's claim to that identifier is wrong", so one side of it is a record; anything that writes
 * or reads a decision should spell that through here rather than reproducing the format.
 */
export function recordNode(record: RecordRef): string {
  return `${RECORD_PREFIX}${record.source}/${record.sourceId}`;
}

/**
 * Whether a graph node is an upstream identifier rather than this file's own record bookkeeping.
 *
 * One named question, because three sites ask it and a fourth forgot to. Taking a {@link RecordRef} above
 * and answering it here is also what makes a derivation's two adjacent `recordNode` calls safe: there are no
 * two string arguments left to transpose.
 */
function isIdentifier(node: string): boolean {
  return !node.startsWith(RECORD_PREFIX);
}

/** Named once: it must never collide with a real namespace. */
const RECORD_PREFIX = "record:";

/**
 * Which identifiers may not be merged on, and why.
 *
 * A QID with no concordance row yet is **not** reported as a finding: nothing is known about it, which
 * is a different statement from "it is not a place". Counting the two together would make an unrun
 * concordance look like a dataset with no cross-references — the give-up-as-fact mistake, one level up.
 */
function gateIdentifiers(input: IdentityInput): { gated: GatedId[]; pending: Set<string> } {
  const spanById = new Map(input.spans.map((span) => [span.upstreamId, span]));
  const gated: GatedId[] = [];
  const pending = new Set<string>();

  const consider = (id: string, records: number): void => {
    if (!canEstablishIdentity(id)) return;
    if (needsEvidence(id)) {
      const evidence = input.evidence.get(id);
      if (!evidence) {
        pending.add(id);
        return; // unknown, not refused — and unusable this run either way
      }
      if (!evidence.establishesIdentity) {
        gated.push({ upstreamId: id, records, reason: "not-a-place" });
        return;
      }
    }
    const span = spanById.get(id);
    if (span && span.spanM > MERGE_SPAN_M) {
      gated.push({ upstreamId: id, records, spanM: span.spanM, reason: "span" });
    }
  };

  // Every asserted id is considered, not just the shared ones: a QID that names a company is not an
  // identity claim even when only one record carries it, and letting it through would seed a bridge.
  const counts = new Map<string, number>();
  for (const record of input.records) {
    for (const id of record.upstreamIds) counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  // Keys sorted directly rather than `[...counts]`, which would allocate a tuple per entry — 260k of
  // them on the real extract — to sort by the first element anyway.
  for (const id of [...counts.keys()].sort()) consider(id, counts.get(id) ?? 0);

  return { gated, pending };
}

/**
 * How many of these records sit in a component with at least one other of them, under this union.
 *
 * Counts exactly what it is handed — the caller decides which records are evidence.
 */
function joinedRecords(records: readonly StagedIdentity[], union: Union): number {
  const sizes = new Map<string, number>();
  for (const record of records) {
    const root = union.find(recordNode(record));
    sizes.set(root, (sizes.get(root) ?? 0) + 1);
  }
  let joined = 0;
  for (const size of sizes.values()) if (size > 1) joined += size;
  return joined;
}

/** The ids a prior entity was identified *by* — see the note inside on why the filter lives here. */
function mergeKeysOf(entity: PriorEntity): string[] {
  return entity.upstream.filter((ref) => ref.mergeKey).map((ref) => ref.id);
}

/** Give each component the id the previous build gave it, or a new one. */
function reconcile(
  components: readonly Component[],
  prior: readonly PriorEntity[],
  mintId: () => string,
): { entities: ResolvedEntity[]; aliased: number; split: number; withdrawn: string[] } {
  const priorById = new Map(prior.map((entity) => [entity.id, entity]));
  // **Merge keys only.** Carried ids accumulate and are never pruned
  // (`apps/atlas/doc/spec/place-identity.md` §1), so looking a prior entity up by everything it
  // holds would re-glue exactly what the gate separated — the 54 cameras would find each other
  // again through Flock Safety's QID on the very next build. The filter lives here, in the rules,
  // rather than in the SELECT that fetched the rows: a rule enforced by a SQL `WHERE` is a rule no
  // test can evaluate.
  const priorByKey = new Map<string, string[]>();
  for (const entity of prior) {
    for (const key of mergeKeysOf(entity)) {
      const holders = priorByKey.get(key);
      if (holders) holders.push(entity.id);
      else priorByKey.set(key, [entity.id]);
    }
  }

  // How much of each prior entity each component holds — the evidence for who keeps the id on a split.
  const claims = components.map((component) => {
    const held = new Map<string, number>();
    for (const [id, mergeKey] of component.ids) {
      if (!mergeKey) continue;
      for (const priorId of priorByKey.get(id) ?? []) {
        held.set(priorId, (held.get(priorId) ?? 0) + 1);
      }
    }
    return held;
  });

  // Each prior id goes to whichever component holds most of its keys; ties to the earlier component
  // in emitted order, which is sorted by first member — so the outcome never depends on iteration
  // order of a Map. The others mint new ids: a split, and the correct, undestructive outcome per
  // `apps/atlas/doc/spec/place-identity.md` §5, where one place changes and one appears.
  const winner = new Map<string, { index: number; count: number }>();
  const spread = new Map<string, number>();
  claims.forEach((held, index) => {
    for (const [priorId, count] of held) {
      spread.set(priorId, (spread.get(priorId) ?? 0) + 1);
      if (count > (winner.get(priorId)?.count ?? -1)) winner.set(priorId, { index, count });
    }
  });

  let aliased = 0;
  const entities = components.map((component, index) => {
    const won = [...(claims[index] ?? new Map<string, number>()).keys()]
      .filter((priorId) => winner.get(priorId)?.index === index)
      .map((priorId) => priorById.get(priorId))
      .filter((entity): entity is PriorEntity => entity !== undefined)
      // Survivor first: better attested wins, and a tie goes to the smaller ULID — which is the older
      // one, since ULIDs sort by their timestamp. "The larger or better-attested part keeps the id."
      .sort((a, b) => b.members - a.members || (a.id < b.id ? -1 : 1));

    const survivor = won[0];
    // Flattened, per `apps/atlas/doc/spec/place-identity.md` §5: a loser's own aliases move onto
    // the survivor, so a consumer resolves any retired id in one step and never chases a chain a
    // mirror may only half-hold.
    const aliases = [
      ...new Set(
        won.flatMap((entity, position) =>
          position === 0 ? entity.aliases : [entity.id, ...entity.aliases],
        ),
      ),
    ].sort();
    aliased += aliases.length - (survivor?.aliases.length ?? 0);

    // One decision, recorded once. Counting it into accumulators *as well* left two encodings of the
    // same fact that had to agree, and a fourth `via` value would have updated only one of them.
    const via: ResolvedEntity["via"] = !survivor ? "new" : won.length > 1 ? "merged" : "reused";
    return {
      id: survivor?.id ?? mintId(),
      members: component.records.map((record) => ({
        source: record.source,
        sourceId: record.sourceId,
      })),
      upstream: [...component.ids]
        .filter(([id]) => !id.startsWith(RECORD_PREFIX))
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([id, mergeKey]) => ({ id, mergeKey })),
      aliases,
      via,
    };
  });

  // One pass, not a scan per prior entity. `entities.some(e => e.aliases.includes(id))` inside the
  // filter below was O(prior x entities): invisible on a first build (nothing is withdrawn when there is
  // no prior), and 225k x 225k on the first *re*build — a hang rather than a slowdown at scale.
  const aliasedIds = new Set(entities.flatMap((entity) => entity.aliases));

  return {
    entities,
    aliased,
    split: [...spread.values()].filter((count) => count > 1).length,
    // Won nothing, and is not an alias of something that did: no record claims it this build. Its row
    // and its id stay — an id is never reused — and absence is reported, never turned into an alias.
    //
    // The alias exclusion is not cosmetic. `apps/atlas/doc/spec/place-identity.md` §5 insists
    // absence and an alias are different things, and an entity that merged away holds no record *by
    // design* — reporting it as withdrawn would mean every past merge is re-announced as a vanished
    // place on every future build, forever. `winner` already implies it was not kept: an id is only
    // a survivor if it won a component.
    withdrawn: prior
      .filter((entity) => winner.get(entity.id) === undefined && !aliasedIds.has(entity.id))
      .map((entity) => entity.id),
  };
}

/** Order-independent key for an unordered pair. */
function pairKey(a: string, b: string): string {
  return a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`;
}

/** Union-find over the identifier graph, one claim at a time. */
class Union {
  private readonly parent = new Map<string, string>();

  find(x: string): string {
    let root = x;
    for (let next = this.parent.get(root); next !== undefined; next = this.parent.get(root)) {
      root = next;
    }
    // Path compression, so a long chain is walked once rather than on every lookup.
    for (let node = x; node !== root;) {
      const next = this.parent.get(node) ?? root;
      this.parent.set(node, root);
      node = next;
    }
    return root;
  }

  /** Link an asserter to each node it claims is itself, skipping any claim a reviewer has vetoed. */
  link(claim: Claim, forbidden: ReadonlySet<string>): void {
    for (const node of claim.sameAs) {
      if (forbidden.has(pairKey(claim.by, node))) continue;
      const rootA = this.find(claim.by);
      const rootB = this.find(node);
      if (rootA === rootB) continue;
      // Smaller string becomes the root, so a component's internal key never depends on the order the
      // claims arrived in — which is what keeps a rebuild's output byte-identical.
      const [keep, drop] = rootA < rootB ? [rootA, rootB] : [rootB, rootA];
      this.parent.set(drop, keep);
    }
  }
}
