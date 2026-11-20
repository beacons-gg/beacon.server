import { describe, expect, it } from "vitest";
import { parkCodeClaim } from "../concordance";
import { NPS_SOURCE, pdCredit, stagedFromUnit, stageNps, type NpsOptions } from "../nps";
import type { NpsCandidate, NpsUnit, Querier, StagedRow } from "../store";

/**
 * The NPS source's decisions, tested without a network or a database.
 *
 * Two of these guard properties nothing else can: the derived-record contract (one record per place,
 * joined by naming its parent, asserting nothing), and the public-domain gate — the API states no
 * per-image licence, so the credit line is the only thing standing between "the Park Service's own
 * photo" and publishing a third party's work as public domain.
 */

const POINT = '{"type":"Point","coordinates":[-123.5,47.8]}';

const candidate = (over: Partial<NpsCandidate> = {}): NpsCandidate => ({
  source: "osm",
  sourceId: "r/238053",
  category: "nature",
  subcategory: "park",
  point: POINT,
  hasDescription: false,
  wdIds: ["wd:Q217039"],
  ...over,
});

const unit = (over: Partial<NpsUnit> = {}): NpsUnit => ({
  unitCode: "olym",
  name: "Olympic National Park",
  description: "Encompassing nearly a million acres,  spanning  several ecosystems.",
  designation: "National Park",
  website: "https://www.nps.gov/olym/index.htm",
  images: [{ url: "https://www.nps.gov/common/uploads/olym.jpg", credit: "NPS Photo" }],
  ...over,
});

const staged = stagedFromUnit;

describe("stagedFromUnit — what a park unit becomes", () => {
  it("stages an nps record under the enriched record's own source id", () => {
    const row = staged(candidate(), unit());
    expect(row?.source).toBe(NPS_SOURCE);
    expect(row?.sourceId).toBe("r/238053");
    // Whitespace collapsed: a place description is one blurb, and the API text carries runs of spaces.
    expect(row?.description).toBe(
      "Encompassing nearly a million acres, spanning several ecosystems.",
    );
  });

  /** The credit rides with the text — `OWNED_BY` enforces the pairing downstream. */
  it("credits the Park Service, public domain, linking the unit's own page", () => {
    expect(staged(candidate(), unit())?.descriptionCredit).toEqual({
      license: "Public domain",
      author: "US National Park Service",
      sourceUrl: "https://www.nps.gov/olym/index.htm",
    });
  });

  /**
   * The derived-record contract, restated from the Wikipedia template because it is the invariant the
   * whole identity design stands on: the record names its parent and asserts nothing about who that
   * place is. An `nps:` id here would put a shared identifier under the merge gate for a source that
   * never asserted identity at all.
   */
  it("names the record it was derived from, and asserts no identifiers of its own", () => {
    const row = staged(candidate(), unit());
    expect(row?.derivedFrom).toEqual({ source: "osm", sourceId: "r/238053" });
    expect(row?.upstreamIds).toEqual([]);
  });

  it("copies the point verbatim and stages no name — OSM owns what a place is called", () => {
    const row = staged(candidate(), unit());
    expect(row?.point).toBe(POINT);
    expect(row?.name).toBeUndefined();
  });

  it("stages the unit's page as website — a gap-filler that loses to a mapper's own tag", () => {
    expect(staged(candidate(), unit())?.website).toBe("https://www.nps.gov/olym/index.htm");
  });

  /**
   * The public-domain gate. The API's images carry a credit line and nothing else; only the Park
   * Service's own work is federal public domain, so only an NPS-credited image may be claimed — the
   * first one, not the first image, because ordering mixes the two.
   */
  it("claims the first NPS-credited image, skipping third-party ones ahead of it", () => {
    const row = staged(
      candidate(),
      unit({
        images: [
          { url: "https://www.nps.gov/x/partner.jpg", credit: "© Friends of Olympic" },
          { url: "https://www.nps.gov/x/own.jpg", credit: "NPS / Jacob W. Frank" },
        ],
      }),
    );
    expect(row?.mediaRefs).toEqual([
      { kind: "url", value: "https://www.nps.gov/x/own.jpg", claimedBy: NPS_SOURCE },
    ]);
  });

  it("claims nothing when every image is third-party or uncredited", () => {
    const row = staged(
      candidate(),
      unit({
        images: [
          { url: "https://www.nps.gov/x/a.jpg", credit: "Ansel Adams" },
          { url: "https://www.nps.gov/x/b.jpg" },
        ],
      }),
    );
    expect(row?.mediaRefs).toEqual([]);
  });

  it("stages nothing for a unit with nothing to contribute", () => {
    const bare: NpsUnit = { unitCode: "olym", name: "Olympic National Park", images: [] };
    expect(stagedFromUnit(candidate(), bare)).toBeUndefined();
  });

  it("keeps build-side provenance: which unit said this", () => {
    expect(staged(candidate(), unit())?.raw).toEqual({
      unitCode: "olym",
      name: "Olympic National Park",
      designation: "National Park",
    });
  });
});

describe("pdCredit — the only licence signal the API gives", () => {
  it("accepts the Park Service's own credit forms", () => {
    expect(pdCredit("NPS")).toBe(true);
    expect(pdCredit("NPS Photo")).toBe(true);
    expect(pdCredit("NPS / Jacob W. Frank")).toBe(true);
    expect(pdCredit(" nps photo ")).toBe(true);
  });

  /** No credit is *unknown*, not "probably fine" — publishing it would assert a licence nobody stated. */
  it("treats third-party and missing credits as unpublishable", () => {
    expect(pdCredit("Ansel Adams")).toBe(false);
    expect(pdCredit("© Friends of the Park")).toBe(false);
    expect(pdCredit("")).toBe(false);
    expect(pdCredit(undefined)).toBe(false);
  });
});

describe("parkCodeClaim — the concordance side of the join", () => {
  it("reads the first string value, lowercased — the two sides disagree on case", () => {
    expect(
      parkCodeClaim({
        qid: "Q217039",
        claims: { P4083: [{ kind: "string", value: "OLYM" }] },
        absent: false,
      }),
    ).toBe("olym");
  });

  it("yields nothing for an entity without the claim, or an absent one", () => {
    expect(parkCodeClaim({ qid: "Q1", claims: {}, absent: false })).toBeUndefined();
    expect(parkCodeClaim({ qid: "Q2", claims: null, absent: true })).toBeUndefined();
  });
});

describe("stageNps — the loop", () => {
  const NOW = "2026-08-06T00:00:00.000Z";

  const candidateRow = (n: number, wdIds: string[]) => ({
    source: "osm",
    source_id: `r/${n}`,
    category: "nature",
    subcategory: null,
    point: POINT,
    has_description: false,
    wd_ids: wdIds,
  });

  const entityRow = (qid: string, code: string) => ({
    qid,
    claims: { P4083: [{ kind: "string", value: code }] },
    enwiki_title: null,
    absent: false,
  });

  function fakeDb(
    entities: ReturnType<typeof entityRow>[],
    candidates: ReturnType<typeof candidateRow>[],
  ) {
    const staged: StagedRow[] = [];
    const units: NpsUnit[] = [];
    const db: Querier = {
      query(sql: string, params: unknown[] = []) {
        if (sql.includes("INSERT INTO nps_units")) {
          units.push(...(JSON.parse(params[0] as string) as NpsUnit[]));
          return Promise.resolve({ rows: [] });
        }
        if (sql.startsWith("SELECT qid, claims, enwiki_title, absent FROM wikidata_entities")) {
          return Promise.resolve({ rows: entities });
        }
        if (sql.includes("s.upstream_ids && $1::text[]")) {
          return Promise.resolve({ rows: candidates });
        }
        if (sql.startsWith("INSERT INTO source_records")) {
          staged.push(...(JSON.parse(params[0] as string) as StagedRow[]));
          return Promise.resolve({ rows: [] });
        }
        throw new Error(`unexpected SQL: ${sql}`);
      },
    };
    return { db, staged, units };
  }

  const park = (parkCode: string, over: Record<string, unknown> = {}) => ({
    parkCode,
    fullName: "Olympic National Park",
    description: "A park.",
    designation: "National Park",
    states: "WA",
    url: `https://www.nps.gov/${parkCode}/index.htm`,
    images: [{ url: `https://www.nps.gov/${parkCode}.jpg`, credit: "NPS Photo" }],
    ...over,
  });

  /** A fetch that answers the `/parks` envelope, one page per call. Records what it was asked. */
  const api = (pages: { total: number; data: unknown[] }[], asked: string[] = []) => {
    let at = 0;
    return ((url: string) => {
      asked.push(url);
      const page = pages[Math.min(at++, pages.length - 1)]!;
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ total: String(page.total), data: page.data }),
      });
    }) as unknown as typeof fetch;
  };

  const run = (db: Querier, fetchImpl: typeof fetch, over: Partial<NpsOptions> = {}) =>
    stageNps(db, {
      dryRun: false,
      apiKey: "TEST_KEY",
      userAgent: "test-agent (test@example.com)",
      fetchImpl,
      now: () => NOW,
      log: () => {},
      ...over,
    });

  it("fetches the corpus, joins through the concordance, and stages what units say", async () => {
    const { db, staged, units } = fakeDb(
      [entityRow("Q217039", "OLYM")],
      [candidateRow(1, ["wd:Q217039"])],
    );
    const report = await run(db, api([{ total: 1, data: [park("olym")] }]));
    expect(units.map((u) => u.unitCode)).toEqual(["olym"]);
    expect(staged).toHaveLength(1);
    expect(staged[0]).toMatchObject({
      source: "nps",
      sourceId: "r/1",
      description: "A park.",
      derivedFrom: { source: "osm", sourceId: "r/1" },
      upstreamIds: [],
    });
    expect(report).toMatchObject({
      requests: 1,
      units: 1,
      codes: 1,
      candidates: 1,
      staged: 1,
      withPhoto: 1,
    });
  });

  /** Wikidata knows ~15 more codes than the API serves — former and affiliated units. A fact, counted. */
  it("counts a candidate whose code the API no longer serves, and stages nothing for it", async () => {
    const { db, staged } = fakeDb(
      [entityRow("Q217039", "olym"), entityRow("Q99", "gone")],
      [candidateRow(1, ["wd:Q217039"]), candidateRow(2, ["wd:Q99"])],
    );
    const report = await run(db, api([{ total: 1, data: [park("olym")] }]));
    expect(staged.map((r) => r.sourceId)).toEqual(["r/1"]);
    expect(report).toMatchObject({ unknownUnit: 1, staged: 1 });
  });

  /** A record can carry several QIDs; the sorted first that names a code decides, deterministically. */
  it("picks the code through whichever of a record's QIDs claims one", async () => {
    const { db, staged } = fakeDb(
      [entityRow("Q217039", "olym")],
      [candidateRow(1, ["wd:Q1000", "wd:Q217039"])],
    );
    await run(db, api([{ total: 1, data: [park("olym")] }]));
    expect(staged).toHaveLength(1);
  });

  it("pages the listing when the corpus outgrows one reply", async () => {
    const asked: string[] = [];
    const { db } = fakeDb([], []);
    const report = await run(
      db,
      api(
        [
          { total: 2, data: [park("olym")] },
          { total: 2, data: [park("mora")] },
        ],
        asked,
      ),
    );
    expect(report.requests).toBe(2);
    expect(asked[1]).toContain("start=1");
  });

  it("writes nothing under --dry-run", async () => {
    const { db, staged, units } = fakeDb(
      [entityRow("Q217039", "olym")],
      [candidateRow(1, ["wd:Q217039"])],
    );
    const report = await run(db, api([{ total: 1, data: [park("olym")] }]), { dryRun: true });
    expect(units).toEqual([]);
    expect(staged).toEqual([]);
    expect(report.staged).toBe(1); // the report still says what a real run would do
  });

  it("aborts whole on a rate limit, with the budget in the message", async () => {
    const throttled = (() =>
      Promise.resolve({ ok: false, status: 429, json: () => Promise.resolve({}) })) as never;
    const { db } = fakeDb([], []);
    await expect(run(db, throttled)).rejects.toThrow(/rate-limited.*hour/);
  });
});
