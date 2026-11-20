import type { WikidataEntity, WikidataProperty, WikimediaClient } from "@beaconsgg/wikimedia";
import { describe, expect, it } from "vitest";
import { buildConcordance, CONCORDANCE_PROPERTIES, evidenceOf } from "../concordance";
import type { ConcordanceRow, Querier } from "../store";

const NOW = "2026-08-05T12:00:00.000Z";

/** A preflight answer where every property is exactly what `CONCORDANCE_PROPERTIES` expects. */
const healthyProperties = (): Map<string, WikidataProperty> =>
  new Map(
    CONCORDANCE_PROPERTIES.map((property) => [
      property.pid,
      { datatype: property.datatype, label: property.label },
    ]),
  );

function fakeWiki(over: {
  properties?: Partial<Awaited<ReturnType<WikimediaClient["properties"]>>>;
  entities?: (qids: readonly string[]) => Awaited<ReturnType<WikimediaClient["entities"]>>;
}) {
  const asked: string[][] = [];
  const wiki = {
    properties: () =>
      Promise.resolve({
        properties: healthyProperties(),
        absent: new Set<string>(),
        unavailable: false,
        ...over.properties,
      }),
    entities: (qids: readonly string[]) => {
      asked.push([...qids]);
      return Promise.resolve(
        over.entities?.(qids) ?? {
          entities: new Map<string, WikidataEntity>(),
          absent: new Set<string>(),
          unavailable: false,
        },
      );
    },
  } as unknown as WikimediaClient;
  return { wiki, asked };
}

function fakeDb(qids: readonly string[]) {
  const writes: ConcordanceRow[] = [];
  const db: Querier = {
    query(sql: string, params: unknown[] = []) {
      if (sql.includes("FROM source_records, unnest")) {
        return Promise.resolve({ rows: qids.map((qid) => ({ qid })) });
      }
      if (sql.startsWith("INSERT INTO wikidata_entities")) {
        writes.push(...(JSON.parse(params[0] as string) as ConcordanceRow[]));
        return Promise.resolve({ rows: [] });
      }
      throw new Error(`unexpected SQL: ${sql}`);
    },
  };
  return { db, writes };
}

const opts = () => ({
  limit: Number.POSITIVE_INFINITY,
  refresh: false,
  dryRun: false,
  now: () => NOW,
  log: () => {},
});

describe("the preflight", () => {
  /**
   * `apps/atlas/doc/spec/place-identity.md` §2 asks for a loud failure by name. A property that
   * quietly changed meaning resolves nothing and looks exactly like a region with no
   * cross-references — the same shape as a throttled batch looking like places without articles.
   */
  it("refuses to build when a property's datatype has changed under us", async () => {
    const broken = healthyProperties();
    broken.set("P649", { datatype: "string", label: "NRHP reference number" });
    const { wiki } = fakeWiki({ properties: { properties: broken } });
    const { db } = fakeDb(["Q1"]);
    await expect(buildConcordance(db, wiki, opts())).rejects.toThrow(
      /P649 is now datatype "string"/,
    );
  });

  it("refuses when a property id has been reused for something else", async () => {
    const broken = healthyProperties();
    broken.set("P590", { datatype: "external-id", label: "Some Other Registry ID" });
    const { wiki } = fakeWiki({ properties: { properties: broken } });
    const { db } = fakeDb(["Q1"]);
    await expect(buildConcordance(db, wiki, opts())).rejects.toThrow(/P590 is now labelled/);
  });

  /** Not a give-up recorded as a fact — the opposite: refusing to build on assumptions we couldn't check. */
  it("refuses when Wikidata would not answer about the properties at all", async () => {
    const { wiki } = fakeWiki({ properties: { unavailable: true } });
    const { db } = fakeDb(["Q1"]);
    await expect(buildConcordance(db, wiki, opts())).rejects.toThrow(/did not answer/);
  });
});

describe("buildConcordance", () => {
  it("records an entity Wikidata answered about, and one it says does not exist", async () => {
    const { wiki } = fakeWiki({
      entities: () => ({
        entities: new Map([
          ["Q1", { claims: { P649: [{ kind: "string" as const, value: "77001360" }] } }],
        ]),
        absent: new Set(["Q2"]),
        unavailable: false,
      }),
    });
    const { db, writes } = fakeDb(["Q1", "Q2"]);
    const report = await buildConcordance(db, wiki, opts());

    expect(report).toMatchObject({ wanted: 2, fetched: 1, absent: 1, unanswered: 0, requests: 1 });
    expect(writes).toEqual([
      { qid: "Q1", claims: { P649: [{ kind: "string", value: "77001360" }] }, absent: false },
      { qid: "Q2", claims: null, absent: true },
    ]);
  });

  /**
   * The rule this whole pipeline is built around. A throttled batch must leave **no row**, so the next
   * run's `NOT EXISTS` check asks again. Writing an empty row would turn "we never got an answer" into
   * "this QID has no claims", permanently.
   */
  it("writes nothing for a batch that went unanswered", async () => {
    const { wiki } = fakeWiki({
      entities: () => ({ entities: new Map(), absent: new Set(), unavailable: true }),
    });
    const { db, writes } = fakeDb(["Q1", "Q2"]);
    const report = await buildConcordance(db, wiki, opts());
    expect(report).toMatchObject({ fetched: 0, absent: 0, unanswered: 2 });
    expect(writes).toEqual([]);
  });

  /** A QID the reply mentioned neither way is unanswered too, not absent. */
  it("does not infer absence from a QID the reply simply omitted", async () => {
    const { wiki } = fakeWiki({
      entities: () => ({
        entities: new Map([["Q1", { claims: {} }]]),
        absent: new Set(),
        unavailable: false,
      }),
    });
    const { db, writes } = fakeDb(["Q1", "Q2"]);
    const report = await buildConcordance(db, wiki, opts());
    expect(report).toMatchObject({ fetched: 1, absent: 0, unanswered: 1 });
    expect(writes.map((row) => row.qid)).toEqual(["Q1"]);
  });

  /** `wbgetentities` cannot filter server-side, so a busy entity arrives with hundreds of claims. */
  it("stores only the properties it reads", async () => {
    const { wiki } = fakeWiki({
      entities: () => ({
        entities: new Map([
          [
            "Q1",
            {
              claims: {
                P625: [{ kind: "coordinate" as const, lat: 47.9, lng: -122.3 }],
                P2044: [{ kind: "string" as const, value: "irrelevant elevation" }],
              },
            },
          ],
        ]),
        absent: new Set(),
        unavailable: false,
      }),
    });
    const { db, writes } = fakeDb(["Q1"]);
    await buildConcordance(db, wiki, opts());
    expect(Object.keys(writes[0]?.claims ?? {})).toEqual(["P625"]);
  });

  it("writes nothing under --dry-run but still reports what it found", async () => {
    const { wiki } = fakeWiki({
      entities: () => ({
        entities: new Map([["Q1", { claims: {} }]]),
        absent: new Set(),
        unavailable: false,
      }),
    });
    const { db, writes } = fakeDb(["Q1"]);
    const report = await buildConcordance(db, wiki, { ...opts(), dryRun: true });
    expect(report.fetched).toBe(1);
    expect(writes).toEqual([]);
  });
});

/**
 * The translation layer. `identity.ts` must never learn that Wikidata has P-numbers, in the same way
 * stage 1's downstream never learns that OSM has tags.
 */
describe("evidenceOf", () => {
  const row = (claims: ConcordanceRow["claims"]): ConcordanceRow => ({
    qid: "Q1",
    claims,
    absent: false,
  });

  it("turns each identifier property into its namespaced form", () => {
    const facts = evidenceOf(
      row({
        P402: [{ kind: "string", value: "1234" }],
        P10689: [{ kind: "string", value: "586464226" }],
        P11693: [{ kind: "string", value: "99" }],
        P649: [{ kind: "string", value: "77001360" }],
        P590: [{ kind: "string", value: "1512923" }],
        P373: [{ kind: "string", value: "Mukilteo Light" }],
      }),
    );
    expect(facts.asserts).toEqual([
      "osm:r/1234",
      "osm:w/586464226",
      "osm:n/99",
      "nrhp:77001360",
      "gnis:1512923",
      "commons:Category:Mukilteo Light",
    ]);
  });

  /** `apps/atlas/doc/spec/place-identity.md` §1: never invented. A malformed value yields nothing rather than a plausible id. */
  it("refuses a value that is not a well-formed member of its namespace", () => {
    const facts = evidenceOf(
      row({
        P649: [{ kind: "string", value: "https://catalog.archives.gov/id/75613230" }],
        P590: [{ kind: "string", value: "not-a-number" }],
      }),
    );
    expect(facts.asserts).toEqual([]);
  });

  /** A coordinate or an item sitting in an external-id slot is malformed data, not an id to build from. */
  it("ignores a claim whose value is the wrong kind for an identifier", () => {
    const facts = evidenceOf(row({ P649: [{ kind: "coordinate", lat: 1, lng: 2 }] }));
    expect(facts.asserts).toEqual([]);
  });

  it("is a place only when it carries a coordinate", () => {
    expect(
      evidenceOf(row({ P625: [{ kind: "coordinate", lat: 47.9, lng: -122.3 }] }))
        .establishesIdentity,
    ).toBe(true);
    expect(evidenceOf(row({ P18: [{ kind: "string", value: "X.jpg" }] })).establishesIdentity).toBe(
      false,
    );
  });

  /** Wikidata told us there is nothing there — so there is nothing to merge on, which is a fact. */
  it("treats an absent entity as asserting nothing and being nowhere", () => {
    expect(evidenceOf({ qid: "Q1", claims: null, absent: true })).toEqual({
      asserts: [],
      establishesIdentity: false,
    });
  });
});
