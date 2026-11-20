import { MAX_PLACE_MEDIA, MAX_RING_POSITIONS } from "@beaconsgg/protocol-types";
import { describe, expect, it } from "vitest";
import type { PublishablePlace, PublishedMedia } from "../store";
import {
  CELL_PRECISION,
  latestJson,
  VOLUME_FORMAT,
  type CellSummary,
} from "@beaconsgg/atlas-volume";
import {
  dictJson,
  geometryFor,
  indexJson,
  manifestBody,
  newBuildState,
  round,
  tileRecord,
  type BuildState,
  type EntityRefs,
} from "../volume";

/**
 * The format, tested directly — and this is the file that carries the weight, because
 * `apps/atlas/doc/spec/volume-format.md` §10 makes a published version's bytes immutable forever. A
 * field clamped wrongly, a dictionary index off by one, or a coordinate at the wrong precision
 * cannot be corrected in place; it can only be superseded by a whole new version.
 */

const REFS: EntityRefs = { upstream: ["osm:w/586464226", "wd:Q2680081"], aliases: [] };

const place = (over: Partial<PublishablePlace> = {}): PublishablePlace => ({
  entityId: "01K9Q7M4ZB8X2VNR5T0P0WR3AC",
  cell: "c22zn",
  fields: { category: "landmark", name: "Mukilteo Lighthouse" },
  sources: ["osm"],
  point: '{"type":"Point","coordinates":[-122.3047412,47.9476633]}',
  ...over,
});

const build = (): BuildState => newBuildState();

describe("coordinates", () => {
  it("rounds to 5 decimals — ~1 m, where the connector's 7 is payload nobody can act on", () => {
    const record = tileRecord(build(), place(), REFS);
    expect(record.point).toEqual([-122.30474, 47.94766]);
  });

  /** `-0` and `0` are different bytes and the same place; two runs must not disagree about which. */
  it("normalises negative zero, so the same input canonicalizes the same way twice", () => {
    expect(round(-0.0000001)).toBe(0);
    expect(Object.is(round(-0.0000001), -0)).toBe(false);
  });
});

describe("interning", () => {
  it("assigns one index per distinct value and reuses it", () => {
    const state = build();
    const a = tileRecord(state, place(), REFS);
    const b = tileRecord(state, place({ entityId: "B", fields: { category: "landmark" } }), REFS);
    const c = tileRecord(state, place({ entityId: "C", fields: { category: "park" } }), REFS);
    expect(a.category).toBe(b.category);
    expect(c.category).not.toBe(a.category);
    expect(dictJson(state.dict).categories).toEqual(["landmark", "park"]);
  });

  /** Interning by canonical JSON, so a credit that differs only in key order is one dictionary entry. */
  it("treats two credits differing only in key order as the same credit", () => {
    const state = build();
    tileRecord(
      state,
      place({
        fields: {
          category: "landmark",
          description: "d",
          descriptionCredit: { license: "CC BY-SA 4.0", author: "Wikipedia contributors" },
        },
      }),
      REFS,
    );
    tileRecord(
      state,
      place({
        entityId: "B",
        fields: {
          category: "landmark",
          description: "d",
          descriptionCredit: { author: "Wikipedia contributors", license: "CC BY-SA 4.0" },
        },
      }),
      REFS,
    );
    expect(dictJson(state.dict).credits).toHaveLength(1);
  });

  /**
   * The one thing this module refuses outright. A published field whose licence nobody declared cannot
   * be fixed later — the bytes are immutable — so an undeclared source has to stop the build rather than
   * ship a place with no attribution.
   */
  it("refuses to publish a source with no declared redistribution terms", () => {
    expect(() => tileRecord(build(), place({ sources: ["mystery-corpus"] }), REFS)).toThrow(
      /has no redistribution terms/,
    );
  });
});

describe("wire caps", () => {
  it("truncates an over-long description and counts it", () => {
    const state = build();
    const record = tileRecord(
      state,
      place({ fields: { category: "landmark", description: "x".repeat(900) } }),
      REFS,
    );
    expect(record.description).toHaveLength(500);
    expect(state.clamps.description).toBe(1);
  });

  /**
   * Dropped, not truncated, and the distinction is the point: a shortened URL is not a shorter answer,
   * it is a wrong one. Same rule `enwikiArticleUrl` already applies upstream.
   */
  it("drops an over-long URL rather than truncating it", () => {
    const state = build();
    const long = `https://example.org/${"p".repeat(320)}`;
    const record = tileRecord(
      state,
      place({ fields: { category: "landmark", website: long } }),
      REFS,
    );
    expect(record.website).toBeUndefined();
    expect(state.clamps.website).toBe(1);
  });

  it("caps altNames at 8 and counts the place, not the names", () => {
    const state = build();
    const record = tileRecord(
      state,
      place({
        fields: { category: "landmark", altNames: Array.from({ length: 12 }, (_, i) => `n${i}`) },
      }),
      REFS,
    );
    expect(record.altNames).toHaveLength(8);
    expect(state.clamps.altNames).toBe(1);
  });

  it("counts nothing when nothing needed shortening", () => {
    const state = build();
    tileRecord(state, place(), REFS);
    expect(state.clamps).toEqual({
      description: 0,
      name: 0,
      altNames: 0,
      website: 0,
      wikipedia: 0,
      geometry: 0,
      media: 0,
    });
  });
});

describe("a credit never outlives its description", () => {
  /**
   * `fields.ts` stops a credit being paired with another source's words. This is the same rule from the
   * other end: if the description is gone, the credit must go too, or the volume attributes text that
   * isn't there.
   */
  it("omits the credit when there is no description to credit", () => {
    const state = build();
    const record = tileRecord(
      state,
      place({
        fields: { category: "landmark", descriptionCredit: { license: "CC BY-SA 4.0" } },
      }),
      REFS,
    );
    expect(record.description).toBeUndefined();
    expect(record.descriptionCredit).toBeUndefined();
  });
});

describe("geometry", () => {
  const ring = (n: number): [number, number][] => {
    const positions: [number, number][] = Array.from({ length: n - 1 }, (_, i) => [
      -122.3 + i / 100000,
      47.9,
    ]);
    return [...positions, positions[0] as [number, number]];
  };
  const polygon = (n: number): string =>
    JSON.stringify({ type: "Polygon", coordinates: [ring(n)] });

  it("rounds a polygon's positions to the published precision", () => {
    const state = build();
    const shape = geometryFor(state, place({ geometry: polygon(5) }));
    expect(shape?.type).toBe("Polygon");
    const first = shape?.type === "Polygon" ? shape.coordinates[0]?.[0] : undefined;
    expect(first?.[0]).toBe(-122.3);
  });

  /**
   * Dropped rather than simplified: a boundary we thinned is a shape no source asserted, and
   * geometry ranks below every other field (`apps/atlas/doc/spec/volume-format.md` §5), so a place
   * without one is still complete.
   */
  it("drops a ring over the wire's cap and counts it", () => {
    const state = build();
    expect(
      geometryFor(state, place({ geometry: polygon(MAX_RING_POSITIONS + 2) })),
    ).toBeUndefined();
    expect(state.clamps.geometry).toBe(1);
  });

  it("drops a geometry type the wire does not carry", () => {
    const state = build();
    const line = JSON.stringify({
      type: "LineString",
      coordinates: [
        [0, 0],
        [1, 1],
      ],
    });
    expect(geometryFor(state, place({ geometry: line }))).toBeUndefined();
    expect(state.clamps.geometry).toBe(1);
  });

  it("returns nothing, and counts nothing, for a place that simply has no geometry", () => {
    const state = build();
    expect(geometryFor(state, place())).toBeUndefined();
    expect(state.clamps.geometry).toBe(0);
  });
});

describe("aliases and upstream ids", () => {
  it("sorts both, so a rebuild that reordered them produces identical bytes", () => {
    const record = tileRecord(build(), place(), {
      upstream: ["wd:Q2680081", "osm:w/586464226"],
      aliases: ["01B", "01A"],
    });
    expect(record.upstream).toEqual(["osm:w/586464226", "wd:Q2680081"]);
    expect(record.aliases).toEqual(["01A", "01B"]);
  });

  it("omits `aliases` entirely when there are none, rather than emitting an empty array", () => {
    // `canonicalJson` drops undefined keys; an empty array would be a key every place carries for nothing.
    expect(tileRecord(build(), place(), REFS).aliases).toBeUndefined();
  });
});

describe("the manifest", () => {
  const summaries: CellSummary[] = [
    { cell: "c22zn", places: 2, hash: "sha256:aa", bytes: 100 },
    { cell: "c23aa", places: 1, hash: "sha256:bb", bytes: 50 },
    { cell: "9r1bc", places: 1, hash: "sha256:cc", bytes: 40 },
  ];

  const body = (state: BuildState) =>
    manifestBody(state, summaries, {
      volume: "us-west",
      version: "2026-08",
      revision: 412,
      createdAt: "2026-08-06T00:00:00.000Z",
      publisher: "did:key:z6Mk",
      index: { path: "index.json", hash: "sha256:ii", bytes: 10 },
      dict: { path: "dict.json", hash: "sha256:dd", bytes: 20 },
      mediaBase: "../media/",
      inputs: [{ source: "osm", artifact: "us-west.osm.pbf", hash: "sha256:pp" }],
      thumbPx: 256,
      fullPx: 1024,
      mediaCount: 0,
      mediaBytes: 0,
      retired: [],
    });

  it("accumulates bounds from the points it was given", () => {
    const state = build();
    tileRecord(state, place(), REFS);
    tileRecord(
      state,
      place({ entityId: "B", point: '{"type":"Point","coordinates":[-120.5,49.1]}' }),
      REFS,
    );
    expect(body(state).bounds).toEqual({
      minLat: 47.94766,
      minLng: -122.30474,
      maxLat: 49.1,
      maxLng: -120.5,
    });
  });

  it("summarises coverage as sorted distinct cell prefixes", () => {
    expect(body(build()).coverage).toEqual(["9r", "c2"]);
  });

  /**
   * An early draft of the format showed `"aspect": "16:9"`, which belongs to a game's item media.
   * Place images are resized fit-inside a single max dimension with no crop, so advertising an
   * aspect would be a contract no consumer honours.
   */
  it("advertises a media profile with no aspect", () => {
    expect(body(build()).mediaProfile).toEqual({
      thumbPx: 256,
      fullPx: 1024,
      format: "image/webp",
    });
  });

  it("declares a licence for every source that contributed", () => {
    const state = build();
    tileRecord(state, place(), REFS);
    expect(body(state).licenses).toEqual([
      {
        id: "osm",
        name: "OpenStreetMap",
        license: "ODbL 1.0",
        licenseUrl: "https://opendatacommons.org/licenses/odbl/1-0/",
      },
    ]);
  });

  it("carries the format lever and the grid the tiles were cut on", () => {
    const manifest = body(build());
    expect(manifest.format).toBe(VOLUME_FORMAT);
    expect(manifest.cellPrecision).toBe(CELL_PRECISION);
    // No media until stage 4 — stated as zero rather than omitted, so a consumer reads a fact.
    expect(manifest.media).toEqual({ base: "../media/", count: 0, bytes: 0 });
  });
});

describe("index.json and latest.json", () => {
  it("sorts cells, so the index is stable regardless of the order they were written", () => {
    const index = indexJson([
      { cell: "c9", places: 1, hash: "sha256:a", bytes: 1 },
      { cell: "c1", places: 1, hash: "sha256:b", bytes: 1 },
    ]);
    expect(index.cells.map((c) => c.cell)).toEqual(["c1", "c9"]);
    expect(index.cellPrecision).toBe(CELL_PRECISION);
  });

  it("points at a version and carries nothing else", () => {
    expect(latestJson("2026-08")).toEqual({
      version: "2026-08",
      manifest: "2026-08/manifest.json",
    });
  });
});

/**
 * Photos on a tile. Two rules here are positional or indirect rather than structural, so nothing but a test
 * enforces them — and both are contracts a consumer reads at the far end of an immutable file.
 */
describe("media on a tile record", () => {
  const photo = (over: Partial<PublishedMedia> = {}): PublishedMedia => ({
    thumbHash: "sha256:thumb1",
    fullHash: "sha256:full1",
    bytes: 1000,
    license: "CC BY-SA 4.0",
    licenseUrl: "https://creativecommons.org/licenses/by-sa/4.0",
    author: "Someone",
    sourceUrl: "https://commons.wikimedia.org/wiki/File:A.jpg",
    source: "commons",
    ...over,
  });

  it("emits a pair per photo: adjacent, thumb first", () => {
    const record = tileRecord(build(), place({ media: [photo()] }), REFS);
    expect(record.media?.map((m) => m.role)).toEqual(["thumb", "full"]);
    expect(record.media?.[0]?.hash).toBe("sha256:thumb1");
    expect(record.media?.[1]?.hash).toBe("sha256:full1");
  });

  /**
   * `Media` has no group id, so adjacency is the *only* thing joining a pair — at both ends of the wire.
   * Two photos must therefore interleave as thumb,full,thumb,full and never thumb,thumb,full,full.
   */
  it("keeps two photos' pairs adjacent rather than grouping by role", () => {
    const record = tileRecord(
      build(),
      place({
        media: [photo(), photo({ thumbHash: "sha256:thumb2", fullHash: "sha256:full2" })],
      }),
      REFS,
    );
    expect(record.media?.map((m) => m.role)).toEqual(["thumb", "full", "thumb", "full"]);
  });

  it("absent, never empty, for a place with no photos", () => {
    const record = tileRecord(build(), place(), REFS);
    // `media: []` would tell the server "this source supplies media", blanking the place's photos.
    expect(record).not.toHaveProperty("media");
    expect(tileRecord(build(), place({ media: [] }), REFS)).not.toHaveProperty("media");
  });

  /**
   * The licence pair interns; the author and the file's own page do not. Interning per-file values
   * would make `dict.credits` about as long as the media list and save nothing
   * (`apps/atlas/doc/spec/volume-format.md` §7).
   */
  it("interns only the licence pair, keeping per-file credit inline", () => {
    const state = build();
    const record = tileRecord(
      state,
      place({
        media: [photo(), photo({ thumbHash: "sha256:t2", fullHash: "sha256:f2", author: "Other" })],
      }),
      REFS,
    );
    // Same licence twice → one dictionary entry, referenced by index.
    expect(state.dict.credits.values).toEqual([
      { license: "CC BY-SA 4.0", licenseUrl: "https://creativecommons.org/licenses/by-sa/4.0" },
    ]);
    expect(record.media?.map((m) => m.credit)).toEqual([0, 0, 0, 0]);
    expect(record.media?.map((m) => m.author)).toEqual(["Someone", "Someone", "Other", "Other"]);
  });

  /**
   * A photo's source is not derivable from the place's own `sources`: a place OSM describes can
   * carry a Commons photo. `apps/atlas/doc/spec/volume-format.md` §7 needs it to withdraw a
   * source's media later, and a server needs it to tell whether its own street-level shot is an
   * upgrade.
   */
  it("records which source each file came from, even one that won no field", () => {
    const state = build();
    const record = tileRecord(state, place({ sources: ["osm"], media: [photo()] }), REFS);
    const at = record.media?.[0]?.source ?? -1;
    expect(state.dict.sources.values[at]?.id).toBe("commons");
    // And the place still credits only the source that contributed a field.
    expect(record.sources.map((i) => state.dict.sources.values[i]?.id)).toEqual(["osm"]);
  });

  /**
   * Capped by **pair**. Truncating by entry count would publish a `full` with no `thumb`, and the failure
   * would not surface here: the server accepts over-cap media on the connector path, and the refusal lands
   * later at a downstream server's `places.import`, taking a whole 2,000-feature collection with it.
   */
  it("truncates whole pairs at the wire cap, and counts what it dropped", () => {
    const state = build();
    const many = Array.from({ length: 6 }, (_, i) =>
      photo({ thumbHash: `sha256:t${i}`, fullHash: `sha256:f${i}` }),
    );
    const record = tileRecord(state, place({ media: many }), REFS);
    expect(record.media?.length).toBe(MAX_PLACE_MEDIA);
    expect(record.media?.length ?? 0).toBe(((record.media?.length ?? 0) / 2) * 2); // whole pairs
    expect(record.media?.filter((m) => m.role === "thumb").length).toBe(
      record.media?.filter((m) => m.role === "full").length,
    );
    expect(state.clamps.media).toBe(2); // 6 photos offered, 4 fit
  });

  it("omits an absent licence url rather than signing an explicit undefined", () => {
    const state = build();
    const { licenseUrl, ...noUrl } = photo();
    void licenseUrl;
    tileRecord(state, place({ media: [noUrl as PublishedMedia] }), REFS);
    expect(state.dict.credits.values[0]).not.toHaveProperty("licenseUrl");
  });
});
