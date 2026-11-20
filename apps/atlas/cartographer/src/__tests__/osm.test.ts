import { describe, expect, it } from "vitest";
import { mediaRefsFor, stageOsmRow, upstreamIdsFor } from "../osm";
import type { OsmRow } from "../store";

const POINT = '{"type":"Point","coordinates":[-122.3049,47.9494]}';

const row = (over: Partial<OsmRow> = {}): OsmRow => ({
  osm_type: "W",
  osm_id: "586464226",
  name: "Mukilteo Lighthouse",
  tags: { name: "Mukilteo Lighthouse", man_made: "lighthouse" },
  point: POINT,
  geom: null,
  ...over,
});

describe("stageOsmRow — classification", () => {
  it("classifies through the shared taxonomy, not a local copy of it", () => {
    const staged = stageOsmRow(row());
    expect(staged).toMatchObject({
      sourceId: "way/586464226",
      name: "Mukilteo Lighthouse",
      category: "landmark",
      subcategory: "structure",
      point: POINT,
    });
  });

  it("drops a row whose tags match no taxonomy entry", () => {
    // The common case at extract scale: the Lua import filter is key-level, so it admits every named
    // `amenity` and the taxonomy classifies a fraction of them.
    expect(
      stageOsmRow(row({ tags: { name: "Joe's Diner", amenity: "restaurant" } })),
    ).toBeUndefined();
  });

  it("drops a row PostGIS gave no representative point for", () => {
    expect(stageOsmRow(row({ point: "" }))).toBeUndefined();
  });

  it("keeps a nameless surveillance row — the one name-exempt family — and synthesizes its name", () => {
    const staged = stageOsmRow(
      row({
        osm_type: "N",
        name: null,
        tags: {
          man_made: "surveillance",
          "surveillance:type": "ALPR",
          manufacturer: "Flock Safety",
        },
      }),
    );
    expect(staged).toMatchObject({
      sourceId: "node/586464226",
      category: "surveillance",
      name: "Flock Safety ALPR",
    });
    expect(staged?.description).toContain("ALPR");
  });

  it("stages the five remote-area tags the sparse half of the dataset rests on", () => {
    const cases: [Record<string, string>, string, string][] = [
      [{ tourism: "camp_site" }, "park", "camp"],
      [{ tourism: "picnic_site" }, "park", "picnic"],
      [{ natural: "volcano" }, "nature", "mountain"],
      [{ natural: "ridge" }, "nature", "mountain"],
      [{ natural: "glacier" }, "nature", "glacier"],
    ];
    for (const [tags, category, subcategory] of cases) {
      expect(stageOsmRow(row({ tags: { name: "Somewhere", ...tags } }))).toMatchObject({
        category,
        subcategory,
      });
    }
  });

  it("attaches area geometry for a way or relation, and nothing for a node", () => {
    const polygon = '{"type":"Polygon","coordinates":[[[0,0],[0,1],[1,1],[0,0]]]}';
    expect(stageOsmRow(row({ geom: polygon }))?.geometry).toBe(polygon);
    expect(stageOsmRow(row({ osm_type: "N", geom: null }))?.geometry).toBeUndefined();
  });

  // "Staging holds what the source said" used to be asserted here against an uncapped Wikipedia summary.
  // A mapper's own `description` tag is a different case — the shared classifier caps it at
  // `DESCRIPTION_MAX` on the way in — so the property moved to `wikipedia.test.ts` with the source it
  // was actually about.
});

describe("upstreamIdsFor — never invents an id", () => {
  it("always asserts the row's own OSM id, in the namespaced form", () => {
    expect(upstreamIdsFor(row())).toEqual(["osm:w/586464226"]);
    expect(upstreamIdsFor(row({ osm_type: "N" }))).toEqual(["osm:n/586464226"]);
    expect(upstreamIdsFor(row({ osm_type: "R" }))).toEqual(["osm:r/586464226"]);
  });

  it("uses a different id form from sourceId, on purpose", () => {
    // `sourceId` matches what the beacon server's own `osm` connector already wrote, so a volume
    // upserts onto those records instead of duplicating them. `upstream_ids` is namespaced because it
    // shares an array with wd:/nrhp:/commons: ids.
    const staged = stageOsmRow(row())!;
    expect(staged.sourceId).toBe("way/586464226");
    expect(staged.upstreamIds).toContain("osm:w/586464226");
  });

  it("collects the concordance keys a row actually carries", () => {
    const ids = upstreamIdsFor(
      row({
        tags: {
          name: "Mukilteo Lighthouse",
          man_made: "lighthouse",
          wikidata: "Q2680081",
          "ref:nrhp": "77001360",
          "gnis:feature_id": "1512760",
          wikimedia_commons: "Category:Mukilteo Light",
        },
      }),
    );
    expect(ids).toEqual([
      "osm:w/586464226",
      "wd:Q2680081",
      "nrhp:77001360",
      "gnis:1512760",
      "commons:Category:Mukilteo Light",
    ]);
  });

  it("ignores brand:wikidata — it names the chain, not the place", () => {
    // Concording on it would merge every branch of a coffee shop into one place.
    const ids = upstreamIdsFor(
      row({ tags: { name: "Starbucks", shop: "bakery", "brand:wikidata": "Q37158" } }),
    );
    expect(ids).toEqual(["osm:w/586464226"]);
  });

  it("ignores a malformed id rather than passing it through", () => {
    const ids = upstreamIdsFor(
      row({ tags: { wikidata: "not-a-qid", "ref:nrhp": "77", "gnis:feature_id": "abc" } }),
    );
    expect(ids).toEqual(["osm:w/586464226"]);
  });

  it("splits a `;`-separated list — a building can be on the register twice", () => {
    const ids = upstreamIdsFor(
      row({ tags: { "ref:nrhp": "77001360;88000123", "gnis:feature_id": "1512760; 99" } }),
    );
    expect(ids).toEqual([
      "osm:w/586464226",
      "nrhp:77001360",
      "nrhp:88000123",
      "gnis:1512760",
      "gnis:99",
    ]);
  });

  it("refuses a ref:nrhp holding a URL, and does not go looking in source_ref", () => {
    // The real Mukilteo Lighthouse row, and the reason `apps/atlas/doc/spec/place-identity.md` §8's
    // worked example does not produce `nrhp:77001360`: the register number is in the generic
    // `source_ref` tag, which names a source and asserts nothing about being an NRHP id. Reading it
    // out would be inventing one.
    const ids = upstreamIdsFor(
      row({
        tags: {
          wikidata: "Q2680081",
          "ref:nrhp": "https://catalog.archives.gov/id/75613230",
          source_ref: "77001360",
        },
      }),
    );
    expect(ids).toEqual(["osm:w/586464226", "wd:Q2680081"]);
  });

  it("takes a Commons value only when it names a category", () => {
    // A `File:` value is a photo reference, not an identifier for the entity.
    expect(upstreamIdsFor(row({ tags: { wikimedia_commons: "File:Mukilteo.jpg" } }))).toEqual([
      "osm:w/586464226",
    ]);
  });
});

describe("mediaRefsFor — collects, never chooses", () => {
  /** Most cases are category-indifferent; "landmark" stands in. The exception has its own test. */
  const refsFor = (r: Parameters<typeof mediaRefsFor>[0]) => mediaRefsFor(r, "landmark");

  it("records every reference a row carries, tagged with who claimed it", () => {
    // In `IMAGE_TAGS` order — the shared list, walked rather than restated.
    const refs = refsFor(
      row({
        tags: {
          image: "https://example.org/light.jpg",
          wikimedia_commons: "File:Mukilteo Light.jpg",
          wikidata: "Q2680081",
        },
      }),
    );
    expect(refs).toEqual([
      { kind: "url", value: "https://example.org/light.jpg", claimedBy: "osm" },
      { kind: "commons-file", value: "File:Mukilteo Light.jpg", claimedBy: "osm" },
      { kind: "wikidata", value: "Q2680081", claimedBy: "osm" },
    ]);
  });

  it("keeps a Commons category as a category — a set of photos of exactly this place", () => {
    // The beacon server's retired image ingestor rejected these outright; recording the kind is what
    // lets stage 4 pick a lead from the set instead.
    expect(refsFor(row({ tags: { wikimedia_commons: "Category:Mukilteo Light" } }))).toEqual([
      { kind: "commons-category", value: "Category:Mukilteo Light", claimedBy: "osm" },
    ]);
  });

  it("normalizes a Commons wiki page URL to its file title", () => {
    const refs = refsFor(
      row({ tags: { wikimedia_commons: "https://commons.wikimedia.org/wiki/File:A_b.jpg" } }),
    );
    expect(refs).toEqual([{ kind: "commons-file", value: "File:A b.jpg", claimedBy: "osm" }]);
  });

  it("records nothing for a row that references no photo", () => {
    expect(refsFor(row())).toEqual([]);
  });

  it("records brand:wikidata as its own kind — resolved through the logo claim, never P18", () => {
    // The first cut of this function dropped the tag entirely; the second folded it into `wikidata`,
    // which resolves through P18 — and a brand's P18 is typically the company headquarters, the wrong
    // image for a local branch. It is the one tag where the concordance rule and this one differ: a
    // chain's QID is the wrong identity for a branch (see `upstreamIdsFor`) and the right logo for it.
    const branded = row({
      tags: { name: "Starbucks", shop: "bakery", "brand:wikidata": "Q37158" },
    });
    expect(refsFor(branded)).toEqual([
      { kind: "brand-wikidata", value: "Q37158", claimedBy: "osm" },
    ]);
    expect(upstreamIdsFor(branded)).toEqual(["osm:w/586464226"]);
  });

  it("collects no brand ref for a surveillance place — a vendor logo is not its photo", () => {
    // The imagery exclusion (`apps/atlas/doc/spec/sources.md` §3) at the one collection site that
    // knows the category: 2,026 staged surveillance records carry brand tags (Flock and kin), and a
    // vendor's mark as the place's card image is the same waste the street-photo exclusion names.
    const camera = row({ tags: { man_made: "surveillance", "brand:wikidata": "Q108485435" } });
    expect(mediaRefsFor(camera, "surveillance")).toEqual([]);
  });

  it("normalizes underscores to spaces — the form MediaWiki actually replies in", () => {
    // Not cosmetic. Comparing an underscore title against MediaWiki's space form once rejected *every*
    // lead image: a 100% rejection rate indistinguishable from "these articles have no free images".
    // `wikimedia_commons=File:Some_Building.jpg` is the common OSM spelling, so this is the common case.
    expect(refsFor(row({ tags: { wikimedia_commons: "File:Mukilteo_Light.jpg" } }))).toEqual([
      { kind: "commons-file", value: "File:Mukilteo Light.jpg", claimedBy: "osm" },
    ]);
  });

  it("takes the real file out of a thumb URL, not the scaled render's name", () => {
    // The sharded `a/ab/` path is what makes this work: the last path segment would be
    // `800px-Example.jpg`, a file that does not exist on Commons.
    const refs = refsFor(
      row({
        tags: {
          wikimedia_commons:
            "https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/Example.jpg/800px-Example.jpg",
        },
      }),
    );
    expect(refs).toEqual([{ kind: "commons-file", value: "File:Example.jpg", claimedBy: "osm" }]);
  });
});
