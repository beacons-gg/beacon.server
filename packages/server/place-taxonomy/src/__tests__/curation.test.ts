import { describe, expect, it } from "vitest";
import { OSM_TAG_MAP, PLACE_VOCABULARY, subcategoryOf } from "../taxonomy";

/**
 * The curation rules `OSM_TAG_MAP`'s header states. They were documentation only — a comment and
 * nothing else, with no denylist, no filter and no test — so nothing would have failed if a later
 * edit had added `amenity=school`. Both rules have a real-world cost to getting wrong and neither
 * is re-derivable from the data, which is what makes them worth pinning rather than trusting.
 */
describe("OSM_TAG_MAP curation rules", () => {
  /**
   * **No sensitive locations.** A game that sends players to look at a place must not send them to
   * a school, a hospital, a shelter or a place of worship — the harm isn't in the map data, it's in
   * the traffic. Each pair below is a plausible-looking addition someone could make in good faith
   * while growing the `community` or `sports` coverage; naming them is the point.
   */
  it("admits no sensitive location type", () => {
    const forbidden = [
      "amenity=school",
      "amenity=kindergarten",
      "amenity=college",
      "amenity=hospital",
      "amenity=clinic",
      "amenity=doctors",
      "amenity=nursing_home",
      "amenity=place_of_worship",
      "amenity=childcare",
      "amenity=social_facility",
      "amenity=shelter",
      "amenity=police",
      "amenity=prison",
      // Not sensitive, but the same judgement call the header records: every school ballfield.
      "leisure=pitch",
    ];
    const present = OSM_TAG_MAP.map((e) => `${e.key}=${e.value}`);
    expect(forbidden.filter((pair) => present.includes(pair))).toEqual([]);
  });

  /**
   * `tourism=attraction` is OSM's vaguest tag, so first-match order has to leave it last or it
   * shadows every specific type tagged alongside it — a museum with an `attraction` tag would
   * classify as a generic landmark. The header mandates it; this is what enforces it.
   */
  it("keeps tourism=attraction dead last so nothing specific is shadowed", () => {
    const last = OSM_TAG_MAP[OSM_TAG_MAP.length - 1];
    expect(`${last?.key}=${last?.value}`).toBe("tourism=attraction");
  });

  /** No two entries may claim the same key/value pair — the loser would be unreachable. */
  it("maps each key/value pair exactly once", () => {
    const pairs = OSM_TAG_MAP.map((e) => `${e.key}=${e.value}`);
    expect(pairs).toHaveLength(new Set(pairs).size);
  });

  /**
   * The vocabulary is derived, so it can't advertise a slug no entry produces — but it can go stale
   * in the other direction if `buildVocabulary` ever stops walking the whole map.
   */
  it("publishes every slug the map emits, and only those", () => {
    const published = new Set(
      PLACE_VOCABULARY.flatMap((v) => v.subcategories.map((s) => `${v.category}/${s}`)),
    );
    const emitted = new Set(OSM_TAG_MAP.map((e) => `${e.category}/${subcategoryOf(e)}`));
    expect(published).toEqual(emitted);
  });
});
