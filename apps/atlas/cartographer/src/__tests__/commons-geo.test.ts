import { describe, expect, it } from "vitest";
import {
  categoryLead,
  dumpColumns,
  geoTagOf,
  GEO_CLAIMER,
  IMAGERY_EXCLUDED_CATEGORY,
  parseTuples,
  pickGeoRefs,
  stagedFromGeo,
} from "../commons-geo";
import type { GeoCandidate, GeoHit } from "../store";

/** Column positions for the standard dump order, as `loadGeoDump` derives them. */
const AT = { pageId: 1, globe: 2, primary: 3, lat: 4, lon: 5 } as const;

describe("parseTuples — one mysqldump VALUES payload", () => {
  it("splits rows and fields, and reads NULL as null only unquoted", () => {
    expect(parseTuples("(1,'earth',NULL),(2,'NULL',3.5)")).toEqual([
      ["1", "earth", null],
      ["2", "NULL", "3.5"],
    ]);
  });

  /**
   * The reason this is a tokenizer: `gt_name` carries real file names. A parser that mis-tracks one
   * string boundary shears every row after it — so the quoting cases are the whole test.
   */
  it("survives escaped quotes, backslashes and doubled quotes inside strings", () => {
    expect(parseTuples("(1,'O\\'Brien Park'),(2,'a\\\\b'),(3,'it''s'),(4,'a,(b)')")).toEqual([
      ["1", "O'Brien Park"],
      ["2", "a\\b"],
      ["3", "it's"],
      ["4", "a,(b)"],
    ]);
  });

  it("reads negative and decimal numbers as their text", () => {
    expect(parseTuples("(7,-122.30000000,47.60000000)")).toEqual([
      ["7", "-122.30000000", "47.60000000"],
    ]);
  });
});

describe("dumpColumns — the dump's own CREATE TABLE is the authority on order", () => {
  it("reads column names in declaration order, ignoring key lines", () => {
    expect(
      dumpColumns([
        "  `gt_id` bigint unsigned NOT NULL AUTO_INCREMENT,",
        "  `gt_page_id` int unsigned NOT NULL,",
        "  PRIMARY KEY (`gt_id`),",
        "  KEY `gt_page_primary` (`gt_page_id`,`gt_primary`)",
      ]),
    ).toEqual(["gt_id", "gt_page_id"]);
  });
});

describe("geoTagOf — which dump rows are usable coordinates", () => {
  const tuple = (over: Partial<Record<keyof typeof AT, string | null>>): (string | null)[] => {
    const row: (string | null)[] = ["9", "123", "earth", "1", "47.6", "-122.3"];
    for (const [key, value] of Object.entries(over)) row[AT[key as keyof typeof AT]] = value;
    return row;
  };

  it("keeps an earth row with valid coordinates, reading the primary flag", () => {
    expect(geoTagOf(tuple({}), AT)).toEqual({
      pageId: 123,
      isPrimary: true,
      lat: 47.6,
      lon: -122.3,
    });
    expect(geoTagOf(tuple({ primary: "0" }), AT)?.isPrimary).toBe(false);
  });

  it("drops other globes — the Moon is geotagged too", () => {
    expect(geoTagOf(tuple({ globe: "moon" }), AT)).toBeUndefined();
  });

  it("drops missing and out-of-range coordinates", () => {
    expect(geoTagOf(tuple({ lat: null }), AT)).toBeUndefined();
    expect(geoTagOf(tuple({ lat: "91" }), AT)).toBeUndefined();
    expect(geoTagOf(tuple({ lon: "-181" }), AT)).toBeUndefined();
  });
});

describe("categoryLead — a deterministic, publishable pick from a curated set", () => {
  it("prefers a photograph and picks deterministically by title", () => {
    expect(categoryLead(["File:Z.jpg", "File:A.jpg", "File:M.png"])).toBe("File:A.jpg");
  });

  /** A category's PDFs, SVG maps and archival TIFFs are real members and wrong leads. */
  it("yields nothing when no member is a publishable photo", () => {
    expect(categoryLead(["File:Map.svg", "File:Scan.tif", "File:Plan.pdf"])).toBeUndefined();
    expect(categoryLead([])).toBeUndefined();
  });
});

describe("pickGeoRefs — the containment selection rule", () => {
  const hit = (pageId: number, over: Partial<GeoHit> = {}): GeoHit => ({
    pageId,
    isPrimary: true,
    distM: 100,
    ...over,
  });
  const titles = new Map<number, string>([
    [1, "File:Near.jpg"],
    [2, "File:Far.jpg"],
    [3, "File:Object.jpg"],
    [4, "File:M 3510533 nw 13 060 20200607.tif"],
  ]);

  it("puts an object-location claim above a nearer camera position", () => {
    expect(
      pickGeoRefs([hit(1, { distM: 5 }), hit(3, { isPrimary: false, distM: 250 })], titles),
    ).toEqual(["File:Object.jpg", "File:Near.jpg"]);
  });

  it("orders camera positions by distance and caps the picks", () => {
    const many = [
      hit(1, { distM: 10 }),
      hit(2, { distM: 20 }),
      hit(3, { distM: 30 }),
      hit(5, { distM: 1 }),
    ];
    const wide = new Map([...titles, [5, "File:Fifth.jpg"] as const]);
    expect(pickGeoRefs(many, wide)).toEqual(["File:Fifth.jpg", "File:Near.jpg", "File:Far.jpg"]);
  });

  /** A page inside the polygon by both its camera and object rows counts once, as its stronger kind. */
  it("dedupes a page with both coordinate kinds onto its object row", () => {
    expect(
      pickGeoRefs([hit(3, { distM: 5 }), hit(3, { isPrimary: false, distM: 40 })], titles),
    ).toEqual(["File:Object.jpg"]);
  });

  /**
   * The probe's counterexample, kept as a test: USDA NAIP aerial-survey TIFFs are geotagged on a grid
   * across the country and land inside every rural polygon. Not a photo of anything in particular.
   */
  it("drops non-photo files and pages that never resolved to a title", () => {
    expect(pickGeoRefs([hit(4), hit(99)], titles)).toEqual([]);
  });
});

describe("stagedFromGeo — the derived-record template, photo-only", () => {
  const candidate: GeoCandidate = {
    source: "osm",
    sourceId: "w/123",
    category: "park",
    subcategory: "city-park",
    point: '{"type":"Point","coordinates":[-122.3,47.6]}',
    hits: [{ pageId: 1, isPrimary: true, distM: 12 }],
  };
  const titles = new Map([[1, "File:Coffee_Pot.jpg"]]);

  it("stages one commons record naming its parent, with the point copied verbatim", () => {
    const row = stagedFromGeo(candidate, titles);
    expect(row).toMatchObject({
      source: "commons",
      sourceId: "w/123",
      category: "park",
      subcategory: "city-park",
      point: candidate.point,
      upstreamIds: [],
      derivedFrom: { source: "osm", sourceId: "w/123" },
      mediaRefs: [{ kind: "commons-file", value: "File:Coffee Pot.jpg", claimedBy: GEO_CLAIMER }],
    });
    // This source says nothing *about* the place — it only offers photos taken inside it.
    expect(row?.name).toBeUndefined();
    expect(row?.description).toBeUndefined();
  });

  /** The orphan guard: a record with no refs would publish nothing and still join an entity. */
  it("stages nothing when no contained file survives selection", () => {
    expect(stagedFromGeo(candidate, new Map())).toBeUndefined();
  });
});

/**
 * The category no imagery slice searches — `apps/atlas/doc/spec/sources.md` §3. Pinned so a
 * taxonomy rename cannot silently turn the exclusion into a no-op predicate on a category that no
 * longer exists.
 */
it("excludes surveillance places from imagery search, by category", () => {
  expect(IMAGERY_EXCLUDED_CATEGORY).toBe("surveillance");
});
