import { beforeEach, describe, expect, it } from "vitest";
import { PlacesAdminService } from "../places/admin.service";
import { ADMIN_SOURCE } from "../places/merge";
import {
  PLACE_T0 as T0,
  makeClock,
  makePlace,
  makeSource,
  TEST_ADMIN as ADMIN,
} from "./test-helpers";
import { MemoryPlaceStore } from "./memory-stores";

const U1 = "01AAAAAAAAAAAAAAAAAAAAAAAA";

describe("PlacesAdminService.edit — per-field curation (`doc/spec/places.md` §3.1)", () => {
  let store: MemoryPlaceStore;
  let service: PlacesAdminService;
  let clock: ReturnType<typeof makeClock>;

  beforeEach(async () => {
    store = new MemoryPlaceStore();
    clock = makeClock();
    service = new PlacesAdminService(
      store,
      { host: "test.example", cellPrecision: 6, contribExportEnabled: false },
      clock.now,
    );
    await store.commitPlace(
      makePlace(U1, { name: "OSM Name" }),
      makeSource(U1, {
        fields: { category: "sweets", name: "OSM Name", point: { lat: 47.61, lng: -122.33 } },
      }),
      ["c23nb6"],
      [],
    );
  });

  it("set makes a field admin-held: canonical updates, the admin record carries the audit", async () => {
    const place = await service.edit(U1, { name: "Curated" }, [], ADMIN);
    expect(place?.name).toBe("Curated");
    expect(place?.category).toBe("sweets"); // untouched fields keep flowing from osm

    const admin = await store.getSource(ADMIN_SOURCE, U1);
    expect(admin?.fields).toEqual({ name: "Curated" });
    expect(admin?.editedBy).toBe(ADMIN);
    // The place stays queryable (cells re-indexed from the point).
    expect((await store.queryByCells(["c23"], undefined, 10)).places).toHaveLength(1);
  });

  it("clear releases the override: the connector value flows back immediately", async () => {
    await service.edit(U1, { name: "Curated" }, [], ADMIN);
    clock.advanceSeconds(60);
    const place = await service.edit(U1, {}, ["name"], ADMIN);
    expect(place?.name).toBe("OSM Name"); // the osm record kept its fields all along
    // Last override → the admin record is retired (goneAt) — no hard deletes in this store.
    expect((await store.getSource(ADMIN_SOURCE, U1))?.goneAt).toBeDefined();
  });

  it("a partial clear keeps the record; a re-edit revives a cleared one", async () => {
    await service.edit(U1, { name: "Curated", category: "landmark" }, [], ADMIN);
    const partial = await service.edit(U1, {}, ["category"], ADMIN);
    expect(partial?.name).toBe("Curated");
    expect(partial?.category).toBe("sweets");
    expect((await store.getSource(ADMIN_SOURCE, U1))?.fields).toEqual({ name: "Curated" });

    await service.edit(U1, {}, ["name"], ADMIN); // record fully cleared
    const revived = await service.edit(U1, { name: "Again" }, [], ADMIN);
    expect(revived?.name).toBe("Again");
    expect((await store.getSource(ADMIN_SOURCE, U1))?.goneAt).toBeUndefined();
  });

  it("clearing the last override on a source-less place retires it", async () => {
    // Retire the osm record first — the admin override is the only thing keeping the place alive.
    await store.setSourceGone("osm", `node/${U1}`, T0);
    await service.edit(U1, { name: "Pinned" }, [], ADMIN);
    expect((await store.getPlace(U1))?.status).toBe("active");

    const after = await service.edit(U1, {}, ["name"], ADMIN);
    expect(after?.status).toBe("retired");
  });

  it("editing a retired place re-activates it (curation implies intent)", async () => {
    await store.retirePlace(U1, T0);
    const place = await service.edit(U1, { name: "Back" }, [], ADMIN);
    expect(place?.status).toBe("active");
    expect((await store.queryByCells(["c23"], undefined, 10)).places).toHaveLength(1);
  });

  it("returns undefined for an unknown place", async () => {
    expect(
      await service.edit("01ZZZZZZZZZZZZZZZZZZZZZZZZ", { name: "X" }, [], ADMIN),
    ).toBeUndefined();
  });
});

describe("PlacesAdminService conflicts — the review queue", () => {
  it("lists unresolved-first and resolve flips rows exactly once", async () => {
    const store = new MemoryPlaceStore();
    const clock = makeClock();
    const service = new PlacesAdminService(
      store,
      { host: "test.example", cellPrecision: 6, contribExportEnabled: false },
      clock.now,
    );
    await store.commitPlace(
      makePlace(U1),
      makeSource(U1),
      ["c23nb6"],
      [
        {
          id: "01CCCCCCCCCCCCCCCCCCCCCCCC",
          placeUnique: U1,
          field: "name",
          currentValue: "Curated",
          incomingValue: "Fresh",
          source: "osm",
          createdAt: T0,
        },
      ],
    );

    expect(await service.listConflicts(U1)).toHaveLength(1);
    expect(await service.listConflicts("01ZZZZZZZZZZZZZZZZZZZZZZZZ")).toHaveLength(0);

    expect(await service.resolveConflicts(["01CCCCCCCCCCCCCCCCCCCCCCCC"])).toBe(1);
    expect(await service.resolveConflicts(["01CCCCCCCCCCCCCCCCCCCCCCCC"])).toBe(0); // idempotent
    const [conflict] = await service.listConflicts(U1);
    expect(conflict?.resolvedAt).toBeDefined();
  });

  it("an edit that touches a conflicted field auto-resolves those rows (adopt/drop IS resolution)", async () => {
    const store = new MemoryPlaceStore();
    const service = new PlacesAdminService(
      store,
      { host: "test.example", cellPrecision: 6, contribExportEnabled: false },
      makeClock().now,
    );
    await store.commitPlace(
      makePlace(U1),
      makeSource(U1),
      ["c23nb6"],
      [
        {
          id: "01DDDDDDDDDDDDDDDDDDDDDDDD",
          placeUnique: U1,
          field: "name",
          currentValue: "Curated",
          incomingValue: "Fresh OSM Name",
          source: "osm",
          createdAt: T0,
        },
        {
          id: "01EEEEEEEEEEEEEEEEEEEEEEEE",
          placeUnique: U1,
          field: "media",
          incomingValue: [],
          source: "osm",
          createdAt: T0,
        },
      ],
    );

    await service.edit(U1, { name: "Adopted Fresh Name" }, [], ADMIN);
    const conflicts = await service.listConflicts(U1);
    expect(conflicts.find((c) => c.field === "name")?.resolvedAt).toBeDefined();
    expect(conflicts.find((c) => c.field === "media")?.resolvedAt).toBeUndefined(); // untouched stays pending
  });
});
