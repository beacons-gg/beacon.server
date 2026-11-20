import { describe, expect, it } from "vitest";
import {
  MERGE_SPAN_M,
  recordNode,
  resolveIdentity,
  type Evidence,
  type IdentityInput,
} from "../identity";
import { recordRef, type PriorEntity, type StagedIdentity, type UpstreamSpan } from "../store";

/**
 * Stage 2's rules, tested directly, because the database cannot tell you whether they are right:
 * 225,201 entities from 225,501 records looks identical whether the 300 merges were the right 300
 * or the wrong 300. Every case below is either a rule from `apps/atlas/doc/spec/place-identity.md`
 * or something the real us-west staging does.
 */

const record = (sourceId: string, ...upstreamIds: string[]): StagedIdentity => ({
  source: "osm",
  sourceId,
  upstreamIds,
});

/** Evidence about a `wd:` id, keyed the way `evidenceMap` keys it — by the full namespaced id. */
const vouched = (
  qid: string,
  asserts: string[],
  establishesIdentity = true,
): [string, Evidence] => [`wd:${qid}`, { asserts, establishesIdentity }];

/** A deterministic minter, so a test can name the ids it expects. */
const minter = () => {
  let n = 0;
  return () => `E${++n}`;
};

const input = (over: Partial<IdentityInput> = {}): IdentityInput => ({
  records: [],
  evidence: new Map(),
  spans: [],
  decisions: [],
  prior: [],
  ...over,
});

const run = (over: Partial<IdentityInput> = {}) =>
  resolveIdentity(input(over), { mintId: minter() });

const idsOf = (result: ReturnType<typeof run>): string[][] =>
  result.entities.map((entity) => entity.members.map((member) => member.sourceId));

describe("tier 1 — a shared explicit identifier", () => {
  it("gives every record its own entity when nothing is shared", () => {
    const result = run({
      records: [record("way/1", "osm:w/1"), record("way/2", "osm:w/2")],
    });
    expect(idsOf(result)).toEqual([["way/1"], ["way/2"]]);
    expect(result.report).toMatchObject({ entities: 2, minted: 2, tier1Records: 0 });
  });

  /**
   * `gnis:845915` on the real extract: eight nodes all named "Mud Springs", metres apart — one GNIS
   * feature imported eight times. This is what tier 1 is *for*.
   */
  it("merges records that share an id and are in the same place", () => {
    const result = run({
      records: [
        record("node/1", "osm:n/1", "gnis:845915"),
        record("node/2", "osm:n/2", "gnis:845915"),
      ],
      spans: [{ upstreamId: "gnis:845915", spanM: 12 }],
    });
    expect(idsOf(result)).toEqual([["node/1", "node/2"]]);
    expect(result.report).toMatchObject({ entities: 1, tier1Records: 2 });
  });

  /**
   * A Commons category is a *set of photos*, and mappers tag parent categories. Merging on one
   * fuses a city's churches; `apps/atlas/doc/spec/place-identity.md` §3 tier 1 omits it for exactly
   * this reason.
   */
  it("never merges on a Commons category, but still carries it", () => {
    const result = run({
      records: [
        record("way/1", "osm:w/1", "commons:Category:Churches in Seattle"),
        record("way/2", "osm:w/2", "commons:Category:Churches in Seattle"),
      ],
    });
    expect(idsOf(result)).toEqual([["way/1"], ["way/2"]]);
    expect(result.entities[0]?.upstream).toEqual([
      { id: "commons:Category:Churches in Seattle", mergeKey: false },
      { id: "osm:w/1", mergeKey: true },
    ]);
    // Not a gate refusal — nothing was refused, the namespace simply is not an identity claim.
    expect(result.gated).toEqual([]);
  });
});

/**
 * The correction this file's module comment argues for. Both halves are measured against the real
 * us-west staging, and without them tier 1 as designed collapses 54 surveillance cameras into one place.
 */
describe("the merge gate", () => {
  /**
   * `wd:Q108485435` is Flock Safety, an American video surveillance company, on 54 camera nodes 1,715 km
   * apart. The mapper meant *operator*. The company has no P625, and that is the cheapest true statement
   * available about whether a QID is an identity claim at all.
   */
  it("refuses a QID whose entity is not a place, however close the records are", () => {
    const result = run({
      records: [
        record("node/1", "osm:n/1", "wd:Q108485435"),
        record("node/2", "osm:n/2", "wd:Q108485435"),
      ],
      evidence: new Map([vouched("Q108485435", [], false)]),
      // Deliberately no span entry: proximity must not rescue a claim that was never about a place.
    });
    expect(idsOf(result)).toEqual([["node/1"], ["node/2"]]);
    expect(result.gated).toEqual([
      { upstreamId: "wd:Q108485435", records: 2, reason: "not-a-place" },
    ]);
  });

  it("refuses an identifier whose records are too far apart to be one place", () => {
    const result = run({
      records: [record("way/1", "osm:w/1", "wd:Q9"), record("way/2", "osm:w/2", "wd:Q9")],
      evidence: new Map([vouched("Q9", [])]),
      spans: [{ upstreamId: "wd:Q9", spanM: MERGE_SPAN_M + 1 }],
    });
    expect(idsOf(result)).toEqual([["way/1"], ["way/2"]]);
    expect(result.gated).toEqual([
      { upstreamId: "wd:Q9", records: 2, spanM: MERGE_SPAN_M + 1, reason: "span" },
    ]);
  });

  it("allows a shared identifier right at the cap", () => {
    const result = run({
      records: [
        record("way/1", "osm:w/1", "nrhp:77001360"),
        record("way/2", "osm:w/2", "nrhp:77001360"),
      ],
      spans: [{ upstreamId: "nrhp:77001360", spanM: MERGE_SPAN_M }],
    });
    expect(idsOf(result)).toEqual([["way/1", "way/2"]]);
  });

  /** A refused id is still what the source said, and stage 4 reads the carried ones. */
  it("carries a refused identifier rather than dropping it", () => {
    const result = run({
      records: [record("node/1", "osm:n/1", "wd:Q108485435")],
      evidence: new Map([vouched("Q108485435", [], false)]),
    });
    expect(result.entities[0]?.upstream).toEqual([
      { id: "osm:n/1", mergeKey: true },
      { id: "wd:Q108485435", mergeKey: false },
    ]);
  });

  /**
   * The give-up-as-fact rule, one level up. An unrun concordance must not read as "these places have no
   * cross-references" — which is precisely what a single "could not merge" counter would have said.
   */
  it("reports a QID with no concordance as pending, not as refused", () => {
    const result = run({
      records: [record("way/1", "osm:w/1", "wd:Q7"), record("way/2", "osm:w/2", "wd:Q7")],
    });
    expect(idsOf(result)).toEqual([["way/1"], ["way/2"]]);
    expect(result.gated).toEqual([]);
    expect(result.report.awaitingEvidence).toBe(1);
  });
});

describe("tier 2 — Wikidata as a bridge", () => {
  /**
   * `apps/atlas/doc/spec/place-identity.md` §8's worked example, and the shape that matters most:
   * on the real extract Mukilteo Lighthouse's `ref:nrhp` is a *URL*, so `upstreamIdsFor` refuses it
   * — the NRHP number reaches the place only because Wikidata's P649 on Q2680081 says so.
   */
  it("joins records that share no id of their own, and publishes what the bridge asserted", () => {
    const result = run({
      records: [
        record("way/586464226", "osm:w/586464226", "wd:Q2680081"),
        record("way/999", "osm:w/999", "nrhp:77001360"),
      ],
      evidence: new Map([vouched("Q2680081", ["nrhp:77001360"])]),
    });
    expect(idsOf(result)).toEqual([["way/586464226", "way/999"]]);
    expect(result.entities[0]?.upstream.map((ref) => ref.id)).toEqual([
      "nrhp:77001360",
      "osm:w/586464226",
      "osm:w/999",
      "wd:Q2680081",
    ]);
    // What tier 2 bought, stated separately from what tier 1 did.
    expect(result.report).toMatchObject({ tier1Records: 0, tier2Records: 2 });
  });

  it("ignores a bridge whose entity is not a place", () => {
    const result = run({
      records: [
        record("node/1", "osm:n/1", "wd:Q108485435"),
        record("way/2", "osm:w/2", "nrhp:12345678"),
      ],
      evidence: new Map([vouched("Q108485435", ["nrhp:12345678"], false)]),
    });
    expect(idsOf(result)).toEqual([["node/1"], ["way/2"]]);
  });

  it("never invents an id — a bridge asserting nothing joins nothing", () => {
    const result = run({
      records: [record("way/1", "osm:w/1", "wd:Q5"), record("way/2", "osm:w/2")],
      evidence: new Map([vouched("Q5", [])]),
    });
    expect(idsOf(result)).toEqual([["way/1"], ["way/2"]]);
  });
});

/**
 * Derivation — a record built out of another record, joining by **naming** it.
 *
 * The alternative, and what this replaced, was copying the parent's identifiers onto the derived record. It
 * worked, and it corrupted two readings at once: `upstreamIds` stopped meaning "a source said this", and the
 * gate's evidence — how many records assert each id — counted a restatement as corroboration. Measured, one
 * partial pass took the shared-identifier population from 422 to 1,029.
 */
describe("derivation — a record built out of another record", () => {
  /** A derived record: the parent named, and nothing asserted. */
  const derived = (from: StagedIdentity): StagedIdentity => ({
    source: "wikipedia",
    sourceId: from.sourceId,
    upstreamIds: [],
    derivedFrom: recordRef(from),
  });

  /**
   * Members named the way the graph names them, because a derived record shares its parent's `sourceId` —
   * `idsOf` would print `["way/1", "way/1"]` and say nothing. Through `recordNode` rather than a template of
   * its own: `store.ts` requires a record node be built by that function and never by hand, and this file
   * asserts on one three lines from where it writes a `decisions` row naming the same pair.
   */
  const membersOf = (result: ReturnType<typeof run>): string[][] =>
    result.entities.map((entity) => entity.members.map(recordNode));

  it("joins its parent's entity, and puts no identifier of its own on it", () => {
    const parent = record("way/1", "osm:w/1", "wd:Q5");
    const result = run({
      records: [parent, derived(parent)],
      evidence: new Map([vouched("Q5", [])]),
    });
    expect(membersOf(result)).toEqual([["record:osm/way/1", "record:wikipedia/way/1"]]);
    // Exactly the parent's ids — a derived record contributes none, carried or established.
    expect(result.entities[0]?.upstream).toEqual([
      { id: "osm:w/1", mergeKey: true },
      { id: "wd:Q5", mergeKey: true },
    ]);
  });

  /**
   * Counted apart from both tiers. Folded into `tier1Records` every enrichment contributed a pair, which
   * doubled the one number the tier-1 gate was justified by.
   */
  it("counts as neither tier's evidence", () => {
    const [a, b] = [record("node/1", "osm:n/1", "gnis:1"), record("node/2", "osm:n/2", "gnis:1")];
    const result = run({
      records: [a, b, derived(a), derived(b)],
      spans: [{ upstreamId: "gnis:1", spanM: 12 }],
    });
    expect(result.report).toMatchObject({
      records: 4,
      entities: 1,
      tier1Records: 2,
      tier2Records: 0,
      derivedRecords: 2,
    });
  });

  /** And it adds no asserter to what the gate rules on — the reason the copy had to go. */
  it("does not inflate the record count on a refusal", () => {
    const [a, b] = [record("node/1", "osm:n/1", "gnis:1"), record("node/2", "osm:n/2", "gnis:1")];
    const result = run({
      records: [a, b, derived(a), derived(b)],
      spans: [{ upstreamId: "gnis:1", spanM: MERGE_SPAN_M + 1 }],
    });
    // Two records assert `gnis:1`, not four. `ambiguous_ids` stores this number as the refusal's evidence.
    expect(result.gated).toEqual([
      { upstreamId: "gnis:1", records: 2, spanM: MERGE_SPAN_M + 1, reason: "span" },
    ]);
  });

  /**
   * **The failure the copy left reachable.** A copied id is subject to the gate, so a parent whose merge
   * keys were *all* refused joined nothing — and its derived record then published as a place of its own,
   * nameless, with a category copied from the record it failed to join. Naming the parent cannot fail that
   * way, because the name never goes through the gate.
   */
  it("stays with its parent even when every one of the parent's merge keys is refused", () => {
    const parent = record("node/1", "wd:Q108485435");
    const result = run({
      records: [parent, derived(parent)],
      evidence: new Map([vouched("Q108485435", [], false)]),
    });
    expect(membersOf(result)).toEqual([["record:osm/node/1", "record:wikipedia/node/1"]]);
    expect(result.report).toMatchObject({ entities: 1 });
  });

  /** A rebuild that adds a derived record must not move the place id — it is not a new place. */
  it("does not re-mint the place its parent already has", () => {
    const parent = record("way/1", "osm:w/1");
    const prior: PriorEntity[] = [
      { id: "E_OLD", upstream: [{ id: "osm:w/1", mergeKey: true }], members: 1, aliases: [] },
    ];
    const result = run({ records: [parent, derived(parent)], prior });
    expect(result.entities[0]).toMatchObject({ id: "E_OLD", via: "reused" });
    expect(result.report).toMatchObject({ minted: 0, aliased: 0, split: 0, withdrawn: [] });
  });

  /**
   * Severable like any other claim. A derivation is a build-time judgement — the article a mapper's tag
   * pointed at can be about something else entirely — so a reviewer must be able to say so.
   */
  it("can be vetoed, which leaves the derived record its own entity", () => {
    const parent = record("way/1", "osm:w/1");
    const result = run({
      records: [parent, derived(parent)],
      decisions: [
        {
          a: recordNode({ source: "osm", sourceId: "way/1" }),
          b: recordNode({ source: "wikipedia", sourceId: "way/1" }),
          verdict: "distinct",
        },
      ],
    });
    expect(membersOf(result)).toEqual([["record:osm/way/1"], ["record:wikipedia/way/1"]]);
    // The veto worked, so it is not reported as one that did nothing.
    expect(result.report.ineffectiveVetoes).toEqual([]);
  });
});

/**
 * A verdict names one **claim** — an asserter and the identifier it named — rather than two identifiers.
 * That is what makes it precise and always effective: "this record does not really assert that QID" is
 * exactly the mistake in the data (a mapper writing `wikidata=` where `operator:wikidata=` belonged), and
 * it is expressible. Vetoing an id *pair* instead cannot separate two records that a third claim still
 * links, which is how the first cut of this silently did nothing.
 */
describe("decisions — the human override", () => {
  it("detaches a record's claim when a reviewer says it is wrong", () => {
    const shared: Partial<IdentityInput> = {
      records: [record("way/1", "osm:w/1", "gnis:5"), record("way/2", "osm:w/2", "gnis:5")],
      spans: [{ upstreamId: "gnis:5", spanM: 10 }],
    };
    expect(idsOf(run(shared))).toEqual([["way/1", "way/2"]]);

    const vetoed = run({
      ...shared,
      decisions: [
        { a: recordNode({ source: "osm", sourceId: "way/2" }), b: "gnis:5", verdict: "distinct" },
      ],
    });
    expect(idsOf(vetoed)).toEqual([["way/1"], ["way/2"]]);
    expect(vetoed.report.ineffectiveVetoes).toEqual([]);
    // The claim is severed, not erased: the record still carries what its source said — but as a
    // *carried* id, not an established one. Marking it a merge key anyway would record the identity the
    // veto denied, and would put `gnis:5` on both entities, which makes continuity oscillate: every
    // rebuild finds the id on the wrong side and re-splits the place.
    expect(vetoed.entities[1]?.upstream).toEqual([
      { id: "gnis:5", mergeKey: false },
      { id: "osm:w/2", mergeKey: true },
    ]);
    // And the id stays a merge key on the entity that does still claim it.
    expect(vetoed.entities[0]?.upstream).toEqual([
      { id: "gnis:5", mergeKey: true },
      { id: "osm:w/1", mergeKey: true },
    ]);
  });

  /**
   * The failure the veto bug actually caused, as a regression test: veto one side of a shared claim, feed
   * the output back in, and the graph must not move. It used to split the place again on every rebuild.
   */
  it("leaves a vetoed split stable across rebuilds", () => {
    const shared: Partial<IdentityInput> = {
      records: [record("way/1", "osm:w/1", "gnis:5"), record("way/2", "osm:w/2", "gnis:5")],
      spans: [{ upstreamId: "gnis:5", spanM: 10 }],
      decisions: [
        { a: recordNode({ source: "osm", sourceId: "way/2" }), b: "gnis:5", verdict: "distinct" },
      ],
    };
    const first = run(shared);
    const second = resolveIdentity(
      input({
        ...shared,
        // Fed back exactly as `readPriorEntities` returns it — flags included — so the "carried ids must
        // not re-glue" rule is exercised rather than hand-copied into the fixture.
        prior: first.entities.map((entity) => ({
          id: entity.id,
          upstream: entity.upstream,
          members: entity.members.length,
          aliases: entity.aliases,
        })),
      }),
      { mintId: () => "SHOULD-NOT-MINT" },
    );
    expect(second.entities.map((e) => e.id)).toEqual(first.entities.map((e) => e.id));
    expect(second.report).toMatchObject({ minted: 0, merged: 0, split: 0 });
  });

  /**
   * A veto that changed nothing has to say so. Silently absorbing it would leave a reviewer believing
   * they had separated two things that are still together — the worst kind of quiet, because it looks
   * like the system agreed with them.
   *
   * The case that actually occurs: the reviewer severs the record's claim to a QID, and Wikidata's own
   * claim about that QID routes straight back to the record via an id the record also asserts.
   */
  it("reports a veto the concordance routed around, and what to veto next", () => {
    const result = run({
      records: [record("way/2", "osm:w/2", "wd:Q1")],
      evidence: new Map([vouched("Q1", ["osm:w/2"])]),
      decisions: [
        { a: recordNode({ source: "osm", sourceId: "way/2" }), b: "wd:Q1", verdict: "distinct" },
      ],
    });
    // `osm:w/2` is what routes around it — the record claims it and so does Q1.
    expect(result.report.ineffectiveVetoes).toEqual([
      { a: recordNode({ source: "osm", sourceId: "way/2" }), b: "wd:Q1", alsoVia: ["osm:w/2"] },
    ]);
  });

  /**
   * `alsoVia` names only what something *else* also asserts. A record's own OSM id sits in its component
   * and connects it to nothing, so listing it would tell the reviewer to sever a record's claim to
   * itself — an instruction that fixes nothing and reads as broken.
   */
  it("names only the claims that are actually doing the connecting", () => {
    const result = run({
      records: [
        record("way/1", "osm:w/1", "gnis:5"),
        record("way/2", "osm:w/2", "gnis:5", "wd:Q1"),
      ],
      evidence: new Map([vouched("Q1", ["gnis:5"])]),
      decisions: [
        { a: recordNode({ source: "osm", sourceId: "way/2" }), b: "wd:Q1", verdict: "distinct" },
      ],
    });
    // `gnis:5` is asserted by both records and by Q1, so it is what routes around the veto. `osm:w/2`
    // is in the same component but nothing else claims it, so it is not offered.
    expect(result.report.ineffectiveVetoes).toEqual([
      { a: recordNode({ source: "osm", sourceId: "way/2" }), b: "wd:Q1", alsoVia: ["gnis:5"] },
    ]);
  });

  it("merges on a 'same' verdict even where the gate would have refused", () => {
    const result = run({
      records: [record("way/1", "osm:w/1", "wd:Q9"), record("way/2", "osm:w/2", "wd:Q9")],
      evidence: new Map([vouched("Q9", [], false)]),
      decisions: [
        {
          a: recordNode({ source: "osm", sourceId: "way/1" }),
          b: recordNode({ source: "osm", sourceId: "way/2" }),
          verdict: "same",
        },
      ],
    });
    expect(idsOf(result)).toEqual([["way/1", "way/2"]]);
  });
});

/**
 * The part with no undo. A place id is the one guarantee a consumer's stored state rests on: re-mint it
 * and every server that imported a volume retires the place, taking its operator's edits and its
 * players' contributions with it.
 */
describe("continuity — a place id never moves", () => {
  /**
   * A prior entity, given the ids it was identified *by*. `upstream` carries the `mergeKey` flags the
   * database actually stores, so `reconcile`'s own filter is what runs — the point of the shape.
   */
  const prior = (
    id: string,
    mergeKeys: string[],
    over: Partial<PriorEntity> = {},
  ): PriorEntity => ({
    id,
    upstream: mergeKeys.map((key) => ({ id: key, mergeKey: true })),
    members: mergeKeys.length,
    aliases: [],
    ...over,
  });

  it("reuses the id the previous build assigned", () => {
    const result = run({
      records: [record("way/1", "osm:w/1")],
      prior: [prior("01OLD", ["osm:w/1"])],
    });
    expect(result.entities[0]).toMatchObject({ id: "01OLD", via: "reused" });
    expect(result.report).toMatchObject({ minted: 0, reused: 1 });
  });

  it("ships a merge as aliases, keeping the better-attested id", () => {
    const result = run({
      records: [record("way/1", "osm:w/1", "gnis:5"), record("way/2", "osm:w/2", "gnis:5")],
      spans: [{ upstreamId: "gnis:5", spanM: 5 }],
      prior: [
        prior("01BIG", ["osm:w/1", "gnis:5"], { members: 3 }),
        prior("01SMALL", ["osm:w/2"], { members: 1, aliases: ["01ANCIENT"] }),
      ],
    });
    expect(result.entities).toHaveLength(1);
    expect(result.entities[0]).toMatchObject({ id: "01BIG", via: "merged" });
    // Flattened: the loser's own alias comes along, so a consumer resolves either in one step.
    expect(result.entities[0]?.aliases).toEqual(["01ANCIENT", "01SMALL"]);
    expect(result.report).toMatchObject({ merged: 1, aliased: 2 });
  });

  it("breaks a tie by the older ULID rather than by iteration order", () => {
    const result = run({
      records: [record("way/1", "osm:w/1", "gnis:5"), record("way/2", "osm:w/2", "gnis:5")],
      spans: [{ upstreamId: "gnis:5", spanM: 5 }],
      prior: [
        prior("01ZZZ", ["osm:w/2"], { members: 1 }),
        prior("01AAA", ["osm:w/1"], { members: 1 }),
      ],
    });
    // ULIDs sort by their timestamp, so the lexicographically smaller id is the older place.
    expect(result.entities[0]).toMatchObject({ id: "01AAA", aliases: ["01ZZZ"] });
  });

  /** `apps/atlas/doc/spec/place-identity.md` §5: the larger part keeps the id, the rest are new places — not replacements. */
  it("keeps the id on the larger part of a split and mints for the rest", () => {
    const result = run({
      records: [record("way/1", "osm:w/1"), record("way/2", "osm:w/2"), record("way/3", "osm:w/3")],
      prior: [prior("01OLD", ["osm:w/1", "osm:w/2", "osm:w/3"])],
    });
    const kept = result.entities.filter((entity) => entity.id === "01OLD");
    expect(kept).toHaveLength(1);
    expect(result.report).toMatchObject({ split: 1, reused: 1, minted: 2 });
    // A retired id is never resurrected as a distinct place, so no alias is invented here either.
    expect(result.entities.flatMap((entity) => entity.aliases)).toEqual([]);
  });

  /** Absence is not an alias — the consumer's cell-scoped retirement is what handles a withdrawal. */
  it("reports an entity that holds no record, and keeps its id out of every alias list", () => {
    const result = run({
      records: [record("way/1", "osm:w/1")],
      prior: [prior("01KEPT", ["osm:w/1"]), prior("01GONE", ["osm:w/404"])],
    });
    expect(result.report.withdrawn).toEqual(["01GONE"]);
    expect(result.entities.flatMap((entity) => entity.aliases)).toEqual([]);
  });

  /**
   * The other direction of the same rule, and the one that bites in practice: an entity that merged away
   * holds no record *by design*. Calling that a withdrawal would re-announce every past merge as a
   * vanished place on every future build, forever — and a vanished place is what makes a downstream
   * server retire one.
   */
  it("does not report a merged-away entity as a withdrawal", () => {
    const result = run({
      records: [record("way/1", "osm:w/1", "gnis:5"), record("way/2", "osm:w/2", "gnis:5")],
      spans: [{ upstreamId: "gnis:5", spanM: 5 }],
      prior: [
        prior("01BIG", ["osm:w/1", "gnis:5"], { members: 3 }),
        prior("01SMALL", ["osm:w/2"], { members: 1 }),
      ],
    });
    expect(result.entities[0]?.aliases).toEqual(["01SMALL"]);
    expect(result.report.withdrawn).toEqual([]);
  });

  /**
   * The reason continuity resolves on merge keys only. Flock Safety's QID stays on all 54 cameras as a
   * carried id; if the next build looked entities up by *every* id it holds, all 54 would find each
   * other through it and the gate's work would be undone on every rebuild, silently.
   */
  it("does not let a carried id re-glue what the gate separated", () => {
    const records = [
      record("node/1", "osm:n/1", "wd:Q108485435"),
      record("node/2", "osm:n/2", "wd:Q108485435"),
    ];
    const evidence = new Map([vouched("Q108485435", [], false)]);
    const first = run({ records, evidence });
    expect(first.entities).toHaveLength(2);

    // Feed the first build's own output back in, exactly as `readPriorEntities` would return it.
    const second = resolveIdentity(
      input({
        records,
        evidence,
        // Fed back exactly as `readPriorEntities` returns it — flags included — so the "carried ids must
        // not re-glue" rule is exercised rather than hand-copied into the fixture.
        prior: first.entities.map((entity) => ({
          id: entity.id,
          upstream: entity.upstream,
          members: entity.members.length,
          aliases: entity.aliases,
        })),
      }),
      { mintId: () => "SHOULD-NOT-MINT" },
    );
    expect(second.entities).toHaveLength(2);
    expect(second.entities.map((entity) => entity.id)).toEqual(first.entities.map((e) => e.id));
    expect(second.report).toMatchObject({ minted: 0, merged: 0, reused: 2 });
  });
});

/**
 * The invariant an assertion used to guard at the end of a 28-second run. It is now structural — merge
 * keys are derived from the union, and an id node has exactly one root — so this pins the structure
 * rather than checking the output. If anyone reintroduces per-claim accumulation, this fails.
 */
describe("a merge key belongs to exactly one entity", () => {
  const ownersOf = (result: ReturnType<typeof run>): Map<string, number> => {
    const owners = new Map<string, number>();
    for (const entity of result.entities) {
      for (const ref of entity.upstream) {
        if (ref.mergeKey) owners.set(ref.id, (owners.get(ref.id) ?? 0) + 1);
      }
    }
    return owners;
  };

  it("holds when a reviewer severs one record's claim to a shared id", () => {
    const result = run({
      records: [record("way/1", "osm:w/1", "gnis:5"), record("way/2", "osm:w/2", "gnis:5")],
      spans: [{ upstreamId: "gnis:5", spanM: 10 }],
      decisions: [
        { a: recordNode({ source: "osm", sourceId: "way/2" }), b: "gnis:5", verdict: "distinct" },
      ],
    });
    expect([...ownersOf(result).values()].every((n) => n === 1)).toBe(true);
    expect(ownersOf(result).get("gnis:5")).toBe(1);
  });

  /** A bridge's assertions land on the entity that owns the QID, not on whichever it was iterated near. */
  it("holds when a bridge asserts an id a vetoed record also carries", () => {
    const result = run({
      records: [record("way/1", "osm:w/1", "wd:Q1"), record("way/2", "osm:w/2", "wd:Q1")],
      evidence: new Map([vouched("Q1", ["nrhp:11111111"])]),
      spans: [{ upstreamId: "wd:Q1", spanM: 10 }],
      decisions: [
        { a: recordNode({ source: "osm", sourceId: "way/2" }), b: "wd:Q1", verdict: "distinct" },
      ],
    });
    expect([...ownersOf(result).values()].every((n) => n === 1)).toBe(true);
  });
});

describe("determinism", () => {
  /** `apps/atlas/doc/spec/cartographer.md` §4: a rebuild from the same inputs produces the same entities, or nothing is auditable. */
  it("does not depend on the order records arrive in", () => {
    const records = [
      record("way/3", "osm:w/3", "gnis:5"),
      record("way/1", "osm:w/1", "gnis:5"),
      record("way/2", "osm:w/2", "nrhp:22222222"),
    ];
    const spans: UpstreamSpan[] = [{ upstreamId: "gnis:5", spanM: 5 }];
    const forwards = resolveIdentity(input({ records, spans }), { mintId: minter() });
    const backwards = resolveIdentity(input({ records: [...records].reverse(), spans }), {
      mintId: minter(),
    });
    expect(idsOf(backwards)).toEqual(idsOf(forwards));
    expect(backwards.entities.map((e) => e.id)).toEqual(forwards.entities.map((e) => e.id));
  });

  it("emits members and upstream ids in a stable order", () => {
    const result = run({
      records: [record("way/9", "osm:w/9", "gnis:5"), record("way/1", "osm:w/1", "gnis:5")],
      spans: [{ upstreamId: "gnis:5", spanM: 5 }],
    });
    expect(result.entities[0]?.members.map((m) => m.sourceId)).toEqual(["way/1", "way/9"]);
    expect(result.entities[0]?.upstream.map((u) => u.id)).toEqual(["gnis:5", "osm:w/1", "osm:w/9"]);
  });

  /**
   * A record with no usable merge key must still be its own place. Without a synthetic key such records
   * would all share the empty-string root and fuse into one entity — which on the real extract would
   * mean every unclassifiable-identity record becoming a single place.
   */
  it("gives a record with no usable identifier its own entity, and invents no id for it", () => {
    const result = run({
      records: [record("row/1", "commons:Category:A"), record("row/2", "commons:Category:B")],
    });
    expect(idsOf(result)).toEqual([["row/1"], ["row/2"]]);
    expect(result.entities.flatMap((e) => e.upstream.map((u) => u.id))).toEqual([
      "commons:Category:A",
      "commons:Category:B",
    ]);
  });
});
