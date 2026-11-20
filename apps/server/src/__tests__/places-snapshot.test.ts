import { cellBounds, coveringCells, encode } from "@beaconsgg/geo";
import type { GeoBBox, Media, PlaceCategory, PlaceSnapshotStats } from "@beaconsgg/protocol-types";
import { ulid } from "ulid";
import { beforeEach, describe, expect, it } from "vitest";
import type { PlaceConnector, SourcePlace } from "../places/connectors/connector";
import { ADMIN_SOURCE } from "../places/merge";
import {
  sweepPrefixCover,
  SnapshotParamsError,
  SnapshotService,
  type SnapshotConfig,
} from "../places/snapshot.service";
import { MemoryPlaceStore } from "./memory-stores";
import { makeClock, PARK_GEOMETRY, SEATTLE_BBOX, TEST_ADMIN as ADMIN } from "./test-helpers";

const BOUNDARY: GeoBBox = SEATTLE_BBOX;
// A boundary that decomposes into several p5 chunks (SEATTLE_BBOX is a single chunk) — exercises
// the run loop's one-deep prefetch pipeline, which the single-chunk path never reaches.
const MULTI_BOUNDARY: GeoBBox = { minLat: 47.6, minLng: -122.4, maxLat: 47.7, maxLng: -122.3 };
const CFG: SnapshotConfig = {
  enabled: true,
  cellPrecision: 6,
  host: "test.example",
  writeLocked: false,
};

/** The chunk precision every suite drives runs at (production chunks are a volume's p5 cells). */
const CHUNK_PRECISION = 5;

/** A boundary's chunk cells — what `create()` used to derive; `createRun` takes them explicitly. */
const chunksOf = (bbox: GeoBBox): string[] => coveringCells(bbox, CHUNK_PRECISION);

/** Seed one run through the engine — the driver the cross-source and retire suites share. */
async function seedRun(svc: SnapshotService, source: string, places: SourcePlace[]): Promise<void> {
  const connector: PlaceConnector = { id: source, fetchChunk: () => Promise.resolve(places) };
  await svc.createRun(connector, { boundary: BOUNDARY }, ADMIN, chunksOf(BOUNDARY));
  await svc.idle();
}

function cafe(id: number, name: string): SourcePlace {
  return {
    sourceId: `node/${id}`,
    fields: { category: "sweets", name, point: { lat: 47.61, lng: -122.33 } },
    raw: { amenity: "cafe", name },
    attribution: "© OpenStreetMap contributors (ODbL)",
  };
}

const parkGeometry = PARK_GEOMETRY;

describe("SnapshotService — admin-triggered population (`doc/spec/places.md` §6)", () => {
  let store: MemoryPlaceStore;
  let results: SourcePlace[];
  let connector: PlaceConnector;
  let clock: ReturnType<typeof makeClock>;

  beforeEach(() => {
    store = new MemoryPlaceStore();
    results = [];
    connector = {
      id: "osm",
      fetchChunk: () => Promise.resolve(results),
    };
    clock = makeClock();
  });

  function service(over: Partial<SnapshotConfig> = {}): SnapshotService {
    return new SnapshotService(store, { ...CFG, ...over }, { now: clock.now });
  }

  async function runSnapshot(
    svc: SnapshotService,
    over: { boundary?: GeoBBox; categories?: PlaceCategory[] } = {},
  ) {
    const boundary = over.boundary ?? BOUNDARY;
    const snap = await svc.createRun(
      connector,
      { boundary, ...(over.categories ? { categories: over.categories } : {}) },
      ADMIN,
      chunksOf(boundary),
    );
    await svc.idle();
    const done = await svc.getSnapshot(snap.id);
    if (!done) throw new Error("snapshot record missing");
    return done;
  }

  it("creates places with cells (point cell + polygon cover) and finishes done", async () => {
    results = [
      cafe(1, "Blue Bottle"),
      {
        sourceId: "way/7",
        fields: {
          category: "park",
          name: "Cal Anderson",
          point: { lat: 47.61, lng: -122.33 },
          geometry: parkGeometry,
        },
        attribution: "© OpenStreetMap contributors (ODbL)",
      },
    ];
    const done = await runSnapshot(service());

    expect(done.status).toBe("done");
    const stats = done.stats as PlaceSnapshotStats;
    expect(stats).toMatchObject({ created: 2, updated: 0, retired: 0, conflicts: 0 });
    expect(stats.fetched).toBeGreaterThanOrEqual(2); // border dedupe may see them in several chunks

    const all = await store.queryByCells(["c"], undefined, 10);
    expect(all.places).toHaveLength(2);
    const park = all.places.find((p) => p.category === "park");
    expect(park?.hasGeometry).toBe(true); // the list path carries the flag, not the polygon
    expect(park?.status).toBe("active");
    expect(park && (await store.getPlace(park.unique))?.geometry).toEqual(parkGeometry);
    // The polygon's cover spans several precision-6 cells — a corner cell still finds the park
    // (the cafe's point indexes only its own cell).
    const cornerCell = encode({ lat: 47.601, lng: -122.339 }, 6);
    const corner = await store.queryByCells([cornerCell], undefined, 10);
    expect(corner.places.some((p) => p.category === "park")).toBe(true);
    const src = await store.getSource("osm", "node/1");
    expect(src?.attribution).toContain("OpenStreetMap");
  });

  it("re-runs update in place (same unique), never duplicate", async () => {
    results = [cafe(1, "Blue Bottle")];
    const svc = service();
    await runSnapshot(svc);
    const before = await store.queryByCells(["c"], undefined, 10);

    clock.advanceSeconds(60);
    results = [cafe(1, "Blue Bottle Coffee")];
    const second = await runSnapshot(svc);

    const after = await store.queryByCells(["c"], undefined, 10);
    expect(after.places).toHaveLength(1);
    expect(after.places[0]?.unique).toBe(before.places[0]?.unique);
    expect(after.places[0]?.name).toBe("Blue Bottle Coffee");
    expect((second.stats as PlaceSnapshotStats).updated).toBe(1);
  });

  it("skips identical elements on a re-run (unchanged), including their conflicts", async () => {
    results = [cafe(1, "Blue Bottle")];
    const svc = service();
    await runSnapshot(svc);

    clock.advanceSeconds(60);
    const second = await runSnapshot(svc); // identical connector output
    const stats = second.stats as PlaceSnapshotStats;
    expect(stats).toMatchObject({ unchanged: 1, updated: 0, created: 0 });
    // The canonical row wasn't rewritten (updatedAt still from the first run).
    const place = (await store.queryByCells(["c"], undefined, 10)).places[0];
    expect(place?.updatedAt).toBe("2026-07-23T00:00:00.000Z");
  });

  it("preserves createdAt across refreshes (write-once contract)", async () => {
    results = [cafe(1, "Blue Bottle")];
    const svc = service();
    await runSnapshot(svc);
    clock.advanceSeconds(60);
    results = [cafe(1, "Renamed")];
    await runSnapshot(svc);
    const place = (await store.queryByCells(["c"], undefined, 10)).places[0];
    expect(place?.createdAt).toBe("2026-07-23T00:00:00.000Z");
    expect(place?.updatedAt).toBe("2026-07-23T00:01:00.000Z");
  });

  it("carries a record's ingested media forward on a refresh that supplies none", async () => {
    const media: Media[] = [{ type: "image", role: "thumb", hash: "h1", uris: ["h1@x"] }];
    const svc = service();
    results = [cafe(1, "Blue Bottle")];
    await runSnapshot(svc);
    // The record acquired media between runs (as a media-carrying import once left it).
    const place = (await store.queryByCells(["c"], undefined, 10)).places[0];
    const src = await store.getSource("osm", "node/1");
    if (!place || !src) throw new Error("seed missing");
    await store.commitPlace(
      { ...place, media },
      { ...src, fields: { ...src.fields, media } },
      [encode(place.point, 6)],
      [],
    );

    clock.advanceSeconds(60);
    results = [cafe(1, "Renamed")]; // no media on the refresh
    await runSnapshot(svc);

    const after = (await store.queryByCells(["c"], undefined, 10)).places[0];
    expect(after?.media).toEqual(media);
    expect(after?.name).toBe("Renamed");
  });

  it("logs a conflict for an admin-held field and keeps the admin value", async () => {
    results = [cafe(1, "OSM Name")];
    const svc = service();
    await runSnapshot(svc);
    const place = (await store.queryByCells(["c"], undefined, 10)).places[0];
    if (!place) throw new Error("place missing");

    // The admin curates the name (an admin source record holding only that field).
    await store.commitPlace(
      { ...place, name: "Curated Name", updatedAt: new Date(clock.now()).toISOString() },
      {
        source: ADMIN_SOURCE,
        sourceId: place.unique,
        placeUnique: place.unique,
        fields: { name: "Curated Name" },
        editedBy: ADMIN,
        editedAt: new Date(clock.now()).toISOString(),
        syncedAt: new Date(clock.now()).toISOString(),
      },
      [encode(place.point, 6)],
      [],
    );

    clock.advanceSeconds(60);
    results = [cafe(1, "Fresh OSM Name")];
    const done = await runSnapshot(svc);

    expect((done.stats as PlaceSnapshotStats).conflicts).toBe(1);
    const conflicts = await store.listConflicts(place.unique, 10);
    expect(conflicts[0]).toMatchObject({
      field: "name",
      currentValue: "Curated Name",
      incomingValue: "Fresh OSM Name",
      source: "osm",
    });
    // Merge kept the manual value; the connector's view lives on its own source record.
    expect((await store.getPlace(place.unique))?.name).toBe("Curated Name");
    expect((await store.getSource("osm", "node/1"))?.fields.name).toBe("Fresh OSM Name");
  });

  it("retires in-scope gone places, revives them when they return", async () => {
    results = [cafe(1, "A"), cafe(2, "B")];
    const svc = service();
    await runSnapshot(svc);

    clock.advanceSeconds(60);
    results = [cafe(1, "A")];
    const second = await runSnapshot(svc);
    expect((second.stats as PlaceSnapshotStats).retired).toBe(1);
    const after = await store.queryByCells(["c"], undefined, 10);
    expect(after.places.map((p) => p.name)).toEqual(["A"]);
    expect((await store.getSource("osm", "node/2"))?.goneAt).toBeDefined();

    // The element comes back — same source identity revives the same place.
    clock.advanceSeconds(60);
    results = [cafe(1, "A"), cafe(2, "B")];
    await runSnapshot(svc);
    const revived = await store.queryByCells(["c"], undefined, 10);
    expect(revived.places).toHaveLength(2);
    expect((await store.getSource("osm", "node/2"))?.goneAt).toBeUndefined();
  });

  it("never retires an admin-touched place; skips out-of-category retirement", async () => {
    results = [
      cafe(1, "Kept Cafe"),
      {
        sourceId: "way/7",
        fields: { category: "park", name: "Park", point: { lat: 47.605, lng: -122.335 } },
        attribution: "x",
      },
    ];
    const svc = service();
    await runSnapshot(svc);
    const cafePlace = (await store.queryByCells(["c"], ["sweets"], 10)).places[0];
    if (!cafePlace) throw new Error("cafe place missing");
    await store.commitPlace(
      cafePlace,
      {
        source: ADMIN_SOURCE,
        sourceId: cafePlace.unique,
        placeUnique: cafePlace.unique,
        fields: { name: "Pinned" },
        syncedAt: new Date(clock.now()).toISOString(),
      },
      [encode(cafePlace.point, 6)], // keep the real cell — the sweep is scope-checked by it
      [],
    );

    // A food-scoped re-run returns nothing: the cafe's osm record goes gone, but the place
    // survives (admin record lives); the park is out of category scope and untouched.
    clock.advanceSeconds(60);
    results = [];
    const done = await runSnapshot(svc, { categories: ["sweets"] });

    expect((done.stats as PlaceSnapshotStats).retired).toBe(1); // the cafe's osm record
    expect((await store.getPlace(cafePlace.unique))?.status).toBe("active");
    const remaining = await store.queryByCells(["c"], undefined, 10);
    expect(remaining.places.some((p) => p.category === "park")).toBe(true);
  });

  it("counts a run as active from queued until terminal, for the write-lock refusal", async () => {
    let release = (): void => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    connector = { id: "osm", fetchChunk: () => held.then(() => results) };
    const svc = service();
    expect(svc.hasActiveRun()).toBe(false);

    await svc.createRun(connector, { boundary: BOUNDARY }, ADMIN, chunksOf(BOUNDARY));
    expect(svc.hasActiveRun()).toBe(true);

    release();
    await svc.idle();
    expect(svc.hasActiveRun()).toBe(false);
  });

  it("refuses a run that reaches the queue after the server was locked", async () => {
    const svc = service({ writeLocked: true });
    await expect(
      svc.createRun(connector, { boundary: BOUNDARY }, ADMIN, chunksOf(BOUNDARY)),
    ).rejects.toThrow(/locked/);
    expect(svc.hasActiveRun()).toBe(false);
  });

  it("marks the snapshot failed when the connector throws, with the error preserved", async () => {
    connector = {
      id: "osm",
      fetchChunk: () => Promise.reject(new Error("volume host melted")),
    };
    const done = await runSnapshot(service());
    expect(done.status).toBe("failed");
    expect(done.error).toContain("volume host melted");
  });

  it("visits every chunk exactly once across a multi-chunk boundary (prefetch coverage)", async () => {
    const requested: string[] = [];
    connector = {
      id: "osm",
      fetchChunk: (bbox) => {
        requested.push(`${bbox.minLat}/${bbox.minLng}`);
        return Promise.resolve([cafe(2000 + requested.length, `C${requested.length}`)]);
      },
    };
    const done = await runSnapshot(service(), { boundary: MULTI_BOUNDARY });

    expect(done.status).toBe("done");
    // Each chunk fetched exactly once — the prefetch pipeline skips none and double-fetches none.
    expect(requested.length).toBeGreaterThan(1);
    expect(new Set(requested).size).toBe(requested.length);
    // One distinct place per chunk, all upserted (no chunk's rows dropped by the overlap).
    expect((done.stats as PlaceSnapshotStats).created).toBe(requested.length);
  });

  it("fails cleanly when a later chunk's in-flight prefetch rejects", async () => {
    let calls = 0;
    connector = {
      id: "osm",
      fetchChunk: () => {
        calls += 1;
        // The 3rd fetch is started as a prefetch during chunk 2's upserts, then rejects — the run
        // must surface it as `failed` and drain it (no unhandledRejection), not hang or leak.
        return calls >= 3
          ? Promise.reject(new Error("tile host dropped"))
          : Promise.resolve([cafe(3000 + calls, `C${calls}`)]);
      },
    };
    const done = await runSnapshot(service(), { boundary: MULTI_BOUNDARY });
    expect(done.status).toBe("failed");
    expect(done.error).toContain("tile host dropped");
  });

  it("cancels a live run cooperatively — stops at a chunk boundary and marks it failed", async () => {
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    connector = {
      id: "osm",
      fetchChunk: async () => {
        calls += 1;
        if (calls === 1) await gate; // hold the whole run at chunk 0 until we've issued the cancel
        return [cafe(5000 + calls, `C${calls}`)];
      },
    };
    const svc = service();
    const snap = await svc.createRun(
      connector,
      { boundary: MULTI_BOUNDARY },
      ADMIN,
      chunksOf(MULTI_BOUNDARY),
    );

    // The run is parked at chunk 0; cancelling flips the durable row immediately (operator feedback).
    const cancelled = await svc.cancel(snap.id);
    expect(cancelled?.status).toBe("failed");
    expect(cancelled?.error).toMatch(/cancel/i);

    release();
    await svc.idle();

    const after = await svc.getSnapshot(snap.id);
    expect(after?.status).toBe("failed");
    expect(after?.error).toMatch(/cancel/i);
    // It stopped before scanning every chunk — so the retirement sweep (which needs a full scan)
    // never ran, and no place was wrongly retired.
    const stats = after?.stats as PlaceSnapshotStats;
    expect(stats.chunksDone).toBeLessThan(stats.chunksTotal);
    expect(stats.retired).toBe(0);
  });

  it("cancel is a no-op on an unknown id and idempotent on a finished run", async () => {
    const svc = service();
    expect(await svc.cancel(ulid())).toBeUndefined(); // unknown → the controller maps this to 404

    results = [cafe(1, "Blue Bottle")];
    const done = await runSnapshot(svc);
    expect(done.status).toBe("done");
    const cancelled = await svc.cancel(done.id); // already terminal — cancel must not clobber it
    expect(cancelled?.status).toBe("done");
    expect(cancelled?.error).toBeUndefined();
  });

  it("closes out runs orphaned by a restart on boot (reconcile)", async () => {
    // Seed the durable log as a crashed process left it: two orphaned runs + one that finished.
    const seed = (status: "running" | "queued" | "done"): string => {
      const id = ulid(clock.now());
      void store.createSnapshot({
        id,
        source: "osm",
        params: { source: "osm", boundary: BOUNDARY },
        requestedBy: ADMIN,
        status,
        createdAt: new Date(clock.now()).toISOString(),
      });
      return id;
    };
    const runningId = seed("running");
    const queuedId = seed("queued");
    const doneId = seed("done");

    await service().onApplicationBootstrap();

    expect((await store.getSnapshot(runningId))?.status).toBe("failed");
    expect((await store.getSnapshot(queuedId))?.status).toBe("failed");
    expect((await store.getSnapshot(runningId))?.error).toMatch(/restart/i);
    expect((await store.getSnapshot(doneId))?.status).toBe("done"); // terminal runs untouched
  });
});

describe("sweepPrefixCover — the retirement sweep's SQL scoping cover", () => {
  it("keeps small boundaries at chunk precision, coarsens continent-scale ones", () => {
    // A single p5 chunk's own bbox: the cover IS the chunk-precision cover (tiny).
    const small = sweepPrefixCover(cellBounds("c23nb"), 5);
    expect(small.length).toBeLessThanOrEqual(4);
    expect(small.every((c) => c.length === 5)).toBe(true);

    // All of c2 (a p2 cell = 32,768 p5 chunks): the cover coarsens to <=64 prefixes — the store
    // filter must never see the raw chunk list (32k bind parameters in one OR-chain).
    const big = sweepPrefixCover(cellBounds("c2"), 5);
    expect(big.length).toBeLessThanOrEqual(64);
    // Edge over-selection (neighboring cells at inclusive bounds) is fine — what matters is that
    // every p5 chunk inside c2 is covered by some prefix.
    expect(big.some((p) => "c2000".startsWith(p))).toBe(true);
    expect(big.some((p) => "c2zzz".startsWith(p))).toBe(true);
  });
});

/**
 * Cross-source identity — the change without which Atlas duplicates every place on any server that
 * already snapshotted OSM (`apps/atlas/doc/spec/beacon-integration.md` §4).
 *
 * A separate describe because it is a *runner* property, not an Atlas one: two sources naming the same
 * `sourceId` are describing the same thing whoever they are.
 */
describe("SnapshotService — a second source lands on the place a first one created", () => {
  let store: MemoryPlaceStore;
  let clock: ReturnType<typeof makeClock>;
  let svc: SnapshotService;

  beforeEach(() => {
    store = new MemoryPlaceStore();
    clock = makeClock();
    svc = new SnapshotService(store, CFG, { now: clock.now });
  });

  const runWith = (source: string, places: SourcePlace[]): Promise<void> =>
    seedRun(svc, source, places);

  /** The headline: one place, two source records, not two places. */
  it("adopts the existing place instead of minting a second one", async () => {
    await runWith("osm", [cafe(1, "Blue Bottle")]);
    const first = (await store.queryByCells(["c23nb7"], undefined, 10)).places;
    expect(first).toHaveLength(1);
    const unique = first[0]!.unique;

    // A different source naming the same OSM element.
    await runWith("atlas:us-west", [{ ...cafe(1, "Blue Bottle Coffee"), raw: undefined }]);

    const after = (await store.queryByCells(["c23nb7"], undefined, 10)).places;
    expect(after).toHaveLength(1);
    expect(after[0]!.unique).toBe(unique);
    // Both records now hang off the one place.
    expect(await store.sourcesForPlace(unique)).toHaveLength(2);
  });

  /**
   * An upstream merge must become a field update, not a retire-plus-create — which would take the
   * operator's edits and the players' contributions with it
   * (`apps/atlas/doc/spec/place-identity.md` §5).
   */
  it("follows aliasSourceIds when the id itself is new", async () => {
    await runWith("atlas:us-west", [{ ...cafe(1, "Old"), sourceId: "01OLDATLASID" }]);
    const unique = (await store.queryByCells(["c23nb7"], undefined, 10)).places[0]!.unique;

    // The volume merged that place away; the survivor carries the old id as an alias.
    await runWith("atlas:us-west", [
      { ...cafe(1, "Merged"), sourceId: "01NEWATLASID", aliasSourceIds: ["01OLDATLASID"] },
    ]);

    const after = (await store.queryByCells(["c23nb7"], undefined, 10)).places;
    expect(after).toHaveLength(1);
    expect(after[0]!.unique).toBe(unique);
  });

  it("still mints a fresh place when nothing holds the id or any alias", async () => {
    await runWith("osm", [cafe(1, "Blue Bottle")]);
    await runWith("atlas:us-west", [
      { ...cafe(2, "Somewhere Else"), aliasSourceIds: ["node/999"] },
    ]);
    expect((await store.queryByCells(["c23nb7"], undefined, 10)).places).toHaveLength(2);
  });

  /**
   * The batched runner's equivalence guarantee: an element whose alias names an id introduced by
   * the SAME batch adopts that element's place, exactly as one-at-a-time commits would have — the
   * in-slice `assignedTo` replay. Without it, batching would silently mint a duplicate whenever a
   * volume ships a merge survivor beside a record still carrying the merged-away id.
   */
  it("adopts within one batch: an alias naming a sibling element's id lands on its place", async () => {
    await runWith("atlas:us-west", [
      { ...cafe(1, "Keeper"), sourceId: "01KEEPER" },
      { ...cafe(2, "Rider"), sourceId: "01RIDER", aliasSourceIds: ["01KEEPER"] },
    ]);
    const owners = await store.placeUniquesForSourceIds(["01KEEPER", "01RIDER"]);
    expect(owners).toHaveLength(2);
    expect(owners[0]!.placeUnique).toBe(owners[1]!.placeUnique);
    expect((await store.queryByCells(["c23nb7"], undefined, 10)).places).toHaveLength(1);
  });

  /** More elements than one slice holds — the accumulate/flush path must cover the tail. */
  it("covers a run larger than one upsert slice", async () => {
    const many = Array.from({ length: 1203 }, (_, i) => cafe(i, `Cafe ${i}`));
    await runWith("osm", many);
    expect(await store.liveSourcesBySource("osm")).toHaveLength(1203);
  });

  /**
   * A gone source stopped carrying the place; a new source must not resurrect that identity.
   *
   * `setSourceGone` is called directly, which marks the record gone without running the retirement tail —
   * so the original place stays live and the assertion is about *identity*, not about the count. That is
   * the honest shape of the check: two places is the correct outcome here, and the thing that would be
   * wrong is the Atlas record attaching to an identity the sweep had let go.
   */
  it("does not adopt a place whose only holder went gone", async () => {
    await runWith("osm", [cafe(1, "Blue Bottle")]);
    const unique = (await store.queryByCells(["c23nb7"], undefined, 10)).places[0]!.unique;
    await store.setSourceGone("osm", "node/1", new Date(clock.now()).toISOString());

    await runWith("atlas:us-west", [cafe(1, "Blue Bottle")]);
    expect((await store.placeUniquesForSourceIds(["node/1"]))[0]?.placeUnique).not.toBe(unique);
    const uniques = (await store.queryByCells(["c23nb7"], undefined, 10)).places.map(
      (p) => p.unique,
    );
    expect(uniques).toHaveLength(2);
    expect(new Set(uniques).size).toBe(2);
  });
});

/**
 * `places.source.retire` — the deliberate close-out for a source that is no longer an input
 * (`apps/atlas/doc/spec/beacon-integration.md` §6). The ordering property the whole story rests on
 * is the previous describe's last test: adoption follows only LIVE records — so the residue must be
 * retired *after* Atlas has adopted its places, and the tests below pin both sides of that line.
 */
describe("SnapshotService — createSourceRetire (the legacy close-out)", () => {
  let store: MemoryPlaceStore;
  let clock: ReturnType<typeof makeClock>;
  let svc: SnapshotService;

  beforeEach(() => {
    store = new MemoryPlaceStore();
    clock = makeClock();
    svc = new SnapshotService(store, CFG, { now: clock.now });
  });

  const runWith = (source: string, places: SourcePlace[]): Promise<void> =>
    seedRun(svc, source, places);

  const retire = async (source: string) => {
    const snap = await svc.createSourceRetire(source, ADMIN);
    await svc.idle();
    const done = await svc.getSnapshot(snap.id);
    if (!done) throw new Error("snapshot record missing");
    return done;
  };

  it("refuses every living input, before anything is enqueued", async () => {
    for (const source of ["admin", "contrib", "list:downtown", "atlas:us-west"]) {
      await expect(svc.createSourceRetire(source, ADMIN)).rejects.toBeInstanceOf(
        SnapshotParamsError,
      );
    }
    expect(await svc.listSnapshots()).toHaveLength(0); // nothing recorded for a refusal
  });

  it("retires the source's records and the places nothing else holds, as a durable run", async () => {
    await runWith("osm", [cafe(1, "A"), cafe(2, "B")]);

    const done = await retire("osm");
    expect(done.status).toBe("done");
    expect(done.source).toBe("osm");
    const stats = done.stats as PlaceSnapshotStats;
    expect(stats).toMatchObject({ fetched: 2, retired: 2, chunksDone: 1 });

    expect((await store.queryByCells(["c"], undefined, 10)).places).toHaveLength(0);
    expect((await store.getSource("osm", "node/1"))?.goneAt).toBeDefined();
    expect(await store.liveSourcesBySource("osm")).toHaveLength(0);
    // Idempotent by nature: a second sweep finds nothing live.
    expect(((await retire("osm")).stats as PlaceSnapshotStats).retired).toBe(0);
  });

  /** The migration path itself: import the volume FIRST, then close out — identity survives. */
  it("keeps a place Atlas adopted: the atlas record carries its identity past the close-out", async () => {
    await runWith("osm", [cafe(1, "Blue Bottle")]);
    const unique = (await store.queryByCells(["c23nb7"], undefined, 10)).places[0]!.unique;
    await runWith("atlas:us-west", [{ ...cafe(1, "Blue Bottle Coffee"), raw: undefined }]);

    const done = await retire("osm");
    expect((done.stats as PlaceSnapshotStats).retired).toBe(1);

    const after = (await store.queryByCells(["c23nb7"], undefined, 10)).places;
    expect(after).toHaveLength(1);
    expect(after[0]!.unique).toBe(unique); // same place, now held by the atlas record
    // The shared id still resolves through the LIVE atlas record — future imports keep adopting.
    expect((await store.placeUniquesForSourceIds(["node/1"]))[0]?.placeUnique).toBe(unique);
  });

  it("never retires an admin-touched place", async () => {
    await runWith("osm", [cafe(1, "Kept")]);
    const place = (await store.queryByCells(["c"], undefined, 10)).places[0]!;
    await store.commitPlace(
      place,
      {
        source: ADMIN_SOURCE,
        sourceId: place.unique,
        placeUnique: place.unique,
        fields: { name: "Pinned" },
        syncedAt: new Date(clock.now()).toISOString(),
      },
      [encode(place.point, 6)],
      [],
    );

    const done = await retire("osm");
    expect((done.stats as PlaceSnapshotStats).retired).toBe(1); // the osm record itself
    // The place survives on the retire-protected admin record; with nothing servable left to
    // re-merge, the canonical row stays as last merged (canonical.ts's documented behaviour).
    expect((await store.getPlace(place.unique))?.status).toBe("active");
    expect((await store.getSource("osm", "node/1"))?.goneAt).toBeDefined();
  });
});
