import { describe, expect, it } from "vitest";
import {
  angleDiff,
  BEARING_TOLERANCE_DEG,
  kartaviewDetailsUrl,
  pickKartaviewRefs,
  stagedFromKartaview,
} from "../kartaview";
import type { KartaviewCandidate, KartaviewHit } from "../store";

const hit = (photoId: number, over: Partial<KartaviewHit> = {}): KartaviewHit => ({
  photoId,
  distM: 20,
  heading: 90,
  toPlace: 90,
  url: `https://storage1.openstreetcam.org/x/${photoId}.jpg`,
  ...over,
});

describe("angleDiff — bearings compare the short way round", () => {
  it("wraps through north", () => {
    expect(angleDiff(350, 10)).toBe(20);
    expect(angleDiff(10, 350)).toBe(20);
    expect(angleDiff(0, 180)).toBe(180);
  });
});

describe("pickKartaviewRefs — the aim gate", () => {
  /**
   * The gate this slice exists for: a dashcam driving *past* a place — heading perpendicular to it —
   * is a photo of the street, however close it stands. The probe's counterexamples (a candy shop's
   * nearest frame showing a transit bus) are exactly this geometry.
   */
  it("drops a frame whose camera points past the place, however near", () => {
    expect(pickKartaviewRefs([hit(1, { distM: 3, heading: 0, toPlace: 90 })])).toEqual([]);
    expect(
      pickKartaviewRefs([hit(2, { heading: 90 - BEARING_TOLERANCE_DEG, toPlace: 90 })]),
    ).toEqual([hit(2).url]);
  });

  /** No recorded heading means the gate cannot run — distance alone is the dashcam trap, not a pick. */
  it("drops a frame with no recorded heading", () => {
    const noHeading: KartaviewHit = { ...hit(1), distM: 2 };
    delete noHeading.heading;
    expect(pickKartaviewRefs([noHeading])).toEqual([]);
  });

  it("prefers the most squarely-aimed frame, then the nearer, and caps at two", () => {
    const picks = pickKartaviewRefs([
      hit(1, { heading: 130, toPlace: 90, distM: 5 }), // 40° off
      hit(2, { heading: 95, toPlace: 90, distM: 30 }), // 5° off — squarest wins despite distance
      hit(3, { heading: 100, toPlace: 90, distM: 10 }), // 10° off
    ]);
    expect(picks).toEqual([hit(2).url, hit(3).url]);
  });
});

describe("stagedFromKartaview — the derived-record template, photos-only", () => {
  const candidate: KartaviewCandidate = {
    source: "osm",
    sourceId: "n/42",
    category: "sweets",
    point: '{"type":"Point","coordinates":[-122.3,47.6]}',
    hits: [hit(7)],
  };

  it("stages one kartaview record naming its parent, point verbatim, refs claimed for rank", () => {
    expect(stagedFromKartaview(candidate)).toMatchObject({
      source: "kartaview",
      sourceId: "n/42",
      category: "sweets",
      point: candidate.point,
      upstreamIds: [],
      derivedFrom: { source: "osm", sourceId: "n/42" },
      mediaRefs: [{ kind: "url", value: hit(7).url, claimedBy: "kartaview" }],
    });
  });

  /** The orphan guard: a record with no gated pick would publish nothing and still join an entity. */
  it("stages nothing when no frame passes the gate", () => {
    expect(
      stagedFromKartaview({ ...candidate, hits: [hit(9, { heading: 0, toPlace: 180 })] }),
    ).toBeUndefined();
  });
});

it("links the human details page a published credit points at", () => {
  expect(kartaviewDetailsUrl(2971, 5)).toBe("https://kartaview.org/details/2971/5");
  expect(kartaviewDetailsUrl(2971)).toBe("https://kartaview.org/details/2971/0");
});
