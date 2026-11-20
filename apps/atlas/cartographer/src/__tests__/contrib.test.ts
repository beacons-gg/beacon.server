import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { stageContrib } from "../contrib";
import type { Querier, StagedRow } from "../store";

/**
 * The contribution source, and specifically **how a contributed record joins**.
 *
 * That is the whole difficulty of the slice and the only part a live run would not obviously show:
 * an improvement staged as an island still publishes — as a second pin next to the place it was
 * meant to improve, carrying half a description. And a record that joined by *restating* its
 * parent's identifiers would also publish, correctly, while quietly making the dataset count its
 * own output as an independent source agreeing with itself (`apps/atlas/doc/spec/place-identity.md`
 * §7). Both failures are invisible downstream, so they are pinned here.
 */

const HOST = "beacon.example";
const U1 = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const U2 = "01BRZ3NDEKTSV4RRFFQ69G5FAV";
const POINT = { lat: 47.61, lng: -122.33 };

interface Captured {
  staged: StagedRow[];
  grants: { url: string; license: string }[];
}

/**
 * A database that answers the parent lookup from a fixed set of known OSM keys and records what was
 * written. Fake rather than real because every assertion here is about the *shape* of what gets
 * staged — a live database would confirm the rows landed, which was never the question.
 */
function fakeDb(knownOsmKeys: readonly string[] = []): { db: Querier; captured: Captured } {
  const captured: Captured = { staged: [], grants: [] };
  const db: Querier = {
    query: (sql: string, params?: unknown[]) => {
      if (sql.includes("FROM source_records WHERE source =")) {
        const asked = (params?.[1] as string[]) ?? [];
        return Promise.resolve({
          rows: asked.filter((k) => knownOsmKeys.includes(k)).map((k) => ({ source_id: k })),
        });
      }
      if (sql.includes("INSERT INTO contrib_media")) {
        captured.grants = JSON.parse(params?.[0] as string) as Captured["grants"];
        return Promise.resolve({ rows: [] });
      }
      if (sql.includes("INSERT INTO source_records")) {
        captured.staged = JSON.parse(params?.[0] as string) as StagedRow[];
        return Promise.resolve({ rows: [] });
      }
      return Promise.resolve({ rows: [] });
    },
  } as unknown as Querier;
  return { db, captured };
}

interface FeatureInput {
  unique: string;
  upstream?: string[];
  description?: string;
  name?: string;
  media?: unknown[];
}

const feature = (input: FeatureInput): unknown => ({
  type: "Feature",
  geometry: { type: "Point", coordinates: [POINT.lng, POINT.lat] },
  properties: {
    unique: input.unique,
    category: "park",
    ...(input.name !== undefined ? { name: input.name } : {}),
    ...(input.description !== undefined ? { description: input.description } : {}),
    point: POINT,
    ...(input.media ? { media: input.media } : {}),
    contrib: {
      id: `${HOST}/${input.unique}`,
      ...(input.upstream ? { upstream: input.upstream } : {}),
      license: "CC0-1.0",
    },
  },
});

const collection = (features: unknown[], profile = "beacon-contrib/1"): unknown => ({
  type: "FeatureCollection",
  beacon: { profile, host: HOST },
  features,
});

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "cartographer-contrib-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function stage(
  payload: unknown,
  knownOsmKeys: readonly string[] = [],
): Promise<{ report: Awaited<ReturnType<typeof stageContrib>>; captured: Captured }> {
  const file = join(dir, "contrib.json");
  await writeFile(file, JSON.stringify(payload), "utf8");
  const { db, captured } = fakeDb(knownOsmKeys);
  const report = await stageContrib(db, {
    file,
    dryRun: false,
    now: () => "2026-08-09T00:00:00.000Z",
    log: () => {},
  });
  return { report, captured };
}

describe("identity — how a contributed record joins", () => {
  it("joins an improvement by naming a record, and asserts no ids of its own", async () => {
    const { report, captured } = await stage(
      collection([feature({ unique: U1, upstream: ["way/586464226"], description: "A park." })]),
      ["way/586464226"],
    );

    expect(report.improvements).toBe(1);
    expect(report.newPlaces).toBe(0);
    const [row] = captured.staged;
    expect(row?.derivedFrom).toEqual({ source: "osm", sourceId: "way/586464226" });
    // The assertion the whole join rests on. Restating the parent's ids would join the right entity
    // and still be wrong: it adds an asserter to the merge gate's span measurement and makes the
    // dataset count its own republished output as a second source agreeing.
    expect(row?.upstreamIds).toEqual([]);
  });

  it("makes a new place its own entity, asserting the contribution id and nothing else", async () => {
    const { report, captured } = await stage(collection([feature({ unique: U2, name: "Bench" })]));

    expect(report.newPlaces).toBe(1);
    const [row] = captured.staged;
    expect(row?.derivedFrom).toBeUndefined();
    // Kept forever: it is what lets the originating server recognise this coming home, and what
    // lets a builder tell an independent agreement from its own last publish.
    expect(row?.upstreamIds).toEqual([`contrib:${HOST}/${U2}`]);
    expect(row?.sourceId).toBe(`${HOST}/${U2}`);
  });

  it("stages an unresolvable improvement as a new place, and says so", async () => {
    // A server whose coverage runs past this build's. Dropping it would lose a real contribution;
    // pretending it joined would be a lie. It becomes its own place, and the count is reported —
    // a wall of these means the export and the extract describe different regions.
    const { report, captured } = await stage(
      collection([feature({ unique: U1, upstream: ["way/999"], description: "A park." })]),
    );
    expect(report.unresolvedParent).toBe(1);
    expect(report.newPlaces).toBe(1);
    expect(captured.staged[0]?.derivedFrom).toBeUndefined();
  });

  it("copies the point verbatim rather than deriving one", async () => {
    // A derived record whose point differs from its parent's inflates the span of every id they
    // share, and a gated id is carried rather than established — which re-mints the place.
    const { captured } = await stage(
      collection([feature({ unique: U1, upstream: ["way/586464226"], description: "A park." })]),
      ["way/586464226"],
    );
    expect(JSON.parse(captured.staged[0]?.point ?? "{}")).toEqual({
      type: "Point",
      coordinates: [POINT.lng, POINT.lat],
    });
  });

  it("collapses a description's whitespace, like every other stager", async () => {
    // A player types into a multi-line box; every other source publishes one line. Without this a
    // contributed description is the only one in a volume carrying paragraph breaks.
    const { captured } = await stage(
      collection([feature({ unique: U2, description: "Two trees.\n\n  And a bench.  " })]),
    );
    expect(captured.staged[0]?.description).toBe("Two trees. And a bench.");
  });

  it("refuses a feature with no contribution id rather than staging it as one", async () => {
    const plain = {
      type: "Feature",
      geometry: { type: "Point", coordinates: [POINT.lng, POINT.lat] },
      properties: { unique: U1, category: "park", point: POINT },
    };
    const { report } = await stage(collection([plain]));
    expect(report.skipped).toBe(1);
    expect(report.improvements + report.newPlaces).toBe(0);
  });

  it("refuses a place list — a beacon-places/1 file is not a contribution export", async () => {
    await expect(stage(collection([], "beacon-places/1"))).rejects.toThrow(/beacon-places\/1/);
  });
});

describe("photos — a grant is what makes one publishable", () => {
  const photo = (over: Record<string, unknown> = {}): unknown => ({
    type: "image",
    role: "full",
    hash: "abc",
    uris: ["abc@beacon.example"],
    credit: { license: "CC0 1.0", author: `did:key:zAlice` },
    ...over,
  });

  it("carries a licensed photo and records its grant for the crawl to gate on offline", async () => {
    const { report, captured } = await stage(
      collection([feature({ unique: U2, media: [photo()] })]),
    );
    expect(report.photos).toBe(1);
    expect(captured.staged[0]?.mediaRefs).toEqual([
      { kind: "url", value: "abc@beacon.example", claimedBy: "contrib" },
    ]);
    expect(captured.grants).toEqual([
      { url: "abc@beacon.example", license: "CC0 1.0", author: "did:key:zAlice" },
    ]);
  });

  it("drops a photo that states no licence, and counts it", async () => {
    const { report, captured } = await stage(
      collection([feature({ unique: U2, media: [photo({ credit: undefined })] })]),
    );
    expect(report.photos).toBe(0);
    expect(report.unlicensedPhotos).toBe(1);
    expect(captured.staged[0]?.mediaRefs).toEqual([]);
  });

  it("takes the full and ignores the thumb — one photo, fetched once", async () => {
    // The thumb is the exporting server's own re-encode of the same picture. Taking both would
    // fetch one photo twice and publish the worse copy.
    const { report } = await stage(
      collection([
        feature({
          unique: U2,
          media: [photo({ role: "thumb", uris: ["thumb@beacon.example"] }), photo()],
        }),
      ]),
    );
    expect(report.photos).toBe(1);
  });
});
