import { describe, expect, it } from "vitest";
import {
  canEstablishIdentity,
  namespaceOf,
  needsEvidence,
  UPSTREAM_NAMESPACES,
  upstreamId,
  upstreamValue,
} from "../upstream";

/**
 * The vocabulary's whole job is that its two questions — "is this a well-formed id" and "may
 * identity be established with it" — never disagree. `apps/atlas/doc/spec/place-identity.md` §1: a
 * guessed id is worse than a missing one, because it will match something.
 */
describe("the namespace table", () => {
  /**
   * The invariant that caught a real trap. `nps` was once listed as a merge key with no pattern, which
   * read as "the day an NPS source lands its ids join up" and was unreachable: the sanctioned builder
   * refuses a namespace whose form it does not know, so an `nps:` id would have been silently carried
   * instead of merged on. A promise nothing can keep is worse than an absence.
   */
  it("gives every namespace both halves — a form and a policy", () => {
    for (const [name, namespace] of Object.entries(UPSTREAM_NAMESPACES)) {
      // A `test`-shaped thing, not necessarily a RegExp: `contrib`'s form is owned by
      // `@beaconsgg/place-taxonomy` and borrowed here rather than restated as a fourth copy.
      expect(typeof namespace.pattern.test, `${name} has no form`).toBe("function");
      // And it has to actually refuse something — a form that accepts everything is no form.
      expect(namespace.pattern.test("\u0000 not an id"), `${name}'s form accepts anything`).toBe(
        false,
      );
      expect(typeof namespace.mergeKey, `${name} has no merge policy`).toBe("boolean");
    }
  });

  it("only asks for evidence about namespaces that can establish identity", () => {
    for (const [name, namespace] of Object.entries(UPSTREAM_NAMESPACES)) {
      if (namespace.needsEvidence) {
        expect(namespace.mergeKey, `${name} needs evidence but can never merge`).toBe(true);
      }
    }
  });
});

describe("upstreamId — never invents", () => {
  it("builds each namespace's form", () => {
    expect(upstreamId("osm", "w/586464226")).toBe("osm:w/586464226");
    expect(upstreamId("wd", "Q2680081")).toBe("wd:Q2680081");
    expect(upstreamId("nrhp", "77001360")).toBe("nrhp:77001360");
    expect(upstreamId("gnis", "1512923")).toBe("gnis:1512923");
    expect(upstreamId("commons", "Category:Mukilteo Light")).toBe(
      "commons:Category:Mukilteo Light",
    );
  });

  /** The real us-west cases: six rows put a URL in `ref:nrhp`, and OSM lists are `;`-separated. */
  it("refuses a value that is not a well-formed member of its namespace", () => {
    expect(upstreamId("nrhp", "https://catalog.archives.gov/id/75613230")).toBeUndefined();
    expect(upstreamId("nrhp", "7700136")).toBeUndefined(); // seven digits, not eight
    expect(upstreamId("wd", "P625")).toBeUndefined();
    expect(upstreamId("wd", "Q12; Q13")).toBeUndefined();
    expect(upstreamId("osm", "way/1")).toBeUndefined(); // the `sourceId` form, not the namespaced one
    expect(upstreamId("commons", "File:X.jpg")).toBeUndefined();
  });

  it("trims but never reshapes — two spellings of one id stay two ids", () => {
    expect(upstreamId("gnis", "  1512923 ")).toBe("gnis:1512923");
    // Deliberately NOT normalized to `1512923`: making unequal things equal is a judgement a namespace
    // rule should state out loud, not a normalizer's side effect.
    expect(upstreamId("gnis", "01512923")).toBe("gnis:01512923");
  });
});

describe("canEstablishIdentity", () => {
  /**
   * The form check is the point. Ids arrive read back out of `source_records`, not only freshly built, so
   * testing the prefix alone would trust `wd:not-a-qid` — the failure this module exists to prevent,
   * arriving through the door it had left unlocked.
   */
  it("checks the form, not just the prefix", () => {
    expect(canEstablishIdentity("wd:Q2680081")).toBe(true);
    expect(canEstablishIdentity("wd:not-a-qid")).toBe(false);
    expect(canEstablishIdentity("nrhp:https://example.org/x")).toBe(false);
  });

  /** A Commons category is a set of photos, never an identity claim (`apps/atlas/doc/spec/place-identity.md` §3 tier 1). */
  it("refuses a namespace that is carried but never merged on", () => {
    expect(canEstablishIdentity("commons:Category:Churches in Seattle")).toBe(false);
  });

  it("refuses an unknown namespace and an unprefixed string", () => {
    expect(canEstablishIdentity("nps:olym")).toBe(false);
    expect(canEstablishIdentity("Q2680081")).toBe(false);
  });
});

describe("the prefix, known in one place", () => {
  it("round-trips a namespaced id", () => {
    expect(upstreamValue("wd:Q2680081")).toBe("Q2680081");
    expect(upstreamValue("commons:Category:A:B")).toBe("Category:A:B");
    expect(namespaceOf("osm:w/1")).toBe("osm");
    expect(namespaceOf("unprefixed")).toBe("");
  });

  it("knows which namespaces something must vouch for", () => {
    expect(needsEvidence("wd:Q1")).toBe(true);
    expect(needsEvidence("osm:w/1")).toBe(false);
    expect(needsEvidence("gnis:5")).toBe(false);
  });
});
