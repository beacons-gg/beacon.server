/**
 * The places operator routes write the same `{op, actor, target}` audit line as the other admin
 * routes (`doc/spec/admin-api.md` §3): one line per write, none for a replayed nonce, none for a
 * signed read.
 */
import { Logger } from "@nestjs/common";
import { ulid } from "ulid";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { placesHarness, signedEnv } from "./test-helpers";

describe("places operator audit lines", () => {
  let lines: string[];

  beforeEach(() => {
    lines = [];
    vi.spyOn(Logger.prototype, "log").mockImplementation(function (this: Logger, msg: unknown) {
      if ((this as unknown as { context?: string }).context === "Admin") lines.push(String(msg));
    });
  });

  afterEach(() => vi.restoreAllMocks());

  it("logs a create and an edit once each, and not again on a replayed nonce", async () => {
    const { controller, admin } = placesHarness();
    const did = admin.account.did;
    const create = signedEnv(admin, "places.create", {
      category: "park",
      point: { lat: 47.61, lng: -122.33 },
    });
    const { place } = await controller.createPlace(create);
    await controller.createPlace(create); // the same nonce: a retry, not a second write

    await controller.edit(
      signedEnv(admin, "places.edit", { unique: place.unique, set: { name: "Pocket Park" } }),
    );

    expect(lines).toEqual([
      `places.create actor=${did} target=${place.unique}`,
      `places.edit actor=${did} target=${place.unique}`,
    ]);
  });

  it("logs an unpin with whether it removed anything, and a conflicts resolve with its count", async () => {
    const { controller, admin } = placesHarness();
    const did = admin.account.did;
    await controller.atlasUnpin(signedEnv(admin, "places.atlas.unpin", { volume: "us-west" }));
    const id = ulid();
    await controller.conflictsResolve(signedEnv(admin, "places.conflicts.resolve", { ids: [id] }));

    expect(lines).toEqual([
      `places.atlas.unpin actor=${did} target=us-west removed=false`,
      `places.conflicts.resolve actor=${did} target=${id} resolved=0`,
    ]);
  });

  it("logs nothing for a signed read", async () => {
    const { controller, admin } = placesHarness();
    await controller.fetch(signedEnv(admin, "places.snapshots.fetch", {}));
    await controller.atlasPins(signedEnv(admin, "places.atlas.pins.fetch", {}));
    expect(lines).toEqual([]);
  });
});
