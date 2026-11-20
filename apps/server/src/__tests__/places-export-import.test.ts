import type { GeoBBox, Media, PlaceExport, PlaceSnapshotStats } from "@beaconsgg/protocol-types";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PlacesAdminService } from "../places/admin.service";
import { MediaTransfer, mediaOriginUrl } from "../media/media-transfer";
import { STORAGE_FULL } from "../media/media.service";
import { fromFeature, pointInBoundary, toFeature } from "../places/export-import";
import { ADMIN_SOURCE } from "../places/merge";
import { SnapshotParamsError, SnapshotService } from "../places/snapshot.service";
import {
  PLACE_T0 as T0,
  makeClock,
  makePlace,
  makeSource,
  PARK_GEOMETRY as parkGeometry,
  SEATTLE_BBOX,
  TEST_ADMIN as ADMIN,
} from "./test-helpers";
import { MemoryPlaceStore } from "./memory-stores";

const BOUNDARY: GeoBBox = SEATTLE_BBOX;
const U1 = "01AAAAAAAAAAAAAAAAAAAAAAAA";
const U2 = "01BBBBBBBBBBBBBBBBBBBBBBBB";

describe("export-import pure helpers", () => {
  it("toFeature/fromFeature round-trip a polygon place (unique + fields + credit survive)", () => {
    const media: Media[] = [
      { type: "image", role: "thumb", hash: "h1", uris: ["h1@origin.example"] },
    ];
    const place = makePlace(U1, { category: "park", geometry: parkGeometry, media });
    const feature = toFeature(place, [{ source: "osm", attribution: "© OSM" }]);
    expect(feature.geometry).toEqual(parkGeometry);

    const imported = fromFeature(feature);
    expect(imported.unique).toBe(U1);
    expect(imported.fields).toEqual({
      category: "park",
      name: place.name,
      point: place.point,
      geometry: parkGeometry,
      media,
    });
    expect(imported.attribution).toBe("© OSM");
  });

  it("a point place exports a Point geometry which imports with no area", () => {
    const feature = toFeature(makePlace(U1), []);
    expect(feature.geometry).toEqual({ type: "Point", coordinates: [-122.33, 47.61] });
    expect(fromFeature(feature).fields.geometry).toBeUndefined();
  });

  it("pointInBoundary: bbox (incl. ±180 wrap) and polygon containment", () => {
    expect(pointInBoundary({ lat: 47.61, lng: -122.33 }, BOUNDARY)).toBe(true);
    expect(pointInBoundary({ lat: 47.7, lng: -122.33 }, BOUNDARY)).toBe(false);
    const fiji: GeoBBox = { minLat: -17, minLng: 179.5, maxLat: -16, maxLng: -179.5 };
    expect(pointInBoundary({ lat: -16.5, lng: 179.9 }, fiji)).toBe(true);
    expect(pointInBoundary({ lat: -16.5, lng: 178 }, fiji)).toBe(false);
    expect(pointInBoundary({ lat: 47.61, lng: -122.33 }, parkGeometry)).toBe(true);
    expect(pointInBoundary({ lat: 47.7, lng: -122.33 }, parkGeometry)).toBe(false);
  });

  it("mediaOriginUrl: https by default, http for localhost, undefined on a mismatched address", () => {
    const entry = (uri: string): Media => ({
      type: "image",
      role: "thumb",
      hash: "h1",
      uris: [uri],
    });
    expect(mediaOriginUrl(entry("h1@places.example"))).toBe("https://places.example/media/h1");
    expect(mediaOriginUrl(entry("h1@localhost:3002"))).toBe("http://localhost:3002/media/h1");
    expect(mediaOriginUrl(entry("other@places.example"))).toBeUndefined(); // address ≠ content id
    expect(mediaOriginUrl({ type: "image", role: "thumb", hash: "h1", uris: [] })).toBeUndefined();
  });
});

describe("PlacesAdminService.exportPlaces", () => {
  let store: MemoryPlaceStore;
  let service: PlacesAdminService;

  beforeEach(async () => {
    store = new MemoryPlaceStore();
    service = new PlacesAdminService(
      store,
      { host: "exporter.example", cellPrecision: 6, contribExportEnabled: false },
      makeClock().now,
    );
    await store.commitPlace(makePlace(U1), makeSource(U1), ["c23nb6"], []);
    await store.commitPlace(
      makePlace(U2, {
        category: "park",
        geometry: parkGeometry,
        point: { lat: 47.7, lng: -122.33 }, // outside BOUNDARY
      }),
      makeSource(U2, { sourceId: "way/7" }),
      ["c23nbx"],
      [],
    );
  });

  it("exports everything with provenance + dataset attribution in the beacon block", async () => {
    const out = await service.exportPlaces(undefined);
    expect(out.beacon).toMatchObject({
      profile: "beacon-places/1",
      host: "exporter.example",
      attribution: ["© OpenStreetMap contributors (ODbL)"],
    });
    expect(out.features.map((f) => f.properties.unique).sort()).toEqual([U1, U2]);
    const park = out.features.find((f) => f.properties.unique === U2);
    expect(park?.geometry).toEqual(parkGeometry);
    expect(park?.properties.sources).toEqual([
      { source: "osm", attribution: "© OpenStreetMap contributors (ODbL)" },
    ]);
  });

  it("boundary-filters precisely (cover pre-selects, the point check decides)", async () => {
    const out = await service.exportPlaces(BOUNDARY);
    expect(out.features.map((f) => f.properties.unique)).toEqual([U1]);
  });

  it("exports the detail-only descriptor fields (regression: the summary shape drops them)", async () => {
    // A point-only place — before the full-record fetch, exports built Features from the light
    // summary projection and silently stripped description/website on every hop.
    const U3 = "01CCCCCCCCCCCCCCCCCCCCCCCC";
    await store.commitPlace(
      makePlace(U3, {
        description: "Best sourdough in town.",
        website: "https://macrina.example.com",
      }),
      makeSource(U3, { sourceId: "node/9" }),
      ["c23nb7"],
      [],
    );
    const out = await service.exportPlaces(undefined);
    const feature = out.features.find((f) => f.properties.unique === U3);
    expect(feature?.properties.description).toBe("Best sourdough in town.");
    expect(feature?.properties.website).toBe("https://macrina.example.com");
  });

  // A list that moves between servers has to carry the terms its text came under, or the receiving
  // server republishes a CC BY-SA summary with nothing saying so.
  it("exports a description's credit alongside it", async () => {
    const U4 = "01DDDDDDDDDDDDDDDDDDDDDDDD";
    const credit = {
      license: "CC BY-SA 4.0",
      sourceUrl: "https://en.wikipedia.org/wiki/Pike_Place_Market",
    };
    await store.commitPlace(
      makePlace(U4, {
        description: "A public market overlooking the waterfront.",
        descriptionCredit: credit,
      }),
      makeSource(U4, { sourceId: "node/10" }),
      ["c23nb7"],
      [],
    );
    const out = await service.exportPlaces(undefined);
    const feature = out.features.find((f) => f.properties.unique === U4);
    expect(feature?.properties.descriptionCredit).toEqual(credit);
  });
});

describe("SnapshotService import — list:<name> through the shared pipeline", () => {
  let store: MemoryPlaceStore;
  let clock: ReturnType<typeof makeClock>;

  beforeEach(() => {
    store = new MemoryPlaceStore();
    clock = makeClock();
  });

  function collection(features: PlaceExport["features"]): PlaceExport {
    return { type: "FeatureCollection", beacon: { profile: "beacon-places/1" }, features };
  }
  function service(transfer?: MediaTransfer): SnapshotService {
    return new SnapshotService(
      store,
      { enabled: true, cellPrecision: 6, host: "test.example", writeLocked: false },
      { ...(transfer ? { mediaTransfer: transfer } : {}), now: clock.now },
    );
  }
  async function runImport(
    svc: SnapshotService,
    features: PlaceExport["features"],
    name = "parks",
  ) {
    const snap = await svc.createImport(name, collection(features), ADMIN);
    await svc.idle();
    const done = await svc.getSnapshot(snap.id);
    if (!done) throw new Error("snapshot missing");
    return done;
  }

  it("creates places that keep the file's unique; re-import updates and replaces the list", async () => {
    const svc = service();
    const f1 = toFeature(makePlace(U1, { name: "A" }), []);
    const f2 = toFeature(makePlace(U2, { name: "B", category: "park" }), []);
    const first = await runImport(svc, [f1, f2]);

    expect(first.status).toBe("done");
    expect((first.stats as PlaceSnapshotStats).created).toBe(2);
    expect((await store.getPlace(U1))?.name).toBe("A");
    expect((await store.getSource("list:parks", U1))?.placeUnique).toBe(U1);

    clock.advanceSeconds(60);
    const second = await runImport(svc, [toFeature(makePlace(U1, { name: "A2" }), [])]);
    const stats = second.stats as PlaceSnapshotStats;
    expect(stats.updated).toBe(1);
    expect(stats.retired).toBe(1); // U2 fell out of the list
    expect((await store.getPlace(U1))?.name).toBe("A2");
    expect((await store.getPlace(U2))?.status).toBe("retired");
  });

  it("attaches to an existing canonical place by unique — list outranks osm in the merge", async () => {
    await store.commitPlace(makePlace(U1, { name: "OSM Name" }), makeSource(U1), ["c23nb6"], []);
    const svc = service();
    await runImport(svc, [toFeature(makePlace(U1, { name: "List Name" }), [])]);

    const place = await store.getPlace(U1);
    expect(place?.name).toBe("List Name");
    expect(await store.sourcesForPlace(U1)).toHaveLength(2); // osm + list, one canonical place
  });

  it("logs a conflict against an admin-held field and keeps the admin value", async () => {
    await store.commitPlace(makePlace(U1, { name: "Pinned" }), makeSource(U1), ["c23nb6"], []);
    await store.commitPlace(
      makePlace(U1, { name: "Pinned" }),
      {
        source: ADMIN_SOURCE,
        sourceId: U1,
        placeUnique: U1,
        fields: { name: "Pinned" },
        syncedAt: T0,
      },
      ["c23nb6"],
      [],
    );
    const svc = service();
    const done = await runImport(svc, [toFeature(makePlace(U1, { name: "List Name" }), [])]);

    expect((done.stats as PlaceSnapshotStats).conflicts).toBe(1);
    expect((await store.getPlace(U1))?.name).toBe("Pinned");
  });

  it("re-hosts media through the transfer (kept) and drops it when media is off", async () => {
    const media: Media[] = [
      { type: "image", role: "thumb", hash: "h1", uris: ["h1@exporter.example"] },
    ];
    const transferred: Media[] = [{ ...media[0]!, uris: ["h1@ours.example"] }];
    const transfer = {
      transfer: vi.fn(() => Promise.resolve({ media: transferred, fetched: 1 })),
    };
    const svc = service(transfer as unknown as MediaTransfer);
    const done = await runImport(svc, [toFeature(makePlace(U1, { media }), [])]);

    // No transport override on this path: an interchange file addresses its bytes `hash@host`, so it goes
    // through `mediaOriginUrl`'s shape check — the bound that stops an uploaded file naming an arbitrary
    // host. Only a connector the operator configured (Atlas) supplies its own origin.
    expect(transfer.transfer).toHaveBeenCalledWith(media, {}, new Set());
    expect((done.stats as PlaceSnapshotStats).imagesIngested).toBe(1);
    expect((await store.getPlace(U1))?.media).toEqual(transferred);

    // No transfer seam (media capability off) → foreign refs are dropped, the place still lands.
    const off = service();
    await runImport(off, [toFeature(makePlace(U2, { media }), [])], "other");
    expect((await store.getPlace(U2))?.media).toBeUndefined();
  });

  it("counts the photos a full store left out, once each, and fetches nothing more in that run", async () => {
    const shared: Media = {
      type: "image",
      role: "thumb",
      hash: "h1",
      uris: ["h1@exporter.example"],
    };
    const own: Media = { type: "image", role: "full", hash: "h2", uris: ["h2@exporter.example"] };
    const fullSeen: number[] = [];
    const transfer = {
      transfer: vi.fn((media: Media[], _opts: unknown, leftOut: Set<string>) => {
        fullSeen.push(leftOut.size);
        for (const m of media) leftOut.add(m.hash);
        return Promise.resolve({ media: [], fetched: 0 });
      }),
    };
    const done = await runImport(service(transfer as unknown as MediaTransfer), [
      toFeature(makePlace(U1, { media: [shared] }), []),
      toFeature(makePlace(U2, { media: [shared, own] }), []),
    ]);

    // Two distinct photos, though three references: a photo two places share is one to make room for.
    expect((done.stats as PlaceSnapshotStats).imagesStorageFull).toBe(2);
    // One set for the run: the second place sees the first's refusal, so it downloads nothing.
    expect(fullSeen).toEqual([0, 1]);
    // The places land without the photos that did not fit.
    expect((await store.getPlace(U1))?.media).toBeUndefined();
    expect((await store.getPlace(U2))?.media).toBeUndefined();
  });

  it("MediaTransfer: local hash hit is zero-network; a hash mismatch drops the entry", async () => {
    const entries: Media[] = [
      { type: "image", role: "thumb", hash: "local", uris: ["local@a.example"] },
      { type: "image", role: "full", hash: "expected", uris: ["expected@a.example"] },
    ];
    const getBytes = vi.fn(() =>
      Promise.resolve({ bytes: Buffer.from("tampered"), contentType: "image/webp" }),
    );
    const ingester = {
      // The re-hash comes back different from the address — substituted bytes.
      ingestTrusted: () => Promise.resolve({ hash: "SOMETHING-ELSE", id: "SOMETHING-ELSE@ours" }),
      lookupIngested: (hash: string) =>
        Promise.resolve(hash === "local" ? { hash, id: "local@ours" } : undefined),
    };
    const transfer = new MediaTransfer(
      { http: { getBytes } as never, limiter: undefined as never },
      ingester,
      () => "did:key:zServer",
      { maxBytes: 1024, timeoutMs: 100 },
    );

    const out = await transfer.transfer(entries);
    expect(out.media).toEqual([{ ...entries[0]!, uris: ["local@ours"] }]); // mismatch dropped
    // Nothing counted as fetched: the survivor was already held, and the one that moved bytes failed its
    // re-hash. This is the number `imagesIngested` reports, so a locally-held entry must not inflate it.
    expect(out.fetched).toBe(0);
    expect(getBytes).toHaveBeenCalledTimes(1); // the local hit never fetched
  });

  it("transfer: stops fetching once the store is full, keeps what is held, and counts the rest", async () => {
    const entry = (hash: string): Media => ({
      type: "image",
      role: "full",
      hash,
      uris: [`${hash}@a.example`],
    });
    const getBytes = vi.fn(() =>
      Promise.resolve({ bytes: Buffer.from("x"), contentType: "image/webp" }),
    );
    const transfer = new MediaTransfer(
      { http: { getBytes } as never, limiter: undefined as never },
      {
        ingestTrusted: () => Promise.resolve(STORAGE_FULL),
        lookupIngested: (hash: string) =>
          Promise.resolve(hash === "held" ? { hash, id: "held@ours" } : undefined),
      },
      () => "did:key:zServer",
      { maxBytes: 1024, timeoutMs: 100 },
    );
    const held = { ...entry("held"), uris: ["held@ours"] };

    const leftOut = new Set<string>();
    const out = await transfer.transfer(
      [entry("a"), entry("b"), entry("held"), entry("c")],
      {},
      leftOut,
    );
    expect(out).toEqual({ media: [held], fetched: 0 });
    expect([...leftOut]).toEqual(["a", "b", "c"]);
    expect(getBytes).toHaveBeenCalledTimes(1); // refused once, then nothing more downloaded

    // A later place of the same run, the store already known to be full: no download at all.
    getBytes.mockClear();
    const later = await transfer.transfer([entry("d"), entry("held")], {}, leftOut);
    expect(later).toEqual({ media: [held], fetched: 0 });
    expect([...leftOut]).toEqual(["a", "b", "c", "d"]);
    expect(getBytes).not.toHaveBeenCalled();
  });

  /**
   * The two overrides an Atlas volume needs, and the reason each exists.
   *
   * They live on the call rather than inside `mediaOriginUrl` because that function is also reached by
   * untrusted `places.import` data, where the `hash@host` shape plus `unique === entry.hash` is what stops an
   * uploaded file naming an arbitrary host and path.
   */
  it("transfer: honours an origin resolver and an asserted content type", async () => {
    const entry: Media = {
      type: "image",
      role: "thumb",
      hash: "h1",
      // Not a GlobalId at all: `mediaOriginUrl` would refuse this, which is the point.
      uris: ["https://atlas.example/us-west/media/h1/h1.webp"],
    };
    const getBytes = vi.fn(() =>
      // A static host that does not know about .webp — the case that would otherwise lose every photo.
      Promise.resolve({ bytes: Buffer.from("x"), contentType: "application/octet-stream" }),
    );
    const seenTypes: string[] = [];
    const transfer = new MediaTransfer(
      { http: { getBytes } as never, limiter: undefined as never },
      {
        ingestTrusted: (_o: unknown, _b: Buffer, type: string) => {
          seenTypes.push(type);
          return Promise.resolve({ hash: "h1", id: "h1@ours" });
        },
        lookupIngested: () => Promise.resolve(undefined),
      } as never,
      () => "did:key:zServer" as never,
      { maxBytes: 1024, timeoutMs: 100 },
    );

    // Without an origin, the entry is unfetchable — proving the widening really is opt-in.
    expect(await transfer.transfer([entry])).toEqual({ media: [], fetched: 0 });
    expect(getBytes).not.toHaveBeenCalled();

    const out = await transfer.transfer([entry], {
      origin: (e) => e.uris[0],
      type: "image/webp",
    });
    expect(out).toEqual({ media: [{ ...entry, uris: ["h1@ours"] }], fetched: 1 });
    expect(seenTypes).toEqual(["image/webp"]); // asserted, not the header's octet-stream
  });

  /**
   * `ingestTrusted` skips the EXIF check because "re-encoding to WebP drops metadata, so the bytes are clean
   * by construction" — true of bytes this server produced, and never true of bytes that arrived here.
   * `media/:hash` is public and unauthenticated, so a GPS payload that got through would be served to anyone.
   */
  it("transfer: drops bytes carrying privacy metadata rather than re-hosting them", async () => {
    const entry: Media = { type: "image", role: "thumb", hash: "h1", uris: ["h1@far.example"] };
    const ingestTrusted = vi.fn(() => Promise.resolve({ hash: "h1", id: "h1@ours" }));
    const transfer = new MediaTransfer(
      {
        http: {
          getBytes: () =>
            Promise.resolve({ bytes: Buffer.from("exif"), contentType: "image/webp" }),
        } as never,
        limiter: undefined as never,
      },
      { ingestTrusted, lookupIngested: () => Promise.resolve(undefined) } as never,
      () => "did:key:zServer" as never,
      { maxBytes: 1024, timeoutMs: 100 },
      () => Promise.resolve(true), // the detector says this carries metadata
    );

    expect(await transfer.transfer([entry])).toEqual({ media: [], fetched: 0 });
    // Dropped before ingest, not scrubbed after: rewriting the bytes would change the hash they are
    // addressed by.
    expect(ingestTrusted).not.toHaveBeenCalled();
  });

  it("rejects an empty collection", async () => {
    await expect(service().createImport("parks", collection([]), ADMIN)).rejects.toBeInstanceOf(
      SnapshotParamsError,
    );
  });

  it("export → import round-trips a dataset between two stores", async () => {
    await store.commitPlace(
      makePlace(U1, { category: "park", geometry: parkGeometry }),
      makeSource(U1),
      ["c23nb6"],
      [],
    );
    const exported = await new PlacesAdminService(
      store,
      { host: "a.example", cellPrecision: 6, contribExportEnabled: false },
      clock.now,
    ).exportPlaces(undefined);

    const other = new MemoryPlaceStore();
    store = other; // reuse the service factory against the second store
    const svc = service();
    await runImport(svc, exported.features, "from-a");

    const place = await other.getPlace(U1);
    expect(place?.category).toBe("park");
    expect(place?.geometry).toEqual(parkGeometry);
    const src = await other.getSource("list:from-a", U1);
    expect(src?.attribution).toContain("OpenStreetMap"); // upstream credit survived the hop
  });
});
