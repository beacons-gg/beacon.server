import { describe, expect, it } from "vitest";
import { candidateSourceIds, sourceIdFor } from "../source-id";

/**
 * `apps/atlas/doc/spec/place-identity.md` §6 step 1, tested directly — because getting it wrong is
 * silent. A derivation that spells an id differently from the one a server already holds produces a
 * key that matches nothing, which reads exactly like "this place is new" and duplicates it, with no
 * error anywhere.
 */

const ATLAS_ID = "01K9Q7M4ZB8X2VNR5T0P0WR3AC";
/** The consumer's own host — required, so a forgotten one is a compile error rather than a duplicate. */
const SELF_HOST = "beacon.example";

describe("sourceIdFor", () => {
  /**
   * The whole reason this function exists. A Beacon server that snapshotted OSM directly holds
   * `way/586464226`; the builder's vocabulary spells the same element `osm:w/586464226`. Emitting the
   * builder's form would never match, and every place on such a server would double.
   */
  it("renders an OSM id in the server's convention, not the builder's", () => {
    expect(sourceIdFor(["osm:w/586464226"], ATLAS_ID, SELF_HOST)).toBe("way/586464226");
    expect(sourceIdFor(["osm:n/12755225609"], ATLAS_ID, SELF_HOST)).toBe("node/12755225609");
    expect(sourceIdFor(["osm:r/1234"], ATLAS_ID, SELF_HOST)).toBe("relation/1234");
  });

  it("keeps the namespace prefix on everything else, which cannot collide with the OSM form", () => {
    expect(sourceIdFor(["wd:Q2680081"], ATLAS_ID, SELF_HOST)).toBe("wd:Q2680081");
    expect(sourceIdFor(["nrhp:77001360"], ATLAS_ID, SELF_HOST)).toBe("nrhp:77001360");
    expect(sourceIdFor(["gnis:1531329"], ATLAS_ID, SELF_HOST)).toBe("gnis:1531329");
  });

  /**
   * A **fixed** order, not a preference either side expresses locally — that is what makes two volumes
   * describing one place derive the same key independently.
   */
  it("prefers OSM, then wd, then nrhp, then gnis, regardless of the order they are listed in", () => {
    const all = ["gnis:1531329", "nrhp:77001360", "wd:Q2680081", "osm:w/586464226"];
    expect(sourceIdFor(all, ATLAS_ID, SELF_HOST)).toBe("way/586464226");
    expect(sourceIdFor(all.slice(0, 3), ATLAS_ID, SELF_HOST)).toBe("wd:Q2680081");
    expect(sourceIdFor(all.slice(0, 2), ATLAS_ID, SELF_HOST)).toBe("nrhp:77001360");
    expect(sourceIdFor(all.slice(0, 1), ATLAS_ID, SELF_HOST)).toBe("gnis:1531329");
    // Shuffled — same answer, because the priority is over namespaces and not over the array.
    expect(sourceIdFor([...all].reverse(), ATLAS_ID, SELF_HOST)).toBe("way/586464226");
  });

  /** A place only Atlas knows about is keyed by Atlas, whose ids never move (`apps/atlas/doc/spec/place-identity.md` §5). */
  it("falls back to the Atlas id when nothing upstream can name the place", () => {
    expect(sourceIdFor([], ATLAS_ID, SELF_HOST)).toBe(ATLAS_ID);
    // A Commons category is carried but never establishes identity, so it must not become the key.
    expect(sourceIdFor(["commons:Category:Mukilteo Light"], ATLAS_ID, SELF_HOST)).toBe(ATLAS_ID);
  });

  it("ignores a malformed id of a known namespace rather than passing it through", () => {
    expect(sourceIdFor(["osm:x/1"], ATLAS_ID, SELF_HOST)).toBe(ATLAS_ID);
    expect(sourceIdFor(["osm:w/notanumber"], ATLAS_ID, SELF_HOST)).toBe(ATLAS_ID);
  });
});

describe("candidateSourceIds", () => {
  /**
   * An alias is a **former Atlas id**, and a place with no upstream id is keyed by its Atlas id — so an
   * alias is looked up as a `sourceId` through the same query rather than a second mechanism. That is what
   * turns an upstream merge into a field update instead of a retire-plus-create that would take an
   * operator's edits with it.
   */
  it("offers the derived id first, then the place's former ids", () => {
    expect(
      candidateSourceIds(["osm:w/586464226"], ATLAS_ID, ["01OLD1", "01OLD2"], SELF_HOST),
    ).toEqual(["way/586464226", "01OLD1", "01OLD2"]);
  });

  it("dedupes, so an alias equal to the derived id is not a second wasted query per place", () => {
    expect(candidateSourceIds([], ATLAS_ID, [ATLAS_ID, "01OLD"], SELF_HOST)).toEqual([
      ATLAS_ID,
      "01OLD",
    ]);
  });

  it("is just the derived id when there are no aliases", () => {
    expect(candidateSourceIds(["wd:Q1"], ATLAS_ID, [], SELF_HOST)).toEqual(["wd:Q1"]);
  });
});

describe("contrib ids — a server recognising its own contribution coming home", () => {
  const HOST = SELF_HOST;
  const UNIQUE = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
  const MINE = `contrib:${HOST}/${UNIQUE}`;

  /**
   * Without this the round trip duplicates: the volume republishes the contribution under a fresh
   * Atlas id, the originating server finds no local record under it, and creates a second copy of a
   * place it already holds — alongside the operator edits and player contributions keyed to the
   * original (`apps/atlas/doc/spec/place-identity.md` §7).
   */
  it("resolves to the local place unique, for this host only", () => {
    expect(sourceIdFor([MINE], ATLAS_ID, HOST)).toBe(UNIQUE);
    // Another server's contribution names an id space we do not share, so it must NOT resolve —
    // a ULID minted elsewhere could collide with a local place that has nothing to do with it.
    expect(sourceIdFor([MINE], ATLAS_ID, "other.example")).toBe(ATLAS_ID);
  });

  it("outranks osm, because the local record was created under the contribution's key", () => {
    expect(sourceIdFor([MINE, "osm:w/586464226"], ATLAS_ID, HOST)).toBe(UNIQUE);
    expect(sourceIdFor([MINE, "osm:w/586464226"], ATLAS_ID, "other.example")).toBe("way/586464226");
  });

  it("refuses a malformed contrib id rather than inventing a key from it", () => {
    expect(sourceIdFor([`contrib:${HOST}/not-a-ulid`], ATLAS_ID, HOST)).toBe(ATLAS_ID);
    expect(sourceIdFor([`contrib:${UNIQUE}`], ATLAS_ID, HOST)).toBe(ATLAS_ID);
  });

  it("tries the local key first, then the place's former ids", () => {
    expect(candidateSourceIds([MINE], ATLAS_ID, ["01OLDOLDOLDOLDOLDOLDOLDOLD"], HOST)).toEqual([
      UNIQUE,
      "01OLDOLDOLDOLDOLDOLDOLDOLD",
    ]);
  });
});
