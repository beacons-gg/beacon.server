import { type PlaceCreateParams, placeDetailSchema } from "@beaconsgg/protocol-types";
import { ulid } from "ulid";
import { describe, expect, it } from "vitest";
import { ADMIN_SOURCE } from "../places/merge";
import { placesHarness, signedEnv, statusOf, type TestWallet } from "./test-helpers";

/**
 * `places.create` — authoring a place by hand (`doc/spec/place-proposals.md` §7). The verb
 * `places.edit` cannot provide: it 404s on an unknown `unique`, so before this a place no connector
 * produced was uncreatable. A created place lands as an `admin` source, so it behaves exactly like
 * an edited one.
 */

const PARAMS: PlaceCreateParams = {
  category: "park",
  subcategory: "park",
  name: "Pocket Park",
  point: { lat: 47.61, lng: -122.33 },
  description: "A bench, three trees, and a very good view of the ferries.",
};

const createEnv = (w: TestWallet, params: Record<string, unknown> = PARAMS, nonce?: string) =>
  signedEnv(w, "places.create", params, nonce);

describe("PlacesAdminController.createPlace (`doc/spec/place-proposals.md` §7)", () => {
  it("mints a place with an admin source record, indexed and queryable", async () => {
    const { controller, admin, store } = placesHarness();

    const { ok, place } = await controller.createPlace(createEnv(admin));
    expect(ok).toBe(true);
    expect(place.category).toBe("park");
    expect(place.name).toBe("Pocket Park");
    expect(place.description).toBe(PARAMS.description);
    // The answer is the wire's `PlaceDetail`, not the store's record.
    expect(placeDetailSchema.parse(place)).toEqual(place);
    expect((await store.getPlace(place.unique))?.status).toBe("active");

    // The values land as an `admin` source (sourceId = the place unique), so they win every merge
    // and the place never auto-retires — identical to an edited place.
    const source = await store.getSource(ADMIN_SOURCE, place.unique);
    expect(source?.placeUnique).toBe(place.unique);
    expect(source?.editedBy).toBe(admin.account.did);
    expect(source?.fields.name).toBe("Pocket Park");

    // Indexed on the point's cell, so an ordinary read finds it.
    const found = await store.queryByCells(["c23"], undefined, 10);
    expect(found.places.map((p) => p.unique)).toEqual([place.unique]);
  });

  it("omits absent optional fields rather than storing explicit undefineds", async () => {
    const { controller, admin, store } = placesHarness();
    const { place } = await controller.createPlace(
      createEnv(admin, { category: "nature", point: { lat: 47.61, lng: -122.33 } }),
    );
    expect(place.name).toBeUndefined();
    expect(place.subcategory).toBeUndefined();
    expect((await store.getSource(ADMIN_SOURCE, place.unique))?.fields).toEqual({
      category: "nature",
      point: { lat: 47.61, lng: -122.33 },
    });
  });

  it("is idempotent by nonce — a retry returns the same place, never a duplicate", async () => {
    const { controller, admin, store } = placesHarness();
    const nonce = ulid();
    const first = await controller.createPlace(createEnv(admin, PARAMS, nonce));
    const retry = await controller.createPlace(createEnv(admin, PARAMS, nonce));

    expect(retry.place.unique).toBe(first.place.unique);
    expect((await store.queryByCells(["c23"], undefined, 10)).places).toHaveLength(1);
  });

  it("a created place is then editable like any other", async () => {
    const { controller, admin, store } = placesHarness();
    const { place } = await controller.createPlace(createEnv(admin));

    const edited = await controller.edit(
      signedEnv(admin, "places.edit", { unique: place.unique, set: { name: "Renamed" } }),
    );
    expect(edited.place.name).toBe("Renamed");
    expect(edited.place.unique).toBe(place.unique);
    // Still one admin record — the edit folded into it rather than creating a rival.
    expect((await store.sourcesForPlace(place.unique)).map((s) => s.source)).toEqual([
      ADMIN_SOURCE,
    ]);
  });

  it("rejects a non-allowlisted signer with 403 and a bad shape with 400", async () => {
    const { controller, admin, stranger } = placesHarness();
    await expect(statusOf(controller.createPlace(createEnv(stranger)))).resolves.toBe(403);
    // `category` is required, and an unknown category is not in the enum.
    await expect(
      statusOf(controller.createPlace(createEnv(admin, { point: { lat: 1, lng: 2 } }))),
    ).resolves.toBe(400);
    await expect(
      statusOf(controller.createPlace(createEnv(admin, { ...PARAMS, category: "speakeasy" }))),
    ).resolves.toBe(400);
  });

  it("404s as absent when the places capability is off", async () => {
    const { controller, admin } = placesHarness({ placesEnabled: false });
    await expect(statusOf(controller.createPlace(createEnv(admin)))).resolves.toBe(404);
  });
});
