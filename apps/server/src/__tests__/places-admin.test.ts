import { createWallet, signOpWithWallet } from "@beaconsgg/identity";
import { ulid } from "ulid";
import { describe, expect, it } from "vitest";
import { makePlace, makeSource, placesHarness, PLACE_T0, statusOf } from "./test-helpers";

type Wallet = ReturnType<typeof createWallet>;
// `places.source.retire` is the representative run-creating op for the gate tests: like the old
// snapshot trigger it is signed + allowlisted + nonce-idempotent, and it enqueues a durable run.
const retireEnv = (w: Wallet, nonce = ulid()) =>
  signOpWithWallet(w, { op: "places.source.retire", nonce, params: { source: "osm" } });
const fetchEnv = (w: Wallet, params: Record<string, unknown> = {}, nonce = ulid()) =>
  signOpWithWallet(w, { op: "places.snapshots.fetch", nonce, params });

describe("PlacesAdminController — signed + allowlisted (`doc/spec/places.md` §6.3)", () => {
  it("enqueues a source-retire run for an allowlisted admin, idempotent by nonce", async () => {
    const { controller, snapshots, admin } = placesHarness();
    const nonce = ulid();
    const first = await controller.retireSource(retireEnv(admin, nonce));
    expect(first.ok).toBe(true);
    expect(first.snapshot.requestedBy).toBe(admin.account.did);

    // Same nonce → the original run, not a second one.
    const retry = await controller.retireSource(retireEnv(admin, nonce));
    expect(retry.snapshot.id).toBe(first.snapshot.id);
    await snapshots.idle();

    const listed = await controller.fetch(fetchEnv(admin));
    expect(listed.snapshots.map((s) => s.id)).toEqual([first.snapshot.id]);
    const byId = await controller.fetch(fetchEnv(admin, { id: first.snapshot.id }));
    expect(byId.snapshots[0]?.status).toBe("done");
  });

  it("403s a verified non-admin; 404s when the capability is off; 400s bad params", async () => {
    const { controller, stranger, admin } = placesHarness();
    expect(await statusOf(controller.retireSource(retireEnv(stranger)))).toBe(403);

    const off = placesHarness({ placesEnabled: false });
    expect(await statusOf(off.controller.retireSource(retireEnv(off.admin)))).toBe(404);

    // No admins configured ⇒ the surface looks absent (404, not 403) even with the capability on.
    const bare = placesHarness({ admins: [] });
    expect(await statusOf(bare.controller.retireSource(retireEnv(bare.admin)))).toBe(404);

    const bad = signOpWithWallet(admin, {
      op: "places.source.retire",
      nonce: ulid(),
      params: {}, // no source
    });
    expect(await statusOf(controller.retireSource(bad))).toBe(400);
    // A living input is a parameter rejection too — the service half is pinned in the snapshot suite.
    const living = signOpWithWallet(admin, {
      op: "places.source.retire",
      nonce: ulid(),
      params: { source: "atlas:us-west" },
    });
    expect(await statusOf(controller.retireSource(living))).toBe(400);
    expect(
      await statusOf(controller.retireSource(fetchEnv(admin))), // wrong op for the route
    ).toBe(400);
  });

  it("rejects a tampered envelope and a replayed fetch nonce", async () => {
    const { controller, admin } = placesHarness();
    const env = retireEnv(admin);
    const tampered = { ...env, params: { source: "mapbox" } };
    expect(await statusOf(controller.retireSource(tampered))).toBe(401);

    const nonce = ulid();
    await controller.fetch(fetchEnv(admin, {}, nonce));
    expect(await statusOf(controller.fetch(fetchEnv(admin, {}, nonce)))).toBe(409);
  });
});

describe("PlacesAdminController — export / import (`doc/spec/places.md` §7)", () => {
  const exportEnv = (w: Wallet, params: Record<string, unknown> = {}, nonce = ulid()) =>
    signOpWithWallet(w, { op: "places.export", nonce, params });
  const importEnv = (w: Wallet, params: Record<string, unknown>, nonce = ulid()) =>
    signOpWithWallet(w, { op: "places.import", nonce, params });
  const oneFeatureCollection = {
    type: "FeatureCollection",
    beacon: { profile: "beacon-places/1" },
    features: [
      {
        type: "Feature",
        geometry: { type: "Point", coordinates: [-122.33, 47.61] },
        properties: {
          unique: "01AAAAAAAAAAAAAAAAAAAAAAAA",
          category: "sweets",
          point: { lat: 47.61, lng: -122.33 },
        },
      },
    ],
  };

  it("exports for an admin (signed read: a replayed nonce is rejected)", async () => {
    const { controller, admin } = placesHarness();
    const nonce = ulid();
    const out = await controller.export(exportEnv(admin, {}, nonce));
    expect(out.collection.beacon.profile).toBe("beacon-places/1");
    expect(await statusOf(controller.export(exportEnv(admin, {}, nonce)))).toBe(409);
  });

  it("imports for an admin (idempotent by nonce); 403s a stranger; 400s a bad list name", async () => {
    const { controller, snapshots, admin, stranger } = placesHarness();
    const nonce = ulid();
    const params = { name: "parks", collection: oneFeatureCollection };
    const first = await controller.import(importEnv(admin, params, nonce));
    expect(first.snapshot.source).toBe("list:parks");
    const retry = await controller.import(importEnv(admin, params, nonce));
    expect(retry.snapshot.id).toBe(first.snapshot.id);
    await snapshots.idle();
    expect((await snapshots.getSnapshot(first.snapshot.id))?.status).toBe("done");

    expect(await statusOf(controller.import(importEnv(stranger, params)))).toBe(403);
    expect(
      await statusOf(controller.import(importEnv(admin, { ...params, name: "Bad Name!" }))),
    ).toBe(400);
  });
});

describe("PlacesAdminController — edit + conflicts (`doc/spec/places.md` §6.3)", () => {
  const editEnv = (w: Wallet, params: Record<string, unknown>, nonce = ulid()) =>
    signOpWithWallet(w, { op: "places.edit", nonce, params });

  it("edits for an admin (idempotent by nonce), 404s an unknown place, 400s an empty edit", async () => {
    const { controller, admin, store } = placesHarness();
    const U1 = "01AAAAAAAAAAAAAAAAAAAAAAAA";
    await store.commitPlace(makePlace(U1), makeSource(U1), ["c23nb6"], []);

    const nonce = ulid();
    const first = await controller.edit(
      editEnv(admin, { unique: U1, set: { name: "Curated" } }, nonce),
    );
    expect(first.place.name).toBe("Curated");
    const retry = await controller.edit(
      editEnv(admin, { unique: U1, set: { name: "Curated" } }, nonce),
    );
    expect(retry.place.unique).toBe(U1);

    expect(
      await statusOf(
        controller.edit(
          editEnv(admin, { unique: "01ZZZZZZZZZZZZZZZZZZZZZZZZ", set: { name: "X" } }),
        ),
      ),
    ).toBe(404);
    expect(await statusOf(controller.edit(editEnv(admin, { unique: U1 })))).toBe(400); // nothing to do
  });

  it("fetches the conflict queue (replay-rejected) and resolves idempotently", async () => {
    const { controller, admin, store } = placesHarness();
    const U1 = "01AAAAAAAAAAAAAAAAAAAAAAAA";
    await store.commitPlace(
      makePlace(U1),
      makeSource(U1),
      ["c23nb6"],
      [
        {
          id: "01CCCCCCCCCCCCCCCCCCCCCCCC",
          placeUnique: U1,
          field: "name",
          incomingValue: "Fresh",
          source: "osm",
          createdAt: PLACE_T0,
        },
      ],
    );

    const fetchEnv2 = (nonce = ulid()) =>
      signOpWithWallet(admin, { op: "places.conflicts.fetch", nonce, params: {} });
    const nonce = ulid();
    const listed = await controller.conflictsFetch(fetchEnv2(nonce));
    expect(listed.conflicts).toHaveLength(1);
    expect(await statusOf(controller.conflictsFetch(fetchEnv2(nonce)))).toBe(409);

    const resolveEnv = (n = ulid()) =>
      signOpWithWallet(admin, {
        op: "places.conflicts.resolve",
        nonce: n,
        params: { ids: ["01CCCCCCCCCCCCCCCCCCCCCCCC"] },
      });
    const rn = ulid();
    expect((await controller.conflictsResolve(resolveEnv(rn))).resolved).toBe(1);
    expect((await controller.conflictsResolve(resolveEnv(rn))).resolved).toBe(1); // nonce-idempotent
    expect((await controller.conflictsResolve(resolveEnv())).resolved).toBe(0); // already flipped
  });
});
