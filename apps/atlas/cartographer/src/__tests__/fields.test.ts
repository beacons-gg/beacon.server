import { describe, expect, it } from "vitest";
import {
  FIELD_ORDERS,
  FIELD_SOURCES,
  mergePlace,
  SOURCE_TERMS,
  sourceRank,
  type MergeInput,
  type SourceTerms,
} from "../fields";

/**
 * Stage 3's rules, tested directly. The database cannot tell you whether they are right: a place with a
 * description looks identical whether the description came from the source that should have won or the
 * one that happened to sort first.
 */

const POINT = '{"type":"Point","coordinates":[-122.3,47.9]}';

const record = (source: string, over: Partial<MergeInput> = {}): MergeInput => ({
  source,
  category: "landmark",
  point: POINT,
  ...over,
});

describe("per-field priority", () => {
  /**
   * The whole difference from the server's single `SOURCE_PRIORITY`:
   * `apps/atlas/doc/spec/sources.md` §5 gives OSM the name outright and gives the description to
   * whoever owns the place. One global order cannot express both, and the version that tried gave
   * parks the Park Service's name instead of the local one.
   */
  it("gives the name to the mapper and the description to the owner, from the same two records", () => {
    const merged = mergePlace([
      record("osm", { name: "Hurricane Ridge", description: "Ridge in the Olympics." }),
      record("nps", { name: "Hurricane Ridge Visitor Center", description: "A mile high, and..." }),
    ]);
    expect(merged?.name).toBe("Hurricane Ridge");
    expect(merged?.description).toBe("A mile high, and...");
    // Both contributed, so both owe attribution.
    expect(merged?.sources).toEqual(["nps", "osm"]);
  });

  it("ranks unknown sources after every known one, but still lets them fill a hole", () => {
    expect(sourceRank("name", "osm")).toBeLessThan(sourceRank("name", "nps"));
    expect(sourceRank("name", "someone-new")).toBeGreaterThan(sourceRank("name", "wikivoyage"));

    const merged = mergePlace([
      record("osm", { name: "Pike Place" }),
      record("someone-new", { name: "Pike Pl", website: "https://pikeplacemarket.org/" }),
    ]);
    expect(merged?.name).toBe("Pike Place");
    // It lost the contest it entered and still filled the field nobody else had.
    expect(merged?.website).toBe("https://pikeplacemarket.org/");
  });
});

describe("gap-fill, never overwrite", () => {
  it("lets a lower-priority source fill an empty field and not replace a full one", () => {
    const merged = mergePlace([
      record("osm", { name: "Mukilteo Light" }),
      record("wikipedia", { name: "Mukilteo Lighthouse", description: "An operational aid." }),
    ]);
    expect(merged?.name).toBe("Mukilteo Light");
    expect(merged?.description).toBe("An operational aid.");
  });

  /** Adding a source must only ever add detail — otherwise a new corpus silently restates the dataset. */
  it("is monotonic: adding a source cannot change a field that was already filled", () => {
    const before = mergePlace([record("osm", { name: "A", description: "from osm" })]);
    const after = mergePlace([
      record("osm", { name: "A", description: "from osm" }),
      record("wikipedia", { name: "B", description: "from wikipedia" }),
    ]);
    expect(after?.name).toBe(before?.name);
    // The description is the one field where an *owner* outranks the mapper — wikipedia is not one.
    expect(after?.description).toBe("from osm");
  });
});

describe("a credit travels with the text it credits", () => {
  const WIKI = { license: "CC BY-SA 4.0", author: "Wikipedia contributors" };

  /**
   * The bug this rule exists for, and it is a licensing bug rather than a cosmetic one: ranked
   * separately, the credit would attach Wikipedia's terms to the Park Service's public-domain words.
   */
  it("takes the credit from whichever record won the description, not from its own rank", () => {
    const merged = mergePlace([
      record("nps", { description: "Park Service prose." }),
      record("wikipedia", { description: "Encyclopedia prose.", descriptionCredit: WIKI }),
    ]);
    expect(merged?.description).toBe("Park Service prose.");
    expect(merged?.descriptionCredit).toBeUndefined();
  });

  it("keeps them together when the credited source does win", () => {
    const merged = mergePlace([
      record("osm", { name: "Somewhere" }),
      record("wikipedia", { description: "Encyclopedia prose.", descriptionCredit: WIKI }),
    ]);
    expect(merged?.description).toBe("Encyclopedia prose.");
    expect(merged?.descriptionCredit).toEqual(WIKI);
  });
});

describe("what does not become a place", () => {
  it("refuses an entity with no records", () => {
    expect(mergePlace([])).toBeUndefined();
  });

  /** The same gate the server's `canonicalPlace` applies — a record a consumer would reject is not one to publish. */
  it("refuses a result with no point", () => {
    const noPoint = { source: "osm", category: "landmark" } as unknown as MergeInput;
    expect(mergePlace([noPoint])).toBeUndefined();
  });
});

describe("sources are only those that won something", () => {
  it("omits a record whose every field lost", () => {
    const merged = mergePlace([
      record("osm", { name: "Winner", description: "Also the winner." }),
      record("wikivoyage", { name: "Loser", description: "Also lost." }),
    ]);
    // Listing wikivoyage would attach a CC BY-SA obligation to a place none of whose words it wrote.
    expect(merged?.sources).toEqual(["osm"]);
  });

  it("is sorted, so two runs produce the same bytes", () => {
    const a = mergePlace([record("wikipedia", { description: "d" }), record("osm", { name: "n" })]);
    const b = mergePlace([record("osm", { name: "n" }), record("wikipedia", { description: "d" })]);
    expect(a?.sources).toEqual(b?.sources);
  });
});

describe("SOURCE_TERMS", () => {
  /**
   * A published field whose licence nobody declared is the one publishing mistake a later version cannot
   * repair, because a version's bytes never change. So every source that can win a field must have terms
   * — and `volume.ts` throws on one that does not, which only helps if this table is the thing kept in step.
   */
  it("gives every declared source a name, an attribution line and a licence", () => {
    for (const [id, terms] of Object.entries<SourceTerms>(SOURCE_TERMS)) {
      expect(terms.name, `${id} has no name`).toBeTruthy();
      expect(terms.attribution, `${id} has no attribution`).toBeTruthy();
      expect(terms.license, `${id} has no licence`).toBeTruthy();
      // Optional, and absent on purpose for public domain — there is no licence to link to. Required, it
      // would have forced a fabricated URL into an immutable published claim.
      if (terms.licenseUrl !== undefined) {
        expect(terms.licenseUrl, `${id}'s licence url`).toMatch(/^https:\/\//);
      }
    }
  });

  it("carries the shared OSM and Wikipedia credit lines rather than a second copy", () => {
    expect(SOURCE_TERMS.osm.attribution).toBe("© OpenStreetMap contributors (ODbL)");
    expect(SOURCE_TERMS.wikipedia.license).toBe("CC BY-SA 4.0");
  });

  it("says public domain carries no licence url, rather than leaving the field to chance", () => {
    expect(SOURCE_TERMS.nps.license).toBe("Public domain");
    expect(SOURCE_TERMS.nps).not.toHaveProperty("licenseUrl");
  });

  /**
   * The invariant a type now enforces, restated here because it is the one that matters: every source the
   * priority tables rank must have terms. The first cut ranked six and declared two, and this test — which
   * iterated the *declarations* — could not have caught it.
   */
  it("declares terms for every source any field ranks", () => {
    // Derived from FIELD_SOURCES rather than listed, so a source added to the vocabulary is checked
    // here whether or not anyone remembers to add it — which is the failure this test exists for.
    for (const field of ["name", "description"] as const) {
      for (const source of FIELD_SOURCES) {
        expect(sourceRank(field, source), `${source} is unranked for ${field}`).toBeLessThan(
          FIELD_SOURCES.length,
        );
        expect(SOURCE_TERMS, `${source} is ranked but undeclared`).toHaveProperty(source);
      }
    }
  });

  /**
   * The converse, and the half a type cannot state: `satisfies readonly FieldSourceId[]` checks that every
   * *listed* source is a field source, not that every field source is *listed*. A source declared and left
   * out of an order silently contributes nothing to that field — a gap-fill failure wearing a ranking's
   * clothes, which is exactly what the docblock above `FIELD_PRIORITY` promises cannot happen.
   */
  it("names every field source in every priority order, and none twice", () => {
    const expected = [...FIELD_SOURCES].sort();
    for (const [name, order] of Object.entries(FIELD_ORDERS)) {
      expect([...order].sort(), `${name} is not a permutation of the field sources`).toEqual(
        expected,
      );
    }
  });

  /**
   * A media source must be declared — `dict.sources` has to state terms for every photo published — but must
   * never be rankable, because it describes no place. Folding the two tables together compiles and breaks
   * exactly this.
   */
  it("declares Commons for photos while keeping it out of the field vocabulary", () => {
    expect(SOURCE_TERMS).toHaveProperty("commons");
    expect(FIELD_SOURCES).not.toContain("commons");
    expect(sourceRank("name", "commons")).toBeGreaterThanOrEqual(6);
    // No corpus-level licence claim: Commons files are licensed per file, which is why the source is
    // admissible at all, and asserting one licence here would be a fabrication in immutable bytes.
    expect(SOURCE_TERMS.commons).not.toHaveProperty("licenseUrl");
    expect(SOURCE_TERMS.commons.license).toMatch(/per file/i);
  });
});
