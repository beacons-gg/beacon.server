import { placeCategorySchema } from "@beaconsgg/protocol-types";
import { beforeEach, describe, expect, it } from "vitest";
import { OSM_TAG_MAP, subcategoryOf } from "@beaconsgg/place-taxonomy";
import { PlacesController } from "../places/places.controller";
import { PlacesService, type PlacesConfig } from "../places/places.service";
import { MemoryPlaceStore } from "./memory-stores";
import { PLACE_T0 as T0, makePlace, makeSource, statusOf } from "./test-helpers";
const CFG: PlacesConfig = { enabled: true, cellPrecision: 6, pageSize: 3, queryMaxCells: 4 };

const parkGeometry = {
  type: "Polygon" as const,
  coordinates: [
    [
      [-122.34, 47.6],
      [-122.32, 47.6],
      [-122.32, 47.62],
      [-122.34, 47.62],
      [-122.34, 47.6],
    ] as [number, number][],
  ],
};

describe("places read path — the owned dataset (`doc/spec/places.md` §5)", () => {
  let store: MemoryPlaceStore;
  let controller: PlacesController;

  beforeEach(async () => {
    store = new MemoryPlaceStore();
    controller = new PlacesController(new PlacesService(store, CFG));
    await store.commitPlace(
      makePlace("01AAAAAAAAAAAAAAAAAAAAAAAA"),
      makeSource("01AAAAAAAAAAAAAAAAAAAAAAAA"),
      ["c23nb6"],
      [],
    );
    await store.commitPlace(
      makePlace("01BBBBBBBBBBBBBBBBBBBBBBBB", {
        category: "park",
        geometry: parkGeometry,
        description: "A large city park.",
      }),
      makeSource("01BBBBBBBBBBBBBBBBBBBBBBBB", { sourceId: "way/7" }),
      ["c23nb7"],
      [],
    );
  });

  it("serves summaries (light: hasGeometry/hasDescription flags, no polygon or text) with derived attribution", async () => {
    const out = await controller.query("c23nb", undefined);
    expect(out.places).toHaveLength(2);
    const park = out.places.find((p) => p.category === "park");
    expect(park?.hasGeometry).toBe(true);
    // The list projects the long text to a flag — the boolean rides, the text doesn't.
    expect(park?.hasDescription).toBe(true);
    expect(park && "geometry" in park).toBe(false);
    expect(park && "description" in park).toBe(false);
    // A place with neither geometry nor description reads false on both.
    const shop = out.places.find((p) => p.category === "sweets");
    expect(shop?.hasGeometry).toBe(false);
    expect(shop?.hasDescription).toBe(false);
    expect(out.attribution).toEqual(["© OpenStreetMap contributors (ODbL)"]);
    expect(out.truncated).toBe(false);
  });

  it("filters categories; coarsens finer-than-index cells; caps the cell list", async () => {
    const parks = await controller.query("c23nb", "park");
    expect(parks.places.map((p) => p.category)).toEqual(["park"]);

    // A precision-9 input cell still finds the precision-6 index (coarsened, not rejected).
    const fine = await controller.query("c23nb6xyz", "sweets");
    expect(fine.places).toHaveLength(1);

    expect(await statusOf(controller.query("c23nb,c23nc,c23nd,c23ne,c23nf", undefined))).toBe(400);
    // The coarseness floor (cellPrecision - 2 = 4): a near-world prefix is rejected, not scanned.
    expect(await statusOf(controller.query("c23", undefined))).toBe(400);
    expect(await statusOf(controller.query(undefined, undefined))).toBe(400);
    expect(await statusOf(controller.query("c23nb", "bar-crawl"))).toBe(400);
  });

  it("marks truncation explicitly at the page size, and returns a keyset cursor", async () => {
    for (const u of ["01CCCCCCCCCCCCCCCCCCCCCCCC", "01DDDDDDDDDDDDDDDDDDDDDDDD"]) {
      await store.commitPlace(makePlace(u, { name: `Place ${u}` }), makeSource(u), ["c23nb6"], []);
    }
    const out = await controller.query("c23nb", undefined);
    expect(out.places).toHaveLength(3); // pageSize
    expect(out.truncated).toBe(true);
    expect(out.cursor).toBe(out.places[2]?.unique); // the last row's unique
  });

  it("a spread page is truncated without a cursor, and refuses one", async () => {
    for (const u of ["01CCCCCCCCCCCCCCCCCCCCCCCC", "01DDDDDDDDDDDDDDDDDDDDDDDD"]) {
      await store.commitPlace(makePlace(u, { name: `Place ${u}` }), makeSource(u), ["c23nb6"], []);
    }
    const spread = (cursor: string | undefined, flag: string) =>
      controller.query("c23nb", undefined, cursor, undefined, flag);
    const out = await spread(undefined, "1");
    expect(out.places).toHaveLength(3);
    expect(out.truncated).toBe(true);
    expect(out.cursor).toBeUndefined();
    expect(await statusOf(spread(out.places[0]!.unique, "1"))).toBe(400);
    expect(await statusOf(spread(undefined, "yes"))).toBe(400);
  });

  it("walks pages by cursor; the last page drops truncated + cursor", async () => {
    for (const u of ["01CCCCCCCCCCCCCCCCCCCCCCCC", "01DDDDDDDDDDDDDDDDDDDDDDDD"]) {
      await store.commitPlace(makePlace(u, { name: `Place ${u}` }), makeSource(u), ["c23nb6"], []);
    }
    // Two AAAA/BBBB + two CCCC/DDDD = 4 places in the cell; pageSize is 3.
    const page1 = await controller.query("c23nb", undefined);
    expect(page1.places.map((p) => p.unique)).toEqual([
      "01AAAAAAAAAAAAAAAAAAAAAAAA",
      "01BBBBBBBBBBBBBBBBBBBBBBBB",
      "01CCCCCCCCCCCCCCCCCCCCCCCC",
    ]);
    const page2 = await controller.query("c23nb", undefined, page1.cursor);
    expect(page2.places.map((p) => p.unique)).toEqual(["01DDDDDDDDDDDDDDDDDDDDDDDD"]);
    expect(page2.truncated).toBe(false);
    expect(page2.cursor).toBeUndefined();
  });

  it("honors a smaller `limit` (clamped to the page size) and rejects bad paging params", async () => {
    const small = await controller.query("c23nb", undefined, undefined, "1");
    expect(small.places).toHaveLength(1);
    expect(small.truncated).toBe(true);
    // limit above the page size is clamped, not an error.
    expect((await controller.query("c23nb", undefined, undefined, "999")).places).toHaveLength(2);

    expect(await statusOf(controller.query("c23nb", undefined, "not-a-ulid"))).toBe(400);
    expect(await statusOf(controller.query("c23nb", undefined, undefined, "0"))).toBe(400);
    expect(await statusOf(controller.query("c23nb", undefined, undefined, "2.5"))).toBe(400);
  });

  it("serves detail with geometry + provenance; 404s unknown, retired, and non-ULIDs 400", async () => {
    const detail = await controller.detail("01BBBBBBBBBBBBBBBBBBBBBBBB");
    expect(detail.geometry).toEqual(parkGeometry);
    expect(detail.sources).toEqual([
      { source: "osm", attribution: "© OpenStreetMap contributors (ODbL)" },
    ]);

    expect(await statusOf(controller.detail("01EEEEEEEEEEEEEEEEEEEEEEEE"))).toBe(404);
    expect(await statusOf(controller.detail("not-a-ulid"))).toBe(400);
    await store.retirePlace("01BBBBBBBBBBBBBBBBBBBBBBBB", T0);
    expect(await statusOf(controller.detail("01BBBBBBBBBBBBBBBBBBBBBBBB"))).toBe(404);
  });

  it("404s everything when the capability is off", async () => {
    const off = new PlacesController(new PlacesService(store, { ...CFG, enabled: false }));
    expect(await statusOf(off.query("c23nb", undefined))).toBe(404);
    expect(await statusOf(off.detail("01AAAAAAAAAAAAAAAAAAAAAAAA"))).toBe(404);
    expect(() => off.taxonomy()).toThrow();
  });
});

describe("GET /places/taxonomy — the contribution vocabulary (`doc/spec/place-proposals.md` §4.2)", () => {
  const controller = new PlacesController(new PlacesService(new MemoryPlaceStore(), CFG));

  it("publishes every category, with slugs the connectors actually produce", () => {
    const { categories } = controller.taxonomy();

    // Every wire category is represented — a contributor can pick any of them.
    expect(categories.map((c) => c.category).sort()).toEqual(
      [...placeCategorySchema.options].sort(),
    );
    // …and every published slug is one some tag-map entry emits. This is the golden that fails if
    // the vocabulary and the tag map ever drift apart.
    const produced = new Set(OSM_TAG_MAP.map((e) => `${e.category}/${subcategoryOf(e)}`));
    for (const { category, subcategories } of categories) {
      expect(subcategories.length).toBeGreaterThan(0);
      for (const slug of subcategories) expect(produced.has(`${category}/${slug}`)).toBe(true);
    }
    // Spot-check the namespacing that makes the PAIR the meaningful unit, not the slug.
    const water = categories
      .filter((c) => c.subcategories.includes("water"))
      .map((c) => c.category);
    expect(water.sort()).toEqual(["nature", "transport"]);
  });

  it("is stable across calls, and callers can't mutate the shared constant through it", () => {
    expect(controller.taxonomy()).toEqual(controller.taxonomy());
    controller.taxonomy().categories[0]!.subcategories.push("injected");
    expect(controller.taxonomy().categories[0]?.subcategories).not.toContain("injected");
  });

  it("is declared before the :unique route, so Nest can't swallow it", () => {
    // Nest matches in declaration order and `"taxonomy"` fails the ULID parse, so a param route
    // declared first would 400 this path instead of serving it.
    const methods = Object.getOwnPropertyNames(PlacesController.prototype);
    expect(methods.indexOf("taxonomy")).toBeLessThan(methods.indexOf("detail"));
  });
});
