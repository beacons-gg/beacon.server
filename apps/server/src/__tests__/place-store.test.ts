import type { PlaceGeometry } from "@beaconsgg/protocol-types";
import { beforeEach, describe, expect, it } from "vitest";
import {
  validCellPrefixes,
  type PlaceProposalRecord,
  type PlaceStore,
} from "../stores/place-store";
import { PgPlaceStore } from "../stores/place.pg.store";
import { MemoryPlaceStore } from "./memory-stores";
import { pgTwin } from "./pg-twin";
import {
  PLACE_T0 as T0,
  TEST_ADMIN,
  makePlace as place,
  makeSource as source,
} from "./test-helpers";

const T1 = "2026-07-23T01:00:00.000Z";

/** A second DID, so the actor-scoped proposal reads have something to exclude. */
const OTHER = "did:key:zContributor";

/** A pending new-place proposal (no `placeUnique`) — override to make it an improvement/reviewed. */
function proposal(id: string, over: Partial<PlaceProposalRecord> = {}): PlaceProposalRecord {
  return {
    id,
    proposedBy: TEST_ADMIN,
    credit: false,
    fields: { category: "park", name: "Proposed Park", point: { lat: 47.61, lng: -122.33 } },
    status: "pending",
    createdAt: T0,
    ...over,
  };
}

/** Opening a twin may be async (Postgres runs migrations + clears the shared tables first). */
type MakeStore = () => PlaceStore | Promise<PlaceStore>;

/** The twin-parity suite — every PlaceStore implementation must pass it identically. */
function placeStoreSuite(name: string, make: MakeStore): void {
  describe(`PlaceStore parity — ${name}`, () => {
    let store: PlaceStore;
    beforeEach(async () => {
      store = await make();
    });

    it("commitPlace round-trips the place, source, and cells", async () => {
      const geometry: PlaceGeometry = {
        type: "Polygon",
        coordinates: [
          [
            [-122.34, 47.6],
            [-122.32, 47.6],
            [-122.32, 47.62],
            [-122.34, 47.62],
            [-122.34, 47.6],
          ],
        ],
      };
      const media = [{ type: "image", role: "thumb" as const, hash: "abc", uris: ["abc@h"] }];
      const p = place("P1", { geometry, media });
      await store.commitPlace(p, source("P1", { raw: { amenity: "cafe" } }), ["9q8yyk"], []);

      expect(await store.getPlace("P1")).toEqual(p);
      const src = await store.getSource("osm", "node/P1");
      expect(src?.placeUnique).toBe("P1");
      expect(src?.raw).toEqual({ amenity: "cafe" });
      expect(await store.sourcesForPlace("P1")).toHaveLength(1);
      const q = await store.queryByCells(["9q8yyk"], undefined, 10);
      expect(q.places.map((x) => x.unique)).toEqual(["P1"]);
      // The list path is a projection: the polygon never rides it, hasGeometry stands in.
      expect(q.places[0]?.hasGeometry).toBe(true);
      expect(q.places[0] && "geometry" in q.places[0]).toBe(false);
    });

    it("re-commit updates fields and replaces the cell index", async () => {
      await store.commitPlace(place("P1"), source("P1"), ["9q8yyk"], []);
      await store.commitPlace(
        place("P1", { name: "Renamed", updatedAt: T1 }),
        source("P1", { syncedAt: T1 }),
        ["c23nb6"],
        [],
      );
      expect((await store.getPlace("P1"))?.name).toBe("Renamed");
      expect((await store.queryByCells(["9q8yyk"], undefined, 10)).places).toHaveLength(0);
      expect((await store.queryByCells(["c23nb6"], undefined, 10)).places).toHaveLength(1);
    });

    it("updatePlace re-writes the canonical row + cells without touching sources", async () => {
      await store.commitPlace(place("P1"), source("P1"), ["9q8yyk"], []);
      await store.updatePlace(place("P1", { name: "Re-merged", updatedAt: T1 }), ["c23nb6"]);
      expect((await store.getPlace("P1"))?.name).toBe("Re-merged");
      expect((await store.queryByCells(["c23nb6"], undefined, 10)).places).toHaveLength(1);
      expect(await store.sourcesForPlace("P1")).toHaveLength(1); // source record untouched
    });

    it("non-geohash query prefixes match nothing (the LIKE primitive is total)", async () => {
      await store.commitPlace(place("P1"), source("P1"), ["9q8yyk"], []);
      expect((await store.queryByCells(["%"], undefined, 10)).places).toHaveLength(0);
      expect((await store.queryByCells(["9q8%"], undefined, 10)).places).toHaveLength(0);
      expect((await store.queryByCells(["9q8yyk", "%"], undefined, 10)).places).toHaveLength(1);
    });

    it("queryByCells prefix-matches, filters categories, caps with truncated", async () => {
      await store.commitPlace(place("P1"), source("P1"), ["9q8yyk"], []);
      await store.commitPlace(
        place("P2", { category: "park" }),
        source("P2", { sourceId: "node/P2", fields: { category: "park" } }),
        ["9q8yym"],
        [],
      );
      await store.commitPlace(place("P3"), source("P3", { sourceId: "node/P3" }), ["c23nb6"], []);

      // A coarser query cell matches the finer index cells under it.
      const all = await store.queryByCells(["9q8"], undefined, 10);
      expect(all.places.map((p) => p.unique)).toEqual(["P1", "P2"]);
      expect(all.truncated).toBe(false);

      const parks = await store.queryByCells(["9q8"], ["park"], 10);
      expect(parks.places.map((p) => p.unique)).toEqual(["P2"]);

      const capped = await store.queryByCells(["9q8"], undefined, 1);
      expect(capped.places).toHaveLength(1);
      expect(capped.truncated).toBe(true);

      expect((await store.queryByCells([], undefined, 10)).places).toHaveLength(0);
    });

    it("queryByCells keyset-paginates via `after` (stable unique order)", async () => {
      for (const u of ["P1", "P2", "P3", "P4"]) {
        await store.commitPlace(place(u), source(u), ["9q8yyk"], []);
      }
      // Page 1: the first two, truncated (more exist).
      const page1 = await store.queryByCells(["9q8"], undefined, 2);
      expect(page1.places.map((p) => p.unique)).toEqual(["P1", "P2"]);
      expect(page1.truncated).toBe(true);
      // Page 2: everything with unique > the last of page 1.
      const page2 = await store.queryByCells(["9q8"], undefined, 2, "P2");
      expect(page2.places.map((p) => p.unique)).toEqual(["P3", "P4"]);
      expect(page2.truncated).toBe(false);
      // `after` still honors the category filter, and a cursor past the end is an empty page.
      expect(
        (await store.queryByCells(["9q8"], ["sweets"], 2, "P2")).places.map((p) => p.unique),
      ).toEqual(["P3", "P4"]);
      expect((await store.queryByCells(["9q8"], undefined, 2, "P4")).places).toHaveLength(0);
    });

    it("queryByCells `spread` takes a page evenly across the area, not its lowest ids", async () => {
      // Three places crowd one sub-cell of c23 and one sits in another; a far-off city has one more.
      for (const u of ["P1", "P2", "P3"]) {
        await store.commitPlace(place(u), source(u), ["c23nb6"], []);
      }
      await store.commitPlace(place("P4"), source("P4"), ["c23zz0"], []);
      await store.commitPlace(place("P5"), source("P5"), ["9q8yyk"], []);

      // By id, a full page is the crowded sub-cell; spread, every sub-cell gets its first place first.
      const byId = await store.queryByCells(["c23"], undefined, 2);
      expect(byId.places.map((p) => p.unique)).toEqual(["P1", "P2"]);
      const ids = async (cells: string[], after?: string) =>
        (await store.queryByCells(cells, undefined, 2, after, true)).places.map((p) => p.unique);
      const crowded = (u: string | undefined) => ["P1", "P2", "P3"].includes(u!);
      const page = await store.queryByCells(["c23"], undefined, 2, undefined, true);
      const spread = page.places.map((p) => p.unique);
      expect(page.truncated).toBe(true);
      expect(spread).toContain("P4");
      expect(spread.filter(crowded)).toHaveLength(1);
      // A spread page never pages, and is the same page each time: a cursor changes nothing.
      expect(await ids(["c23"], "P3")).toEqual(spread);
      // Cells far apart are each spread on their own, not as one box around both.
      const apart = await ids(["c23nb", "9q8yy"]);
      expect(apart).toContain("P5");
      expect(apart.filter(crowded)).toHaveLength(1);
    });

    it("queryByCells `spread` ranks a place indexed under several cells once", async () => {
      await store.commitPlace(place("P1"), source("P1"), ["c23nb6", "c23zz0"], []);
      await store.commitPlace(place("P2"), source("P2"), ["c23zz0"], []);
      const spread = await store.queryByCells(["c23"], undefined, 10, undefined, true);
      expect(spread.places.map((p) => p.unique).sort()).toEqual(["P1", "P2"]);
    });

    it("countActive counts active places only", async () => {
      await store.commitPlace(place("P1"), source("P1"), ["c23nb6"], []);
      await store.commitPlace(place("P2", { status: "retired" }), source("P2"), ["c23nb6"], []);
      expect(await store.countActive()).toBe(1);
    });

    it("a place indexed under several cells matches once (no duplicates)", async () => {
      await store.commitPlace(place("P1"), source("P1"), ["9q8yyk", "9q8yym"], []);
      const q = await store.queryByCells(["9q8yyk", "9q8yym", "9q8"], undefined, 10);
      expect(q.places.map((p) => p.unique)).toEqual(["P1"]);
    });

    it("preserves createdAt across upserts (write-once contract)", async () => {
      await store.commitPlace(place("P1"), source("P1"), ["9q8yyk"], []);
      await store.commitPlace(
        place("P1", { createdAt: T1, updatedAt: T1 }),
        source("P1", { syncedAt: T1 }),
        ["9q8yyk"],
        [],
      );
      const kept = await store.getPlace("P1");
      expect(kept?.createdAt).toBe(T0);
      expect(kept?.updatedAt).toBe(T1);
    });

    it("liveSourcesBySource scopes to cell prefixes when given", async () => {
      await store.commitPlace(place("P1"), source("P1"), ["9q8yyk"], []);
      await store.commitPlace(place("P2"), source("P2", { sourceId: "node/P2" }), ["c23nb6"], []);
      expect(await store.liveSourcesBySource("osm", ["9q8"])).toHaveLength(1);
      expect(await store.liveSourcesBySource("osm", ["9q8", "c23"])).toHaveLength(2);
      expect(await store.liveSourcesBySource("osm", ["%"])).toHaveLength(0);
      expect(await store.liveSourcesBySource("osm")).toHaveLength(2);
    });

    it("liveSourceKeysBySource returns the two ids only, live records only", async () => {
      await store.commitPlace(place("P1"), source("P1"), ["9q8yyk"], []);
      await store.commitPlace(place("P2"), source("P2", { sourceId: "node/P2" }), ["c23nb6"], []);
      await store.setSourceGone("osm", "node/P2", T1);
      expect(await store.liveSourceKeysBySource("osm")).toEqual([
        { sourceId: "node/P1", placeUnique: "P1" },
      ]);
      expect(await store.liveSourceKeysBySource("nope")).toEqual([]);
    });

    it("attributionsForPlaces returns distinct live-source credit lines", async () => {
      await store.commitPlace(place("P1"), source("P1"), ["9q8yyk"], []);
      await store.commitPlace(
        place("P2"),
        source("P2", { sourceId: "node/P2", attribution: "© Custom List" }),
        ["9q8yym"],
        [],
      );
      expect(await store.attributionsForPlaces(["P1", "P2"])).toEqual([
        "© Custom List",
        "© OpenStreetMap contributors (ODbL)",
      ]);
      expect(await store.attributionsForPlaces(["P1"])).toEqual([
        "© OpenStreetMap contributors (ODbL)",
      ]);
      expect(await store.attributionsForPlaces([])).toEqual([]);
      await store.setSourceGone("osm", "node/P2", T1);
      expect(await store.attributionsForPlaces(["P2"])).toEqual([]);
    });

    /**
     * The cross-source lookup an Atlas import stands on. The runner keys identity by `(source,
     * sourceId)`, so without this a second source describing a place the server already holds mints
     * a **new** place — every place duplicated on a server that snapshotted OSM and then imported a
     * volume (`apps/atlas/doc/spec/beacon-integration.md` §4).
     */
    describe("placeUniquesForSourceIds", () => {
      /** The one-id read, for the cases below where one answer is the point. */
      const ownerOf = async (id: string) => (await store.placeUniquesForSourceIds([id]))[0];

      it("finds the place whatever source wrote the record", async () => {
        await store.commitPlace(place("P1"), source("P1"), ["9q8yyk"], []);
        // Asked without naming a source — which is the whole point.
        expect(await ownerOf("node/P1")).toEqual({
          sourceId: "node/P1",
          placeUnique: "P1",
          source: "osm",
        });
      });

      it("yields no row for a sourceId no source holds", async () => {
        await store.commitPlace(place("P1"), source("P1"), ["9q8yyk"], []);
        expect(await store.placeUniquesForSourceIds(["way/999", "node/P1"])).toEqual([
          { sourceId: "node/P1", placeUnique: "P1", source: "osm" },
        ]);
      });

      /**
       * A `goneAt` record is a source that stopped carrying the place. Attaching a new source to it would
       * resurrect an identity the retirement sweep deliberately let go.
       */
      it("ignores a record whose source went gone", async () => {
        await store.commitPlace(place("P1"), source("P1"), ["9q8yyk"], []);
        await store.setSourceGone("osm", "node/P1", T1);
        expect(await ownerOf("node/P1")).toBeUndefined();
      });

      /**
       * The case the whole feature exists for: two sources naming the same element resolve to one place.
       * Deterministically ordered, so an import's result never depends on physical row order — and the
       * winner's `source` rides along, because the snapshot runner replays this contest against records
       * its own batch is about to write.
       */
      it("is deterministic when several live sources share a sourceId", async () => {
        await store.commitPlace(place("P1"), source("P1"), ["9q8yyk"], []);
        await store.commitPlace(
          place("P2"),
          source("P2", { source: "atlas:us-west", sourceId: "node/P1", placeUnique: "P2" }),
          ["9q8yyk"],
          [],
        );
        // `atlas:us-west` sorts before `osm`, and both twins must agree on that.
        expect(await ownerOf("node/P1")).toEqual({
          sourceId: "node/P1",
          placeUnique: "P2",
          source: "atlas:us-west",
        });
      });
    });

    /** The batched write path — the snapshot runner commits whole slices through this. */
    describe("commitPlaces", () => {
      it("lands every entry: places, several sources on one place, cells, conflicts", async () => {
        await store.commitPlaces([
          {
            place: place("P1"),
            // A batch can put more than one source record on a single place.
            sources: [
              source("P1"),
              source("P1", { source: "atlas:us-west", sourceId: "atlas/1", placeUnique: "P1" }),
            ],
            cells: ["9q8yyk", "9q8yym"],
            conflicts: [
              {
                id: "C1",
                placeUnique: "P1",
                field: "name",
                incomingValue: "Other",
                source: "osm",
                createdAt: T0,
              },
            ],
          },
          {
            place: place("P2", { name: "Second" }),
            sources: [source("P2")],
            cells: [],
            conflicts: [],
          },
        ]);

        expect((await store.getPlace("P1"))?.name).toBe("Blue Bottle");
        expect((await store.getPlace("P2"))?.name).toBe("Second");
        expect(await store.sourcesForPlace("P1")).toHaveLength(2);
        expect((await store.queryByCells(["9q8yy"], undefined, 10)).places).toHaveLength(1);
        expect((await store.listConflicts("P1", 10))[0]?.id).toBe("C1");
      });

      it("re-commit through a batch keeps createdAt write-once and replaces cells", async () => {
        await store.commitPlace(place("P1"), source("P1"), ["9q8yyk"], []);
        await store.commitPlaces([
          {
            place: place("P1", { name: "Renamed", createdAt: T1, updatedAt: T1 }),
            sources: [source("P1", { syncedAt: T1 })],
            cells: ["9q8yym"],
            conflicts: [],
          },
        ]);
        const p = await store.getPlace("P1");
        expect(p?.name).toBe("Renamed");
        expect(p?.createdAt).toBe(T0); // write-once survives the multi-row form
        const q = await store.queryByCells(["9q8yym"], undefined, 10);
        expect(q.places.map((x) => x.unique)).toEqual(["P1"]);
        expect((await store.queryByCells(["9q8yyk"], undefined, 10)).places).toHaveLength(0);
      });
    });

    /** Trust-on-first-use, durably: first import pins, same publisher re-pins, another is refused. */
    describe("atlas publisher pins", () => {
      it("pins once, re-pins idempotently, and refuses a different publisher", async () => {
        expect(await store.pinAtlasPublisher("us-west", "did:key:zA", T0, TEST_ADMIN)).toBe(true);
        expect(await store.pinAtlasPublisher("us-west", "did:key:zA", T1, OTHER)).toBe(true);
        expect(await store.pinAtlasPublisher("us-west", "did:key:zB", T1, OTHER)).toBe(false);
        expect(await store.getAtlasPublisher("us-west")).toBe("did:key:zA");
      });

      it("lists every pin with its audit half; a re-pin keeps the ORIGINAL stamp", async () => {
        await store.pinAtlasPublisher("us-west", "did:key:zA", T0, TEST_ADMIN);
        await store.pinAtlasPublisher("eu-north", "did:key:zB", T1, OTHER);
        // The idempotent re-pin must not rewrite who confirmed the binding first, or when —
        // the audit half answers "who decided to trust this key", which happened once.
        await store.pinAtlasPublisher("us-west", "did:key:zA", T1, OTHER);
        expect(await store.listAtlasPublishers()).toEqual([
          { volume: "eu-north", publisher: "did:key:zB", pinnedAt: T1, pinnedBy: OTHER },
          { volume: "us-west", publisher: "did:key:zA", pinnedAt: T0, pinnedBy: TEST_ADMIN },
        ]);
      });

      it("unpin forgets the binding and reports whether one existed", async () => {
        await store.pinAtlasPublisher("us-west", "did:key:zA", T0, TEST_ADMIN);
        expect(await store.unpinAtlasPublisher("us-west")).toBe(true);
        expect(await store.unpinAtlasPublisher("us-west")).toBe(false);
        expect(await store.getAtlasPublisher("us-west")).toBeUndefined();
        expect(await store.listAtlasPublishers()).toEqual([]);
      });
    });

    it("getSources returns exactly the held ids of the named source", async () => {
      await store.commitPlace(place("P1"), source("P1"), ["9q8yyk"], []);
      await store.commitPlace(
        place("P2"),
        source("P2", { source: "atlas:us-west", sourceId: "atlas/2", placeUnique: "P2" }),
        ["9q8yym"],
        [],
      );
      const found = await store.getSources("osm", ["node/P1", "node/P2", "atlas/2"]);
      // `atlas/2` belongs to another source, and no record holds the second `node/` id, so neither
      // comes back.
      expect(found.map((s) => s.sourceId)).toEqual(["node/P1"]);
      expect(found[0]?.placeUnique).toBe("P1");
    });

    it("sourcesForPlaces spans places, includes gone records, and is slim (no raw)", async () => {
      await store.commitPlace(
        place("P1"),
        source("P1", { raw: { amenity: "cafe" } }),
        ["9q8yyk"],
        [],
      );
      await store.commitPlace(place("P2"), source("P2"), ["9q8yym"], []);
      await store.setSourceGone("osm", "node/P2", T1);
      const all = await store.sourcesForPlaces(["P1", "P2", "P3"]);
      expect(all.map((s) => [s.placeUnique, s.goneAt === undefined]).sort()).toEqual([
        ["P1", true],
        ["P2", false],
      ]);
      // Slim per the interface — the single keeps the payload, the batched read never ships it.
      expect(all.every((s) => s.raw === undefined)).toBe(true);
      expect((await store.sourcesForPlace("P1"))[0]?.raw).toEqual({ amenity: "cafe" });
    });

    it("setSourceGone hides from liveSourcesBySource; getSource still shows goneAt", async () => {
      await store.commitPlace(place("P1"), source("P1"), ["9q8yyk"], []);
      expect(await store.liveSourcesBySource("osm")).toHaveLength(1);
      await store.setSourceGone("osm", "node/P1", T1);
      expect(await store.liveSourcesBySource("osm")).toHaveLength(0);
      expect((await store.getSource("osm", "node/P1"))?.goneAt).toBe(T1);
    });

    it("retirePlace drops the place from queries but keeps the row", async () => {
      await store.commitPlace(place("P1"), source("P1"), ["9q8yyk"], []);
      await store.retirePlace("P1", T1);
      expect((await store.queryByCells(["9q8yyk"], undefined, 10)).places).toHaveLength(0);
      const kept = await store.getPlace("P1");
      expect(kept?.status).toBe("retired");
      expect(kept?.updatedAt).toBe(T1);
    });

    it("commitPlace over a retired place re-activates and re-indexes it (edit-revive contract)", async () => {
      await store.commitPlace(place("P1"), source("P1"), ["9q8yyk"], []);
      await store.retirePlace("P1", T1);
      await store.commitPlace(place("P1", { updatedAt: T1 }), source("P1"), ["9q8yyk"], []);
      expect((await store.getPlace("P1"))?.status).toBe("active");
      expect((await store.queryByCells(["9q8yyk"], undefined, 10)).places).toHaveLength(1);
    });

    it("snapshot create/get/update/list (newest first)", async () => {
      const base = {
        source: "osm",
        params: { source: "osm", boundary: { minLat: 1, minLng: 2, maxLat: 3, maxLng: 4 } },
        requestedBy: "did:key:zAdmin",
        status: "queued" as const,
        createdAt: T0,
      };
      await store.createSnapshot({ ...base, id: "01A" });
      await store.createSnapshot({ ...base, id: "01B" });
      const stats = {
        chunksDone: 1,
        chunksTotal: 1,
        fetched: 5,
        created: 5,
        updated: 0,
        unchanged: 0,
        skipped: 0,
        retired: 0,
        conflicts: 0,
        imagesIngested: 0,
      };
      await store.updateSnapshot("01A", { status: "done", stats, startedAt: T0, finishedAt: T1 });

      const done = await store.getSnapshot("01A");
      expect(done?.status).toBe("done");
      expect(done?.stats).toEqual(stats);
      expect(done?.finishedAt).toBe(T1);
      expect((await store.getSnapshot("01B"))?.status).toBe("queued");
      expect((await store.listSnapshots(10)).map((s) => s.id)).toEqual(["01B", "01A"]);
      expect(await store.getSnapshot("nope")).toBeUndefined();
    });

    it("failSnapshots flips non-terminal runs (scoped or bulk), never terminal ones", async () => {
      const base = {
        source: "osm",
        params: { source: "osm", boundary: { minLat: 1, minLng: 2, maxLat: 3, maxLng: 4 } },
        requestedBy: "did:key:zAdmin",
        createdAt: T0,
      };
      await store.createSnapshot({ ...base, id: "01R", status: "running" });
      await store.createSnapshot({ ...base, id: "01Q", status: "queued" });
      await store.createSnapshot({ ...base, id: "01D", status: "done" });

      // id-scoped (admin cancel): only that run flips; a terminal run is a no-op (0 rows).
      expect(await store.failSnapshots("cancelled", T1, "01R")).toBe(1);
      expect(await store.failSnapshots("cancelled", T1, "01D")).toBe(0);
      const flipped = await store.getSnapshot("01R");
      expect(flipped).toMatchObject({ status: "failed", error: "cancelled", finishedAt: T1 });
      expect((await store.getSnapshot("01Q"))?.status).toBe("queued"); // other runs untouched

      // bulk (boot reconcile): every remaining non-terminal run flips, terminal ones stay put.
      expect(await store.failSnapshots("interrupted", T1)).toBe(1); // only 01Q is still non-terminal
      expect((await store.getSnapshot("01Q"))?.error).toBe("interrupted");
      expect((await store.getSnapshot("01D"))?.status).toBe("done");
    });

    it("resolveConflicts flips unresolved rows exactly once", async () => {
      await store.commitPlace(
        place("P1"),
        source("P1"),
        ["9q8yyk"],
        [
          {
            id: "01C",
            placeUnique: "P1",
            field: "name",
            incomingValue: "OSM Name",
            source: "osm",
            createdAt: T0,
          },
        ],
      );
      expect(await store.resolveConflicts(["01C", "missing"], T1)).toBe(1);
      expect(await store.resolveConflicts(["01C"], T1)).toBe(0);
      expect(await store.resolveConflicts([], T1)).toBe(0);
      expect((await store.listConflicts("P1", 10))[0]?.resolvedAt).toBe(T1);
    });

    it("conflicts persist through commitPlace and list unresolved-first", async () => {
      await store.commitPlace(
        place("P1"),
        source("P1"),
        ["9q8yyk"],
        [
          {
            id: "01C",
            placeUnique: "P1",
            field: "name",
            currentValue: "Admin Name",
            incomingValue: "OSM Name",
            source: "osm",
            snapshotId: "01A",
            createdAt: T0,
          },
        ],
      );
      const all = await store.listConflicts(undefined, 10);
      expect(all).toHaveLength(1);
      expect(all[0]?.field).toBe("name");
      expect(all[0]?.currentValue).toBe("Admin Name");
      expect(await store.listConflicts("P1", 10)).toHaveLength(1);
      expect(await store.listConflicts("P2", 10)).toHaveLength(0);
    });

    it("stats counts actives, retired, pending conflicts, and snapshot runs", async () => {
      expect(await store.stats()).toEqual({
        places: 0,
        placesRetired: 0,
        conflictsPending: 0,
        snapshots: 0,
      });
      await store.commitPlace(
        place("P1"),
        source("P1"),
        ["9q8yyk"],
        [
          {
            id: "01C",
            placeUnique: "P1",
            field: "name",
            incomingValue: "X",
            source: "osm",
            createdAt: T0,
          },
          {
            id: "01D",
            placeUnique: "P1",
            field: "summary",
            incomingValue: "Y",
            source: "osm",
            createdAt: T0,
          },
        ],
      );
      await store.commitPlace(place("P2"), source("P2"), ["9q8yyk"], []);
      await store.retirePlace("P2", T1);
      await store.resolveConflicts(["01C"], T1);
      await store.createSnapshot({
        id: "01A",
        source: "osm",
        params: { source: "osm", boundary: { minLat: 1, minLng: 2, maxLat: 3, maxLng: 4 } },
        requestedBy: TEST_ADMIN,
        status: "done",
        createdAt: T0,
      });
      expect(await store.stats()).toEqual({
        places: 1,
        placesRetired: 1,
        conflictsPending: 1,
        snapshots: 1,
      });
    });

    // ── proposals: player contributions awaiting review (`doc/spec/place-proposals.md` §3)
    // ────────────

    describe("proposals", () => {
      it("round-trips a proposal, including the absent place_unique of a new-place submission", async () => {
        await store.createProposal(proposal("01P1"));
        await store.createProposal(proposal("01P2", { placeUnique: "P9", note: "wrong hours" }));

        const fresh = await store.getProposal("01P1");
        expect(fresh).toEqual(proposal("01P1"));
        expect(fresh?.placeUnique).toBeUndefined(); // a new-place proposal names no place yet
        expect((await store.getProposal("01P2"))?.placeUnique).toBe("P9");
        expect(await store.getProposal("nope")).toBeUndefined();
      });

      it("lists newest-first, filtered, and pages by keyset", async () => {
        await store.createProposal(proposal("01P1"));
        await store.createProposal(proposal("01P2", { proposedBy: OTHER }));
        await store.createProposal(proposal("01P3", { status: "approved" }));

        // Newest (highest ULID) first.
        expect((await store.listProposals({}, 10)).map((p) => p.id)).toEqual([
          "01P3",
          "01P2",
          "01P1",
        ]);
        expect((await store.listProposals({ status: "pending" }, 10)).map((p) => p.id)).toEqual([
          "01P2",
          "01P1",
        ]);
        // The actor-scoped read a contributor gets: only their own rows.
        expect((await store.listProposals({ proposedBy: OTHER }, 10)).map((p) => p.id)).toEqual([
          "01P2",
        ]);
        expect(
          (await store.listProposals({ status: "pending", proposedBy: OTHER }, 10)).map(
            (p) => p.id,
          ),
        ).toEqual(["01P2"]);

        // Keyset: the cursor is the last id of the prior page, and paging is exhaustive.
        const first = await store.listProposals({}, 2);
        expect(first.map((p) => p.id)).toEqual(["01P3", "01P2"]);
        const second = await store.listProposals({}, 2, first[1]?.id);
        expect(second.map((p) => p.id)).toEqual(["01P1"]);
        expect(await store.listProposals({}, 2, "01P1")).toEqual([]);
      });

      it("counts only the given DID's pending rows", async () => {
        await store.createProposal(proposal("01P1"));
        await store.createProposal(proposal("01P2"));
        await store.createProposal(proposal("01P3", { status: "approved" })); // reviewed — not pending
        await store.createProposal(proposal("01P4", { proposedBy: OTHER }));

        expect(await store.countPendingByDid(TEST_ADMIN)).toBe(2);
        expect(await store.countPendingByDid(OTHER)).toBe(1);
        expect(await store.countPendingByDid("did:key:zNobody")).toBe(0);
      });

      it("a review stamps a pending row once — a second decision cannot clobber the first", async () => {
        await store.createProposal(proposal("01P1"));
        const review = {
          status: "approved" as const,
          reviewedBy: TEST_ADMIN,
          reviewedAt: T1,
          appliedPlace: "01P1",
        };

        expect(await store.updateProposal("01P1", review)).toBe(1);
        const stamped = await store.getProposal("01P1");
        expect(stamped?.status).toBe("approved");
        expect(stamped?.reviewedBy).toBe(TEST_ADMIN);
        expect(stamped?.appliedPlace).toBe("01P1");
        expect(stamped?.reviewReason).toBeUndefined();

        // Already terminal: no rows flip, and the original decision stands.
        expect(
          await store.updateProposal("01P1", {
            status: "rejected",
            reviewedBy: OTHER,
            reviewedAt: T1,
            reviewReason: "too late",
          }),
        ).toBe(0);
        expect((await store.getProposal("01P1"))?.status).toBe("approved");
        expect(await store.updateProposal("missing", review)).toBe(0);
      });
    });

    /**
     * Every text order the store returns is byte order (`0023_byte_order`), which is what the fake's
     * `<` gives. Each case below has one pair that a linguistic collation, like the stock image's
     * en_US, orders the other way: it folds case (`b` before `C`) and skips punctuation (`ab` before
     * `a:z`). The pairs go in the linguistic order first, so a twin returning insertion order fails too.
     */
    describe("byte order", () => {
      it("queryByCells orders and pages uniques by byte", async () => {
        await store.commitPlace(place("Pb"), source("Pb"), ["9q8yyk"], []);
        await store.commitPlace(place("PC"), source("PC"), ["9q8yyk"], []);
        const first = await store.queryByCells(["9q8"], undefined, 1);
        expect(first.places.map((p) => p.unique)).toEqual(["PC"]);
        const next = await store.queryByCells(["9q8"], undefined, 1, "PC");
        expect(next.places.map((p) => p.unique)).toEqual(["Pb"]);
        expect(next.truncated).toBe(false);
      });

      it("attributionsForPlaces sorts the credit lines by byte", async () => {
        await store.commitPlace(place("P1"), source("P1", { attribution: "zb" }), ["9q8yyk"], []);
        await store.commitPlace(place("P2"), source("P2", { attribution: "zC" }), ["9q8yyk"], []);
        expect(await store.attributionsForPlaces(["P1", "P2"])).toEqual(["zC", "zb"]);
      });

      // Byte order, not UTF-16 code-unit order (`<`): a fullwidth form (U+FF08) sorts before an
      // emoji in UTF-8 bytes and after it in UTF-16, which spells the emoji with surrogates.
      it("attributionsForPlaces sorts past the BMP by byte, not by UTF-16 code unit", async () => {
        const emoji = "\u{1F30D} OSM";
        const fullwidth = "（株） Zenrin";
        await store.commitPlace(place("P1"), source("P1", { attribution: emoji }), ["9q8yyk"], []);
        await store.commitPlace(
          place("P2"),
          source("P2", { attribution: fullwidth }),
          ["9q8yyk"],
          [],
        );
        expect(await store.attributionsForPlaces(["P1", "P2"])).toEqual([fullwidth, emoji]);
      });

      it("placeUniquesForSourceIds picks the byte-first source", async () => {
        await store.commitPlace(place("P1"), source("P1", { source: "ab" }), ["9q8yyk"], []);
        await store.commitPlace(
          place("P2"),
          source("P2", { source: "a:z", sourceId: "node/P1" }),
          ["9q8yyk"],
          [],
        );
        expect((await store.placeUniquesForSourceIds(["node/P1"]))[0]?.placeUnique).toBe("P2");
      });

      it("listProposals orders and pages ids by byte, newest first", async () => {
        await store.createProposal(proposal("01PC"));
        await store.createProposal(proposal("01Pb"));
        expect((await store.listProposals({}, 10)).map((p) => p.id)).toEqual(["01Pb", "01PC"]);
        expect((await store.listProposals({}, 10, "01Pb")).map((p) => p.id)).toEqual(["01PC"]);
      });

      it("a place's contributors come back by DID in byte order", async () => {
        const approved = { status: "approved" as const, credit: true, appliedPlace: "P1" };
        await store.createProposal(proposal("01P1", { ...approved, proposedBy: "did:key:zb" }));
        await store.createProposal(proposal("01P2", { ...approved, proposedBy: "did:key:zC" }));
        const dids = ["did:key:zC", "did:key:zb"];
        expect((await store.creditedContributionsFor("P1")).map((c) => c.did)).toEqual(dids);
        expect((await store.approvedContributionsForPlaces(["P1"])).map((c) => c.did)).toEqual(
          dids,
        );
      });

      it("listAtlasPublishers orders volumes by byte", async () => {
        await store.pinAtlasPublisher("zb", "did:key:zA", T0, TEST_ADMIN);
        await store.pinAtlasPublisher("zC", "did:key:zA", T0, TEST_ADMIN);
        expect((await store.listAtlasPublishers()).map((p) => p.volume)).toEqual(["zC", "zb"]);
      });
    });
  });
}

/**
 * The Postgres twin, against a live database (`BEACON_TEST_DATABASE_URL`). The driver differences
 * it hides are real (bigint `COUNT(*)` arriving as a string, `rowCount`, json-vs-text column
 * decoding), and none of them can fail on the memory fake. Only the places tables are cleared, so a
 * shared test database stays usable by the other suites.
 */
const PLACES_TABLES = [
  "places",
  "place_sources",
  "place_cells",
  "place_snapshots",
  "place_conflicts",
  "place_proposals",
  "atlas_publishers",
];

/**
 * The twin suite above already drives `%` and `9q8%` through both stores. What it cannot show
 * is the length cap `isGeohash` brought: an over-long prefix matched no row before it was dropped
 * either, so only the filter itself can say it is now refused rather than merely fruitless.
 */
describe("validCellPrefixes", () => {
  it("drops what a geohash cannot be, including one longer than the wire's own bound", () => {
    const twelve = "b".repeat(12);
    expect(validCellPrefixes([twelve, "9q8yyk", "", "a", "9Q8", "b".repeat(13)])).toEqual([
      twelve,
      "9q8yyk",
    ]);
  });
});

placeStoreSuite("memory", () => new MemoryPlaceStore());

const pg = pgTwin((pool) => new PgPlaceStore(pool), PLACES_TABLES);
placeStoreSuite("postgres", async () => {
  await pg.reset();
  return pg.open();
});
