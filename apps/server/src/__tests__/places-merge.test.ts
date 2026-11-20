import { describe, expect, it } from "vitest";
import {
  adminConflicts,
  ADMIN_SOURCE,
  CONTRIB_SOURCE,
  isInputSource,
  mergeFields,
  sourceRank,
} from "../places/merge";
import {
  enrichmentForTags,
  entriesForCategories,
  entryForTags,
  OSM_TAG_MAP,
} from "@beaconsgg/place-taxonomy";
import type { PlaceSourceRecord } from "../stores/place-store";

const T0 = "2026-07-23T00:00:00.000Z";

function src(
  source: string,
  fields: PlaceSourceRecord["fields"],
  goneAt?: string,
): PlaceSourceRecord {
  return {
    source,
    sourceId: source === "admin" ? "P1" : `id/${source}`,
    placeUnique: "P1",
    fields,
    syncedAt: T0,
    ...(goneAt !== undefined ? { goneAt } : {}),
  };
}

describe("sourceRank — merge priority (`apps/atlas/doc/spec/beacon-integration.md` §6)", () => {
  it("orders admin > list:* > contrib > atlas:* > everything else", () => {
    // Every ranked prefix is listed here on purpose: the assertions below only pin what they're
    // given, so a source missing from this array would ship with its rank untested.
    const ranks = ["admin", "list:seattle-parks", CONTRIB_SOURCE, "atlas:us-west"].map(sourceRank);
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
    expect(new Set(ranks).size).toBe(4);
    // The legacy residue rule: `osm` is deliberately unlisted, so it (like any unknown) ranks
    // after every living input — stale connector data can fill holes but never win a contest.
    expect(sourceRank("osm")).toBe(sourceRank("something-else"));
    expect(sourceRank("osm")).toBeGreaterThan(sourceRank("atlas:us-west"));
  });

  it("isInputSource matches exactly the ranked inputs — the places.source.retire refusal", () => {
    for (const input of ["admin", "list:seattle-parks", CONTRIB_SOURCE, "atlas:us-west"]) {
      expect(isInputSource(input)).toBe(true);
    }
    expect(isInputSource("osm")).toBe(false);
    expect(isInputSource("mapbox")).toBe(false);
  });
});

describe("mergeFields — per-field priority merge", () => {
  it("takes each field from the highest-priority source that has it", () => {
    const merged = mergeFields([
      src("osm", { category: "sweets", name: "OSM Name", point: { lat: 1, lng: 2 } }),
      src("admin", { name: "Curated Name" }),
    ]);
    expect(merged).toEqual({
      category: "sweets", // only OSM has it
      name: "Curated Name", // admin wins the field it holds
      point: { lat: 1, lng: 2 },
    });
  });

  it("ignores gone sources", () => {
    const merged = mergeFields([src("osm", { name: "Live" }), src("list:x", { name: "Gone" }, T0)]);
    expect(merged.name).toBe("Live");
  });

  it("list beats atlas; atlas beats the legacy osm residue", () => {
    const merged = mergeFields([
      src("osm", { name: "OSM" }),
      src("atlas:us-west", { name: "Atlas" }),
      src("list:parks", { name: "List" }),
    ]);
    expect(merged.name).toBe("List");
    expect(
      mergeFields([src("osm", { name: "OSM" }), src("atlas:us-west", { name: "Atlas" })]).name,
    ).toBe("Atlas");
  });

  it("an approved contribution beats the connector but yields to curation", () => {
    // The reason contrib outranks osm: reviewed human input should win a raw connector value.
    expect(
      mergeFields([src("osm", { name: "OSM" }), src(CONTRIB_SOURCE, { name: "Contributed" })]).name,
    ).toBe("Contributed");
    // …but an operator's own work still wins, whether direct or via a curated list.
    expect(
      mergeFields([src(CONTRIB_SOURCE, { name: "Contributed" }), src("admin", { name: "Curated" })])
        .name,
    ).toBe("Curated");
    expect(
      mergeFields([
        src(CONTRIB_SOURCE, { name: "Contributed" }),
        src("list:parks", { name: "List" }),
      ]).name,
    ).toBe("List");
  });

  it("the common case is a hole-fill, not a contest", () => {
    // OSM records are thin — this is what the whole contribution feature exists for.
    const merged = mergeFields([
      src("osm", { category: "park", name: "Volunteer Park", point: { lat: 1, lng: 2 } }),
      src(CONTRIB_SOURCE, { description: "A 1904 Olmsted park with a conservatory." }),
    ]);
    expect(merged).toEqual({
      category: "park",
      name: "Volunteer Park",
      point: { lat: 1, lng: 2 },
      description: "A 1904 Olmsted park with a conservatory.",
    });
  });
});

/**
 * A credit is an attribute of the text it credits, not an independent fact, so it must never be
 * merged on its own rank. Getting this wrong is a licensing bug: an operator's own words carrying a
 * CC BY-SA label and an author who didn't write them.
 */
describe("mergeFields — descriptionCredit travels with its description", () => {
  const WIKI_CREDIT = {
    license: "CC BY-SA 4.0",
    sourceUrl: "https://en.wikipedia.org/wiki/Volunteer_Park",
  };

  it("keeps the pair together when the same source wins both", () => {
    const merged = mergeFields([
      src("osm", { description: "A 1904 Olmsted park.", descriptionCredit: WIKI_CREDIT }),
    ]);
    expect(merged.description).toBe("A 1904 Olmsted park.");
    expect(merged.descriptionCredit).toEqual(WIKI_CREDIT);
  });

  it("drops the credit when a higher-priority source replaces the description", () => {
    const merged = mergeFields([
      src("osm", { description: "A 1904 Olmsted park.", descriptionCredit: WIKI_CREDIT }),
      src("admin", { description: "Rewritten by an operator." }),
    ]);
    expect(merged.description).toBe("Rewritten by an operator.");
    // The whole point: NOT WIKI_CREDIT. Plain per-field merge would have paired these.
    expect(merged.descriptionCredit).toBeUndefined();
  });

  it("carries the credit of whichever source actually won the description", () => {
    const listCredit = { license: "CC0 1.0", sourceUrl: "https://example.test/list" };
    const merged = mergeFields([
      src("osm", { description: "OSM text.", descriptionCredit: WIKI_CREDIT }),
      src("list:parks", { description: "List text.", descriptionCredit: listCredit }),
    ]);
    expect(merged.description).toBe("List text.");
    expect(merged.descriptionCredit).toEqual(listCredit);
  });

  it("ignores a credit from a source that carries no description at all", () => {
    const merged = mergeFields([
      src("osm", { description: "OSM text." }),
      src("list:parks", { descriptionCredit: WIKI_CREDIT }),
    ]);
    expect(merged.description).toBe("OSM text.");
    expect(merged.descriptionCredit).toBeUndefined();
  });

  // The same rule on the review side: a credit isn't independently reviewable, so a differing one
  // must not queue a second row beside its description's.
  it("raises a conflict for the description but not separately for its credit", () => {
    const conflicts = adminConflicts(
      { source: "osm", fields: { description: "Wikipedia text.", descriptionCredit: WIKI_CREDIT } },
      [src(ADMIN_SOURCE, { description: "Operator text." })],
    );
    expect(conflicts.map((c) => c.field)).toEqual(["description"]);
  });
});

describe("adminConflicts — the approval queue (`doc/spec/places.md` §3.1)", () => {
  const admin = src("admin", {
    name: "Curated",
    media: [{ type: "image", role: "thumb", hash: "h", uris: ["h@x"] }],
  });

  it("raises a conflict only for admin-held fields with a different incoming value", () => {
    const conflicts = adminConflicts(
      { source: "osm", fields: { name: "Fresh OSM Name", category: "sweets" } },
      [admin, src("osm", { name: "Old" })],
    );
    expect(conflicts).toEqual([
      { field: "name", currentValue: "Curated", incomingValue: "Fresh OSM Name" },
    ]);
  });

  it("identical values (key order insensitive) raise nothing", () => {
    const held = src("admin", { point: { lat: 1, lng: 2 } });
    const conflicts = adminConflicts({ source: "osm", fields: { point: { lng: 2, lat: 1 } } }, [
      held,
    ]);
    expect(conflicts).toHaveLength(0);
  });

  it("no admin source, admin incoming, or unheld fields raise nothing", () => {
    expect(adminConflicts({ source: "osm", fields: { name: "X" } }, [])).toHaveLength(0);
    expect(adminConflicts({ source: "admin", fields: { name: "X" } }, [admin])).toHaveLength(0);
    expect(adminConflicts({ source: "osm", fields: { category: "park" } }, [admin])).toHaveLength(
      0,
    );
  });
});

describe("taxonomy — OSM tag mapping", () => {
  it("maps a known tag to its bucket and ignores unknown tags", () => {
    expect(entryForTags({ shop: "bakery", name: "X" })).toMatchObject({ category: "sweets" });
    expect(entryForTags({ amenity: "parking" })).toBeUndefined();
  });

  it("filters mapping entries by category subset (all when unset)", () => {
    const sweets = entriesForCategories(["sweets"]);
    expect(sweets.length).toBeGreaterThan(0);
    expect(sweets.every((e) => e.category === "sweets")).toBe(true);
    expect(entriesForCategories(undefined).length).toBeGreaterThan(sweets.length);
  });
});

describe("enrichmentForTags — the shared tag→descriptor facts", () => {
  const entry = (key: string, value: string) =>
    OSM_TAG_MAP.find((e) => e.key === key && e.value === value)!;
  const bakery = entry("shop", "bakery");
  const cctv = entry("man_made", "surveillance");
  const speedCam = entry("highway", "speed_camera");

  it("passes the OSM description through (capped) and normalizes the website scheme", () => {
    const out = enrichmentForTags(
      { description: "  Best sourdough in town. ", website: "macrina.example.com" },
      bakery,
    );
    expect(out.description).toBe("Best sourdough in town.");
    expect(out.website).toBe("https://macrina.example.com");
    expect(out.name).toBeUndefined();

    expect(enrichmentForTags({ description: "x".repeat(600) }, bakery).description).toHaveLength(
      500,
    );
    expect(enrichmentForTags({ "contact:website": "https://a.example.com" }, bakery).website).toBe(
      "https://a.example.com",
    );
    expect(enrichmentForTags({ website: "not a url" }, bakery).website).toBeUndefined();
  });

  it("synthesizes Flock ALPR details + a branded name for nameless surveillance (DeFlock tags)", () => {
    const out = enrichmentForTags(
      {
        man_made: "surveillance",
        "surveillance:type": "ALPR",
        manufacturer: "Flock Safety",
        operator: "Kirkland Police Department",
      },
      cctv,
    );
    expect(out.description).toBe(
      "Flock Safety ALPR (automatic license plate reader) camera, operated by Kirkland Police Department",
    );
    expect(out.name).toBe("Flock Safety ALPR");
  });

  it("keeps generic cameras nameless and description-less; a real name wins over synthesis", () => {
    // No brand, no type, no operator — nothing worth saying.
    expect(enrichmentForTags({ man_made: "surveillance" }, cctv)).toEqual({});
    // Branded but already named: description synthesized, name NOT (the OSM name wins upstream).
    const named = enrichmentForTags(
      { man_made: "surveillance", manufacturer: "Flock Safety", name: "5th Ave camera" },
      cctv,
    );
    expect(named.name).toBeUndefined();
    expect(named.description).toBe("Flock Safety surveillance camera");
    // An OSM description is never overwritten by synthesis.
    expect(
      enrichmentForTags({ description: "Old camera.", manufacturer: "Flock Safety" }, cctv)
        .description,
    ).toBe("Old camera.");
  });

  it("labels speed cameras as such, with operator when known", () => {
    expect(
      enrichmentForTags({ highway: "speed_camera", operator: "City of Shoreline" }, speedCam)
        .description,
    ).toBe("speed camera, operated by City of Shoreline");
  });

  it("wikipedia: only English entries, both tag conventions, underscored + encoded", () => {
    expect(enrichmentForTags({ wikipedia: "en:Gas Works Park" }, bakery).wikipedia).toBe(
      "https://en.wikipedia.org/wiki/Gas_Works_Park",
    );
    expect(enrichmentForTags({ "wikipedia:en": "Pike Place Market" }, bakery).wikipedia).toBe(
      "https://en.wikipedia.org/wiki/Pike_Place_Market",
    );
    // Non-English entries are deliberately skipped.
    expect(
      enrichmentForTags({ wikipedia: "de:Englischer Garten" }, bakery).wikipedia,
    ).toBeUndefined();
    expect(enrichmentForTags({}, bakery).wikipedia).toBeUndefined();
  });

  it("altNames: collects the alias tags, splits alt_name on ';', dedupes, skips the primary name", () => {
    const out = enrichmentForTags(
      {
        name: "T-Mobile Park",
        alt_name: "The Safe;Safeco Field",
        short_name: "The Safe", // duplicate of an alt_name entry
        official_name: "T-Mobile Park", // the primary name never repeats as an alias
        old_name: "Safeco Field", // duplicate again
      },
      bakery,
    );
    expect(out.altNames).toEqual(["The Safe", "Safeco Field"]);
    expect(enrichmentForTags({ name: "X" }, bakery).altNames).toBeUndefined();
  });
});
