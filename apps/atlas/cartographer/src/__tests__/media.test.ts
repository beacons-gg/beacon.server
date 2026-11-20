import { describe, expect, it } from "vitest";
import { commonsKey, resolveRef, type ResolveIndexes, type SkipReason } from "../media";
import type { MediaRef } from "../store";

/**
 * Stage 4's decisions, tested without a network or a database.
 *
 * The property under test throughout is the one the stage exists for: **a failure to learn something is
 * never recorded as knowledge**. Every case below is a way that could go wrong quietly.
 */

const ref = (kind: MediaRef["kind"], value: string, claimedBy = "osm"): MediaRef => ({
  kind,
  value,
  claimedBy,
});

const resolve = (
  r: MediaRef,
  indexes: Partial<ResolveIndexes> = {},
): ReturnType<typeof resolveRef> =>
  resolveRef(r, { p18: new Map(), categoryLeads: new Map(), logos: new Map(), ...indexes });

const skipped = (r: ReturnType<typeof resolveRef>): SkipReason | undefined =>
  r.kind === "skipped" ? r.why : undefined;

describe("resolveRef — a reference becomes a file, or a counted reason", () => {
  it("takes a Commons title as itself, canonicalized", () => {
    expect(resolve(ref("commons-file", "File:A_b.jpg"))).toEqual({
      kind: "file",
      fileKey: "commons:File:A b.jpg",
      title: "File:A b.jpg",
      rank: 4, // behind the agency shots and a player's own photo — the mapper's file leads the Commons tiers
    });
  });

  /**
   * The distinction the concordance's negative cache exists to make, now load-bearing here too. On us-west
   * `media_refs` names 29,094 QIDs while the concordance holds 28,877 — because `brand:wikidata` is a media
   * reference but not an upstream id, so those 217 were never asked about. Reading a missing row as "no
   * photo" would write off exactly the chain logos that the thinnest categories depend on.
   */
  it("separates a QID never asked about from one answered for with no image", () => {
    const asked = new Map<string, string | undefined>([
      ["Q1", "Pic.jpg"],
      ["Q2", undefined],
    ]);
    expect(resolve(ref("wikidata", "Q1"), { p18: asked })).toMatchObject({
      fileKey: "commons:File:Pic.jpg",
    });
    expect(skipped(resolve(ref("wikidata", "Q2"), { p18: asked }))).toBe("noP18");
    expect(skipped(resolve(ref("wikidata", "Q3"), { p18: asked }))).toBe("notAsked");
  });

  it("accepts an image URL only when it names a Commons file", () => {
    const wikimedia = "https://upload.wikimedia.org/wikipedia/commons/a/ab/Pier.jpg";
    expect(resolve(ref("url", wikimedia))).toMatchObject({
      fileKey: "commons:File:Pier.jpg",
    });
    // 594 of this dataset's 1,354 `image=` URLs are one uploader's own host, which states no
    // licence anywhere. `apps/atlas/doc/spec/sources.md` §3 requires a per-file verifiable licence,
    // so it is refused with a reason — not stored as a maybe.
    expect(skipped(resolve(ref("url", "https://alpr.pictures/x.jpg")))).toBe("foreignHost");
  });

  /**
   * The one URL claimer that is not foreign: the NPS stager's, whose corpus-level public-domain
   * terms are what a per-file licence lookup provides for Commons — verified at staging, not here.
   * It routes to its own key namespace and heads the whole chain (`apps/atlas/doc/spec/sources.md`
   * §5's first entry).
   */
  it("routes an NPS-claimed URL to the nps namespace, at the head of the ranking", () => {
    const url = "https://www.nps.gov/common/uploads/olym.jpg";
    expect(resolve(ref("url", url, "nps"))).toEqual({
      kind: "file",
      fileKey: `nps:${url}`,
      title: url,
      rank: 1,
    });
  });

  /** RIDB rides the same route one tier down — the owner's shot, from an operational photo pool. */
  it("routes an RIDB-claimed URL to the ridb namespace, just below NPS", () => {
    const url = "https://cdn.recreation.gov/public/2020/cougar.jpg";
    expect(resolve(ref("url", url, "ridb"))).toEqual({
      kind: "file",
      fileKey: `ridb:${url}`,
      title: url,
      rank: 2,
    });
  });

  /** The street floor: a KartaView frame routes to its own arm and ranks after everything. */
  it("routes a KartaView-claimed URL to the kartaview namespace, at the very bottom", () => {
    const url = "https://storage1.openstreetcam.org/2016/4/27/proc/2971.jpeg";
    expect(resolve(ref("url", url, "kartaview"))).toEqual({
      kind: "file",
      fileKey: `kartaview:${url}`,
      title: url,
      rank: 11,
    });
  });

  /**
   * The category cache's three states, mirroring the P18 contract one map over: never listed is absent
   * *knowledge* (the commons-geo stage fixes it), listed-with-no-lead is an answer, and a lead resolves
   * like any other Commons file — canonicalized through the same key, so the lookup survives the tag's
   * underscore spelling.
   */
  it("resolves a category through its cached lead, and separates never-listed from no-lead", () => {
    const categories = new Map<string, string | undefined>([
      ["Category:Museum of Death", "File:Entrance.jpg"],
      ["Category:Empty Set", undefined],
    ]);
    expect(
      resolve(ref("commons-category", "Category:Museum_of_Death"), { categoryLeads: categories }),
    ).toEqual({
      kind: "file",
      fileKey: "commons:File:Entrance.jpg",
      title: "File:Entrance.jpg",
      rank: 5, // between the mapper's own file and P18 — a set a human curated, minus the pick we made
    });
    expect(
      skipped(
        resolve(ref("commons-category", "Category:Empty Set"), { categoryLeads: categories }),
      ),
    ).toBe("noLead");
    expect(skipped(resolve(ref("commons-category", "Category:Unlisted")))).toBe("notAsked");
  });

  /**
   * The logo index's three states — the P18 contract again, resolved through P154 and never P18:
   * a brand's P18 is typically the company headquarters, the wrong image for a local branch.
   */
  it("resolves a brand through its cached logo, and separates never-asked from no-logo", () => {
    const logos = new Map<string, string | undefined>([
      ["Q37158", "Starbucks Corporation Logo 2011.svg"],
      ["Q2", undefined],
    ]);
    expect(resolve(ref("brand-wikidata", "Q37158"), { logos })).toEqual({
      kind: "file",
      fileKey: "commons:File:Starbucks Corporation Logo 2011.svg",
      title: "File:Starbucks Corporation Logo 2011.svg",
      rank: 10, // below the containment find, above every street frame
    });
    expect(skipped(resolve(ref("brand-wikidata", "Q2"), { logos }))).toBe("noLogo");
    expect(skipped(resolve(ref("brand-wikidata", "Q3"), { logos }))).toBe("notAsked");
  });

  /**
   * The `apps/atlas/doc/spec/sources.md` §5 tiers that share a `kind`, and the order between them.
   *
   * A mapper's `wikimedia_commons=` tag is a human choosing a photo **of this place**; an article's
   * `pageimage` was chosen to illustrate an *article*. §5 also puts `Wikidata P18` above `Wikipedia lead`
   * explicitly. The category lead rides between the mapper's file (the sharper claim) and P18; the geo
   * stage's containment find ranks after everything a human chose, because it is only geometry agreeing
   * a camera stood inside the place.
   */
  it("ranks mapper's file, category lead, P18, article lead, then a containment find", () => {
    const categories = new Map<string, string | undefined>([["Category:C", "File:Lead.jpg"]]);
    const outcomes = [
      resolve(ref("commons-file", "File:X.jpg", "osm")),
      resolve(ref("commons-category", "Category:C", "osm"), { categoryLeads: categories }),
      resolve(ref("wikidata", "Q1", "osm"), { p18: new Map([["Q1", "Pic.jpg"]]) }),
      resolve(ref("commons-file", "File:X.jpg", "wikipedia")),
      resolve(ref("commons-file", "File:X.jpg", "commons")),
      resolve(ref("brand-wikidata", "Q37158", "osm"), { logos: new Map([["Q37158", "Logo.svg"]]) }),
      resolve(ref("url", "https://storage1.openstreetcam.org/x.jpg", "kartaview")),
    ];
    const ranks = outcomes.map((out) => (out.kind === "file" ? out.rank : Number.MAX_SAFE_INTEGER));
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
    expect(new Set(ranks).size).toBe(ranks.length);
  });

  it("refuses a source with no place in the ranking rather than publishing it unranked", () => {
    expect(skipped(resolve(ref("commons-file", "File:X.jpg", "someone-else")))).toBe(
      "unrankedSource",
    );
  });

  /** Two references naming one photo must produce one key, or the file is fetched and published twice. */
  it("collapses a P18 and a tag that name the same file onto one key", () => {
    const viaTag = resolve(ref("commons-file", "File:Same.jpg"));
    const viaQid = resolve(ref("wikidata", "Q9"), {
      p18: new Map<string, string | undefined>([["Q9", "Same.jpg"]]),
    });
    expect(viaTag.kind === "file" && viaQid.kind === "file").toBe(true);
    if (viaTag.kind !== "file" || viaQid.kind !== "file") return;
    expect(viaQid.fileKey).toBe(viaTag.fileKey);
  });

  it("namespaces a key by its source, so no source can collide with Commons' titles", () => {
    expect(commonsKey("File:A.jpg")).toBe("commons:File:A.jpg");
  });
});
