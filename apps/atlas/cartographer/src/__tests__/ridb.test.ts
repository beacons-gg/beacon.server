import { describe, expect, it } from "vitest";
import { facilityIdClaim } from "../concordance";
import {
  facilityIdFromWebsite,
  facilityIdOf,
  facilityOf,
  facilityPage,
  fedCredit,
  federalOrg,
  RIDB_SOURCE,
  stagedFromFacility,
  stageRidb,
  stripHtml,
  type RidbOptions,
} from "../ridb";
import type { Querier, RidbCandidate, RidbFacility, StagedRow } from "../store";

/**
 * The RIDB source's decisions, tested without a network or a database.
 *
 * The properties nothing else guards: the two-sided join's precedence (a mapper's own `website=`
 * tag beats the Wikidata claim), and the twin licence gates — RIDB states no licence anywhere, so
 * the managing agency gates the *text* and the per-image credit gates the *photo*, and getting
 * either wrong publishes somebody's work under a licence nobody stated.
 */

const POINT = '{"type":"Point","coordinates":[-121.7,46.9]}';

const candidate = (over: Partial<RidbCandidate> = {}): RidbCandidate => ({
  source: "osm",
  sourceId: "n/4242",
  category: "nature",
  subcategory: "campground",
  point: POINT,
  hasDescription: false,
  wdIds: [],
  ...over,
});

const facility = (over: Partial<RidbFacility> = {}): RidbFacility => ({
  facilityId: "232447",
  name: "Cougar Rock Campground",
  description: "Overview: A forested campground near the Nisqually River.",
  type: "Campground",
  org: "USDA Forest Service",
  orgId: "131",
  website: "https://www.recreation.gov/camping/campgrounds/232447",
  images: [{ url: "https://cdn.recreation.gov/public/x.jpg", credit: "USFS" }],
  ...over,
});

describe("stagedFromFacility — what a facility becomes", () => {
  it("stages a ridb record under the enriched record's own source id", () => {
    const row = stagedFromFacility(candidate(), facility());
    expect(row.source).toBe(RIDB_SOURCE);
    expect(row.sourceId).toBe("n/4242");
    expect(row.description).toBe("Overview: A forested campground near the Nisqually River.");
  });

  /** The credit names the agency whose federal employment is the whole licence argument. */
  it("credits the managing agency, public domain, linking the facility's own page", () => {
    expect(stagedFromFacility(candidate(), facility()).descriptionCredit).toEqual({
      license: "Public domain",
      author: "USDA Forest Service",
      sourceUrl: "https://www.recreation.gov/camping/campgrounds/232447",
    });
  });

  /**
   * The text gate. A state park or concessionaire listing rides recreation.gov too, and its prose
   * belongs to its author — nothing anywhere licenses us to republish it. The page and any
   * federally-credited photo still contribute; the words never do.
   */
  it("withholds the description for a non-federally-managed facility", () => {
    const row = stagedFromFacility(
      candidate(),
      facility({ org: "Oregon State Parks", orgId: "1005" }),
    );
    expect(row.description).toBeUndefined();
    expect(row.descriptionCredit).toBeUndefined();
    expect(row.website).toBe("https://www.recreation.gov/camping/campgrounds/232447");
  });

  /** The derived-record contract, restated from the NPS template — the invariant identity stands on. */
  it("names the record it was derived from, and asserts no identifiers of its own", () => {
    const row = stagedFromFacility(candidate(), facility());
    expect(row.derivedFrom).toEqual({ source: "osm", sourceId: "n/4242" });
    expect(row.upstreamIds).toEqual([]);
  });

  it("copies the point verbatim and stages no name — OSM owns what a place is called", () => {
    const row = stagedFromFacility(candidate(), facility());
    expect(row.point).toBe(POINT);
    expect(row.name).toBeUndefined();
  });

  /** The photo gate: first federally-credited image, not first image. */
  it("claims the first federally-credited image, skipping third-party ones ahead of it", () => {
    const row = stagedFromFacility(
      candidate(),
      facility({
        images: [
          { url: "https://cdn.recreation.gov/a.jpg", credit: "Conservation Legacy" },
          { url: "https://cdn.recreation.gov/b.jpg", credit: "Photo by USFS" },
        ],
      }),
    );
    expect(row.mediaRefs).toEqual([
      { kind: "url", value: "https://cdn.recreation.gov/b.jpg", claimedBy: RIDB_SOURCE },
    ]);
  });

  it("claims nothing when every image is third-party or uncredited", () => {
    const row = stagedFromFacility(
      candidate(),
      facility({
        images: [
          { url: "https://cdn.recreation.gov/a.jpg", credit: "Pro Sport" },
          { url: "https://cdn.recreation.gov/b.jpg" },
        ],
      }),
    );
    expect(row.mediaRefs).toEqual([]);
  });

  it("keeps build-side provenance: which facility said this", () => {
    expect(stagedFromFacility(candidate(), facility()).raw).toEqual({
      facilityId: "232447",
      name: "Cougar Rock Campground",
      type: "Campground",
      org: "USDA Forest Service",
    });
  });
});

describe("the licence gates", () => {
  it("federalOrg accepts exactly the six federal agencies' org ids", () => {
    for (const orgId of ["126", "127", "128", "129", "130", "131"]) {
      expect(federalOrg(orgId)).toBe(true);
    }
    expect(federalOrg("1005")).toBe(false); // a state parks org
    expect(federalOrg(undefined)).toBe(false);
  });

  it("fedCredit accepts federal-agency credit forms, initialism or full name, embedded or alone", () => {
    expect(fedCredit("USFS")).toBe(true);
    expect(fedCredit("Photo by USFS")).toBe(true);
    expect(fedCredit("US Army Corps of Engineers")).toBe(true);
    expect(fedCredit("bureau of land management")).toBe(true);
    expect(fedCredit("NPS / Jane Doe")).toBe(true);
  });

  /** No credit is *unknown*, not "probably fine" — same rule as the NPS gate, stricter corpus. */
  it("treats third-party, missing, and lookalike credits as unpublishable", () => {
    expect(fedCredit("Conservation Legacy")).toBe(false);
    expect(fedCredit("Pro Sport")).toBe(false);
    expect(fedCredit("")).toBe(false);
    expect(fedCredit(undefined)).toBe(false);
    // Word boundaries: an initialism inside another word is not a credit to the agency.
    expect(fedCredit("CAMPSITE")).toBe(false); // contains no agency token as a word
    expect(fedCredit("Simpson Timber Co")).toBe(false);
  });
});

describe("the two-sided join", () => {
  it("extracts the facility id a website= tag names", () => {
    expect(facilityIdFromWebsite("https://www.recreation.gov/camping/campgrounds/232447")).toBe(
      "232447",
    );
    expect(facilityIdFromWebsite("http://recreation.gov/camping/campgrounds/251434?tab=info")).toBe(
      "251434",
    );
    // The host alone is not a facility: gateways, POIs and the front page name no campground.
    expect(facilityIdFromWebsite("https://www.recreation.gov/")).toBeUndefined();
    expect(facilityIdFromWebsite("https://www.recreation.gov/camping/poi/12345")).toBeUndefined();
    expect(facilityIdFromWebsite(undefined)).toBeUndefined();
  });

  /** The mapper's own tag outranks the Wikidata claim — the article stage's precedence, restated. */
  it("prefers the record's own website tag over its QID's claim", () => {
    const idByWdId = new Map([["wd:Q11111", "999999"]]);
    expect(
      facilityIdOf(
        candidate({
          website: "https://www.recreation.gov/camping/campgrounds/232447",
          wdIds: ["wd:Q11111"],
        }),
        idByWdId,
      ),
    ).toBe("232447");
    expect(facilityIdOf(candidate({ wdIds: ["wd:Q11111"] }), idByWdId)).toBe("999999");
    expect(facilityIdOf(candidate(), idByWdId)).toBeUndefined();
  });

  it("facilityIdClaim reads a P6747 value, digits only", () => {
    expect(
      facilityIdClaim({
        qid: "Q11111",
        claims: { P6747: [{ kind: "string", value: " 232447 " }] },
        absent: false,
      }),
    ).toBe("232447");
    expect(facilityIdClaim({ qid: "Q1", claims: {}, absent: false })).toBeUndefined();
    expect(
      facilityIdClaim({
        qid: "Q2",
        claims: { P6747: [{ kind: "string", value: "not-a-number" }] },
        absent: false,
      }),
    ).toBeUndefined();
  });
});

describe("stripHtml — FacilityDescription arrives as markup", () => {
  /** Measured live: heading text is section chrome, and keeping it glues "Overview" into the prose. */
  it("drops heading elements wholesale, strips tags, decodes entities, collapses the residue", () => {
    expect(
      stripHtml("<h2>Overview</h2>A forested camp &amp; trailhead.<br /><br />Near the river."),
    ).toBe("A forested camp & trailhead. Near the river.");
    expect(stripHtml("Sites by the falls.<h3>Natural Features</h3>Old growth.")).toBe(
      "Sites by the falls. Old growth.",
    );
    expect(stripHtml("Rock &quot;shelter&quot; &lt;3 &#039;quiet&#039;")).toBe(
      "Rock \"shelter\" <3 'quiet'",
    );
    expect(stripHtml("&nbsp;&nbsp;spaced&nbsp;out ")).toBe("spaced out");
  });
});

describe("facilityOf — one API body into the cache's shape", () => {
  it("strips the description's HTML, keys the federal org, and sorts primary images first", () => {
    const out = facilityOf(
      {
        FacilityID: 232447,
        FacilityName: " Cougar Rock Campground ",
        FacilityDescription: "<h2>Overview</h2>Forested sites.",
        FacilityTypeDescription: "Campground",
        ORGANIZATION: [
          { OrgID: 1005, OrgName: "Oregon State Parks" },
          { OrgID: 131, OrgName: "USDA Forest Service" },
        ],
        MEDIA: [
          { MediaType: "Image", URL: "https://cdn.recreation.gov/b.jpg", Credits: "USFS" },
          { MediaType: "Video", URL: "https://cdn.recreation.gov/v.mp4" },
          { MediaType: "Image", URL: "https://cdn.recreation.gov/a.jpg", IsPrimary: true },
        ],
      },
      "232447",
    );
    expect(out).toMatchObject({
      facilityId: "232447",
      name: "Cougar Rock Campground",
      description: "Forested sites.",
      // The federal org wins the gate's key even when it is not listed first.
      org: "USDA Forest Service",
      orgId: "131",
      website: "https://www.recreation.gov/camping/campgrounds/232447",
    });
    expect(out?.images.map((image) => image.url)).toEqual([
      "https://cdn.recreation.gov/a.jpg",
      "https://cdn.recreation.gov/b.jpg",
    ]);
  });

  it("yields nothing for a body missing its name", () => {
    expect(facilityOf({ FacilityID: 1 }, "1")).toBeUndefined();
  });
});

describe("stageRidb — the loop", () => {
  const NOW = "2026-08-07T00:00:00.000Z";

  const candidateRow = (n: number, over: Record<string, unknown> = {}) => ({
    source: "osm",
    source_id: `n/${n}`,
    category: "nature",
    subcategory: null,
    website: null,
    point: POINT,
    has_description: false,
    wd_ids: [],
    ...over,
  });

  const entityRow = (qid: string, facilityId: string) => ({
    qid,
    claims: { P6747: [{ kind: "string", value: facilityId }] },
    enwiki_title: null,
    absent: false,
  });

  function fakeDb(
    entities: ReturnType<typeof entityRow>[],
    candidates: ReturnType<typeof candidateRow>[],
  ) {
    const staged: StagedRow[] = [];
    const cached: RidbFacility[] = [];
    const db: Querier = {
      query(sql: string, params: unknown[] = []) {
        if (sql.includes("INSERT INTO ridb_facilities")) {
          cached.push(...(JSON.parse(params[0] as string) as RidbFacility[]));
          return Promise.resolve({ rows: [] });
        }
        if (sql.startsWith("SELECT qid, claims, enwiki_title, absent FROM wikidata_entities")) {
          return Promise.resolve({ rows: entities });
        }
        if (sql.includes("recreation\\.gov/camping/campgrounds")) {
          return Promise.resolve({ rows: candidates });
        }
        if (sql.startsWith("INSERT INTO source_records")) {
          staged.push(...(JSON.parse(params[0] as string) as StagedRow[]));
          return Promise.resolve({ rows: [] });
        }
        throw new Error(`unexpected SQL: ${sql}`);
      },
    };
    return { db, staged, cached };
  }

  const facilityBody = (facilityId: string, over: Record<string, unknown> = {}) => ({
    FacilityID: facilityId,
    FacilityName: "Cougar Rock Campground",
    FacilityDescription: "Forested sites.",
    FacilityTypeDescription: "Campground",
    ORGANIZATION: [{ OrgID: 131, OrgName: "USDA Forest Service" }],
    MEDIA: [{ MediaType: "Image", URL: "https://cdn.recreation.gov/x.jpg", Credits: "USFS" }],
    ...over,
  });

  /** A fetch answering per-facility bodies by id; 404 for anything unlisted. Records what it was asked. */
  const api = (bodies: Record<string, unknown>, asked: string[] = []) =>
    ((url: string) => {
      asked.push(url);
      const id = /facilities\/(\d+)/.exec(url)?.[1] ?? "";
      const body = bodies[id];
      return Promise.resolve(
        body
          ? { ok: true, status: 200, json: () => Promise.resolve(body) }
          : { ok: false, status: 404, json: () => Promise.resolve({}) },
      );
    }) as unknown as typeof fetch;

  const run = (db: Querier, fetchImpl: typeof fetch, over: Partial<RidbOptions> = {}) =>
    stageRidb(db, {
      dryRun: false,
      apiKey: "TEST_KEY",
      userAgent: "test-agent (test@example.com)",
      fetchImpl,
      now: () => NOW,
      log: () => {},
      ...over,
    });

  it("joins through both sides, fetches each facility once, and stages what agencies say", async () => {
    const asked: string[] = [];
    const { db, staged, cached } = fakeDb(
      [entityRow("Q11111", "251434")],
      [
        candidateRow(1, {
          website: "https://www.recreation.gov/camping/campgrounds/232447",
        }),
        candidateRow(2, { wd_ids: ["wd:Q11111"] }),
        // A second mapper tagging the same facility: one fetch, two staged records.
        candidateRow(3, {
          website: "https://www.recreation.gov/camping/campgrounds/232447?tab=info",
        }),
      ],
    );
    const report = await run(
      db,
      api({ "232447": facilityBody("232447"), "251434": facilityBody("251434") }, asked),
    );
    expect(asked).toHaveLength(2); // unique facilities, not candidates
    expect(cached.map((f) => f.facilityId).sort()).toEqual(["232447", "251434"]);
    expect(staged).toHaveLength(3);
    expect(staged[0]).toMatchObject({
      source: "ridb",
      sourceId: "n/1",
      description: "Forested sites.",
      derivedFrom: { source: "osm", sourceId: "n/1" },
      upstreamIds: [],
    });
    expect(report).toMatchObject({
      requests: 2,
      facilities: 2,
      claims: 1,
      candidates: 3,
      staged: 3,
      withPhoto: 3,
      fillsDescription: 3,
    });
  });

  it("counts a delisted facility (404) as unknown, never as a failure", async () => {
    const { db, staged } = fakeDb(
      [],
      [candidateRow(1, { website: "https://www.recreation.gov/camping/campgrounds/999999" })],
    );
    const report = await run(db, api({}));
    expect(staged).toHaveLength(0);
    expect(report).toMatchObject({ requests: 1, facilities: 0, unknownFacility: 1, staged: 0 });
  });

  it("aborts whole on a 429 — an unanswered API is not knowledge about any facility", async () => {
    const { db, staged, cached } = fakeDb(
      [],
      [candidateRow(1, { website: "https://www.recreation.gov/camping/campgrounds/232447" })],
    );
    const throttled = (() =>
      Promise.resolve({
        ok: false,
        status: 429,
        json: () => Promise.resolve({}),
      })) as unknown as typeof fetch;
    await expect(run(db, throttled)).rejects.toThrow(/rate-limited/);
    expect(staged).toHaveLength(0);
    expect(cached).toHaveLength(0); // both durable writes land after the whole fetch
  });

  it("counts the text gate: non-federal facilities stage without prose", async () => {
    const { db, staged } = fakeDb(
      [],
      [candidateRow(1, { website: "https://www.recreation.gov/camping/campgrounds/232447" })],
    );
    const report = await run(
      db,
      api({
        "232447": facilityBody("232447", {
          ORGANIZATION: [{ OrgID: 1005, OrgName: "Oregon State Parks" }],
          MEDIA: [],
        }),
      }),
    );
    expect(staged[0]?.description).toBeUndefined();
    expect(staged[0]?.website).toBe(facilityPage("232447"));
    expect(report).toMatchObject({ staged: 1, nonFederal: 1, withPhoto: 0 });
  });

  it("dry-run writes nothing durable", async () => {
    const { db, staged, cached } = fakeDb(
      [],
      [candidateRow(1, { website: "https://www.recreation.gov/camping/campgrounds/232447" })],
    );
    const report = await run(db, api({ "232447": facilityBody("232447") }), { dryRun: true });
    expect(report.staged).toBe(1);
    expect(staged).toHaveLength(0);
    expect(cached).toHaveLength(0);
  });
});
