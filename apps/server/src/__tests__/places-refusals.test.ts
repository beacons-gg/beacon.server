import { placeDetailSchema } from "@beaconsgg/protocol-types";
import { ulid } from "ulid";
import { describe, expect, it } from "vitest";
import { PlacesController } from "../places/places.controller";
import {
  makePlace,
  makeSource,
  placesHarness,
  rejectedWith,
  signedEnv,
  type TestWallet,
} from "./test-helpers";

/**
 * The places surfaces answer the way every other signed route does: bad params as one 400 that
 * names the keys this server does not know, a missing thing as a 404 that names what is missing
 * (`unknownRoute` stays for a route that is off), and the operator's place writes as the wire's
 * `PlaceDetail` rather than the store's record.
 */

const U1 = "01AAAAAAAAAAAAAAAAAAAAAAAA";
const MISSING = "01ZZZZZZZZZZZZZZZZZZZZZZZZ";

/** A harness with one active place, `U1`, in it. */
async function withPlace(opts: Parameters<typeof placesHarness>[0] = {}) {
  const h = placesHarness(opts);
  await h.store.commitPlace(makePlace(U1), makeSource(U1), ["c23nb6"], []);
  return h;
}

/** The status and body a call refuses with. */
async function refusal(fn: () => unknown): Promise<{ status: number; body: unknown }> {
  const err = await rejectedWith(fn);
  return { status: err.getStatus(), body: err.getResponse() };
}

const op = (w: TestWallet, name: string, params: Record<string, unknown>) =>
  signedEnv(w, name, params, ulid(), null);

describe("bad params on the places admin writes", () => {
  it("name an unknown key in `fields`, on every write that parses params", async () => {
    const { controller, admin } = await withPlace();
    const extra = { newerField: 1 };
    const calls: Array<() => unknown> = [
      () => controller.edit(op(admin, "places.edit", { unique: U1, set: { name: "X" }, ...extra })),
      () =>
        controller.createPlace(
          op(admin, "places.create", { category: "park", point: { lat: 1, lng: 2 }, ...extra }),
        ),
      () => controller.cancel(op(admin, "places.snapshot.cancel", { id: ulid(), ...extra })),
      () => controller.atlasUnpin(op(admin, "places.atlas.unpin", { volume: "v", ...extra })),
      () =>
        controller.conflictsResolve(
          op(admin, "places.conflicts.resolve", { ids: [ulid()], ...extra }),
        ),
      () =>
        controller.proposalsReview(
          op(admin, "places.proposals.review", { id: ulid(), decision: "reject", ...extra }),
        ),
      () => controller.retireSource(op(admin, "places.source.retire", { source: "osm", ...extra })),
    ];
    for (const call of calls) {
      expect(await refusal(call)).toEqual({
        status: 400,
        body: expect.objectContaining({ ok: false, error: "invalid", fields: ["newerField"] }),
      });
    }
  });

  it("keep the same 400 without `fields` when something else is wrong", async () => {
    const { controller, admin } = await withPlace();
    const { status, body } = await refusal(() =>
      controller.edit(op(admin, "places.edit", { unique: 7 })),
    );
    expect(status).toBe(400);
    expect(body).toMatchObject({ ok: false, error: "invalid" });
    expect(body).not.toHaveProperty("fields");
  });
});

describe("a missing thing names itself", () => {
  it("answers unknownPlace, unknownRun and unknownProposal, each a 404", async () => {
    const { controller, admin } = await withPlace();
    expect(
      await refusal(() =>
        controller.edit(op(admin, "places.edit", { unique: MISSING, set: { name: "X" } })),
      ),
    ).toMatchObject({ status: 404, body: { error: "unknownPlace" } });
    expect(
      await refusal(() => controller.cancel(op(admin, "places.snapshot.cancel", { id: ulid() }))),
    ).toMatchObject({ status: 404, body: { error: "unknownRun" } });
    expect(
      await refusal(() =>
        controller.proposalsReview(
          op(admin, "places.proposals.review", { id: ulid(), decision: "reject" }),
        ),
      ),
    ).toMatchObject({ status: 404, body: { error: "unknownProposal" } });
  });

  it("answers unknownPlace for a public read of an unknown or retired place", async () => {
    const { reads, store } = await withPlace();
    const controller = new PlacesController(reads);
    expect(await refusal(() => controller.detail(MISSING))).toMatchObject({
      status: 404,
      body: { error: "unknownPlace" },
    });
    await store.retirePlace(U1, "2026-07-24T00:00:00.000Z");
    expect(await refusal(() => controller.detail(U1))).toMatchObject({
      status: 404,
      body: { error: "unknownPlace" },
    });
  });

  it("keeps unknownRoute for a surface that is off", async () => {
    const off = placesHarness({ placesEnabled: false });
    expect(
      await refusal(() =>
        off.controller.edit(op(off.admin, "places.edit", { unique: U1, set: { name: "X" } })),
      ),
    ).toMatchObject({ status: 404, body: { error: "unknownRoute" } });
    expect(await refusal(() => new PlacesController(off.reads).detail(U1))).toMatchObject({
      status: 404,
      body: { error: "unknownRoute" },
    });
  });
});

describe("places.create and places.edit answer the wire's PlaceDetail", () => {
  it("as GET /places/:unique reads the same place", async () => {
    const { controller, admin, reads } = await withPlace();
    const edited = await controller.edit(
      op(admin, "places.edit", { unique: U1, set: { name: "Curated" } }),
    );
    expect(placeDetailSchema.parse(edited.place)).toEqual(edited.place);
    expect(edited.place).toEqual(await reads.detail(U1));
    expect(edited.place).not.toHaveProperty("status");
  });
});

describe("the Atlas upload checks the surface before it reads the header", () => {
  /** An upload request with no envelope header at all. */
  const headerless = { headers: {} } as never;

  it("answers 404 unknownRoute with places off, not a 400 for the missing header", async () => {
    const off = placesHarness({ placesEnabled: false });
    expect(await refusal(() => off.controller.atlasUpload(headerless))).toMatchObject({
      status: 404,
      body: { error: "unknownRoute" },
    });
  });

  it("answers 404 unknownRoute with no admins configured", async () => {
    const bare = placesHarness({ admins: [] });
    expect(await refusal(() => bare.controller.atlasUpload(headerless))).toMatchObject({
      status: 404,
      body: { error: "unknownRoute" },
    });
  });

  it("still answers 400 for the missing header once the surface is on", async () => {
    const { controller } = placesHarness();
    expect(await refusal(() => controller.atlasUpload(headerless))).toMatchObject({
      status: 400,
      body: { error: "invalid" },
    });
  });
});
