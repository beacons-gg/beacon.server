import { describe, expect, it } from "vitest";
import {
  aboveFloor,
  parseVersions,
  releaseInWindow,
  SKEW_FLOOR,
  skewEdges,
  skewMatrix,
} from "../edges";

const versions = (edges: { version: string }[]) => edges.map((e) => e.version);

describe("skewEdges", () => {
  it("is the latest candidate alone while the first major has no stable release", () => {
    expect(skewEdges(["0.0.0-spike.1", "1.0.0-rc.1"])).toEqual([
      { version: "1.0.0-rc.1", why: "the latest release candidate of 1.0.0" },
    ]);
    // An older candidate is not in the window: candidates may break each other until 1.0.0.
    expect(versions(skewEdges(["1.0.0-rc.1", "1.0.0-rc.2", "1.0.0-rc.10"]))).toEqual([
      "1.0.0-rc.10",
    ]);
  });

  it("never takes a canary or a spike for a release", () => {
    expect(skewEdges(["0.0.0-canary.b5311af.1", "0.0.0-spike.1"])).toEqual([]);
    expect(skewEdges([])).toEqual([]);
  });

  it("is the oldest minor's latest patch and the latest release once the major is stable", () => {
    expect(
      skewEdges(["1.0.0-rc.3", "1.0.0", "1.0.1", "1.1.0", "1.2.0", "1.2.3", "1.3.0-rc.1"]),
    ).toEqual([
      { version: "1.0.1", why: "the oldest minor of 1.x" },
      { version: "1.2.3", why: "the latest 1.x" },
    ]);
  });

  it("is one edge with both reasons when the major has one stable release", () => {
    expect(skewEdges(["1.0.0-rc.9", "1.0.0"])).toEqual([
      { version: "1.0.0", why: "the oldest minor of 1.x, and the latest 1.x" },
    ]);
  });

  it("adds both ends of the previous major, and only its stable releases", () => {
    // §6 is one major apart "at any minor": the oldest 1.x app still installed is in the window.
    expect(skewEdges(["1.0.0", "1.0.3", "1.4.2", "1.5.0-rc.1", "2.0.0", "2.1.0"])).toEqual([
      { version: "1.0.3", why: "the oldest minor of 1.x" },
      { version: "1.4.2", why: "the latest 1.x" },
      { version: "2.0.0", why: "the oldest minor of 2.x" },
      { version: "2.1.0", why: "the latest 2.x" },
    ]);
  });

  it("keeps both ends of the stable major when the next major's first candidate is published", () => {
    // Every server and app in the field is still on 1.x: one 2.0.0-rc.1 must not drop 1.0.
    const stable = ["1.0.0", "1.0.1", "1.1.0", "1.4.2"];
    expect(versions(skewEdges(stable))).toEqual(["1.0.1", "1.4.2"]);
    expect(skewEdges([...stable, "2.0.0-rc.1", "2.0.0-rc.2"])).toEqual([
      { version: "1.0.1", why: "the oldest minor of 1.x" },
      { version: "1.4.2", why: "the latest 1.x" },
      { version: "2.0.0-rc.2", why: "the latest release candidate of 2.0.0" },
    ]);
  });

  it("is one edge for a previous major with a single stable release", () => {
    expect(skewEdges(["1.0.0", "2.0.0-rc.1"])).toEqual([
      { version: "1.0.0", why: "the oldest minor of 1.x, and the latest 1.x" },
      { version: "2.0.0-rc.1", why: "the latest release candidate of 2.0.0" },
    ]);
  });

  it("does not reach two majors back", () => {
    expect(versions(skewEdges(["1.0.0", "2.0.0", "3.0.0"]))).toEqual(["2.0.0", "3.0.0"]);
  });

  it("does not depend on the order the registry lists versions in", () => {
    expect(versions(skewEdges(["1.2.0", "1.0.0", "1.10.0", "1.9.0"]))).toEqual(["1.0.0", "1.10.0"]);
  });
});

describe("aboveFloor", () => {
  it("drops every version below the floor", () => {
    const published = ["0.0.0-spike.1", "0.2.0", "0.2.5", "0.3.0-0", SKEW_FLOOR];
    expect(aboveFloor(published)).toEqual([SKEW_FLOOR]);
  });

  it("keeps what comes after the floor, candidates of a later line included", () => {
    expect(aboveFloor(["0.3.0-rc.2", "0.3.0", "0.3.4", "1.0.0-rc.2"])).toEqual([
      "0.3.0-rc.2",
      "0.3.0",
      "0.3.4",
      "1.0.0-rc.2",
    ]);
  });

  it("takes the latest candidate as the one edge until 0.3.0 is published", () => {
    expect(versions(skewEdges(aboveFloor(["0.3.0-rc.1", "0.3.0-rc.2"])))).toEqual(["0.3.0-rc.2"]);
  });

  it("leaves nothing while the floor is unpublished, which empties only the old-client column", () => {
    expect(skewEdges(aboveFloor(["0.2.5"]))).toEqual([]);
  });
});

describe("releaseInWindow", () => {
  it("takes a server release built on a core at or above the floor", () => {
    expect(releaseInWindow("^0.3.0-rc.1")).toBe(true);
    expect(releaseInWindow("^0.3.2")).toBe(true);
  });

  it("drops one built on an older core, or on none under the scope", () => {
    expect(releaseInWindow("^0.2.5")).toBe(false);
    expect(releaseInWindow("")).toBe(false);
    expect(releaseInWindow("not a range")).toBe(false);
  });
});

describe("parseVersions", () => {
  it("reads an array, and the bare string npm answers for a single version", () => {
    expect(parseVersions('["1.0.0-rc.1","1.0.0-rc.2"]')).toEqual(["1.0.0-rc.1", "1.0.0-rc.2"]);
    expect(parseVersions('"1.0.0-rc.1"')).toEqual(["1.0.0-rc.1"]);
  });

  it("refuses anything else", () => {
    expect(() => parseVersions('{"error":{"code":"E401"}}')).toThrow(/array of version strings/);
    expect(() => parseVersions("[1, 2]")).toThrow(/array of version strings/);
  });
});

describe("skewMatrix", () => {
  const edges = [
    { version: "1.0.1", why: "the oldest minor of 1.x" },
    { version: "1.2.3", why: "the latest 1.x" },
  ];

  it("is every core edge as the old client, and every server release as the old server", () => {
    expect(skewMatrix(edges, [{ version: "v0.3.0", why: "the latest server release" }])).toEqual({
      include: [
        { version: "1.0.1", why: "the oldest minor of 1.x", direction: "old-client" },
        { version: "1.2.3", why: "the latest 1.x", direction: "old-client" },
        { version: "v0.3.0", why: "the latest server release", direction: "old-server" },
      ],
    });
  });

  it("has no old-server cell before the first server release, and still every old-client one", () => {
    expect(skewMatrix(edges).include.map((cell) => cell.direction)).toEqual([
      "old-client",
      "old-client",
    ]);
  });
});
