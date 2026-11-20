import { createWallet, signOpWithWallet } from "@beaconsgg/identity";
import { InMemoryStore } from "@beaconsgg/policy-engine/testing";
import { adminStatusSchema, type DidKey, type ProfileDoc } from "@beaconsgg/protocol-types";
import { ulid } from "ulid";
import { describe, expect, it } from "vitest";
import { AdminController } from "../admin/admin.controller";
import { AdminService } from "../admin/admin.service";
import { AdminGate } from "../common/admin-gate";
import { SenderBlocklist } from "../common/blocklist";
import { NonceService } from "../common/nonce.service";
import { MediaService, type MediaConfig } from "../media/media.service";
import type { SnapshotService } from "../places/snapshot.service";
import type { RoomsService } from "../rooms/rooms.service";
import type { DescriptorFacts } from "../server-identity";
import { createLiveConfig } from "../settings/live-config";
import { runtimeSettingsFrom } from "../settings/registry";
import { SettingsService } from "../settings/settings.service";
import type { MediaRecord, MediaStore } from "../stores/media-store";
import {
  PLACE_T0 as T0,
  makeJarRoom,
  makePlace,
  makeSource,
  memoryBlobStore,
  rejectedWith,
  statusOf,
  testSignedRequestGate,
} from "./test-helpers";
import { testConfig } from "./test-config";
import {
  MemoryBlocklistStore,
  memoryMedia,
  memoryNonces,
  MemoryPlaceStore,
  memoryProfiles,
  MemorySettingsStore,
} from "./memory-stores";

const STARTED_AT = "2026-07-24T00:00:00.000Z";
const FACTS: DescriptorFacts = {
  host: "test.example",
  key: "did:key:zServer" as DidKey,
  name: "Test Server",
  version: "0.0.1",
  accessLevel: "open",
  coverage: [""],
  capabilities: ["places"],
  startedAt: STARTED_AT,
};
const MEDIA_CFG: MediaConfig = {
  enabled: true,
  host: "test.example",
  maxBytes: 5_000_000,
  types: ["image/webp"],
  quotaBytes: 50_000_000,
  rateMax: 60,
  rateWindowMs: 60_000,
  writeLocked: false,
};

function setup(admins: string[], revokedDevices: string[] = []) {
  const profiles = memoryProfiles();
  const media = memoryMedia();
  const nonce = new NonceService(memoryNonces(), { retentionMs: 10 * 60_000, writeLocked: false });
  // Admins are the protected DIDs — the blocklist refuses them (`doc/spec/admin-api.md` §3 Phase
  // B).
  const blocklist = new SenderBlocklist(new MemoryBlocklistStore(), [], admins);
  const gate = new AdminGate(testSignedRequestGate({ blocklist, revokedDevices }), nonce, admins);
  const rooms = new InMemoryStore();
  const places = new MemoryPlaceStore();

  // A real MediaService over an in-memory blob map, so media.remove is exercised end-to-end.
  const { blob, blobs } = memoryBlobStore();
  const mediaService = new MediaService(media, blob, MEDIA_CFG);

  // RoomsService double: the real removal mechanics are covered in rooms-service.test.ts.
  const removedRooms: string[] = [];
  const roomsService = {
    adminRemove: (id: string) => {
      removedRooms.push(id);
      return Promise.resolve(!id.startsWith("missing"));
    },
  } as unknown as RoomsService;

  // A real settings stack over an in-memory store, so the settings ops run against the live view
  // the server actually serves rather than a stub. The ops themselves are covered in
  // settings-admin.test.ts; this is the wiring every other route here shares.
  const bootEnv = {} as NodeJS.ProcessEnv;
  const boot = testConfig(bootEnv);
  const settings = new SettingsService(new MemorySettingsStore(), runtimeSettingsFrom(boot));
  const controller = new AdminController(
    gate,
    new AdminService(
      rooms,
      profiles,
      media,
      places,
      () => FACTS,
      () => false,
      () => 0,
    ),
    nonce,
    roomsService,
    mediaService,
    blocklist,
    settings,
    createLiveConfig(boot, settings),
    bootEnv,
    { hasActiveRun: () => false } as unknown as SnapshotService,
  );
  return {
    controller,
    rooms,
    profiles,
    media,
    places,
    blocklist,
    blobs,
    mediaService,
    removedRooms,
  };
}

type Wallet = ReturnType<typeof createWallet>;
const adminEnv = (w: Wallet, op: string, params: Record<string, unknown>, nonce = ulid()) =>
  signOpWithWallet(w, { op, nonce, params });
const statusEnv = (w: Wallet) => adminEnv(w, "admin.status", {});

describe("AdminController — the server-wide admin surface (`doc/spec/admin-api.md` §2 and §3)", () => {
  it("404s when no admins are configured — the surface looks absent, even to a valid signer", async () => {
    const { controller } = setup([]);
    expect(await statusOf(controller.status(statusEnv(createWallet())))).toBe(404);
  });

  it("is untouched by the game gate, even for a game no operator has admitted", async () => {
    // The admin surface must stay out of the game gate, and this is the check that keeps it out.
    // Composing GameGate into AdminGate would let a misconfigured BEACON_GAMES lock an operator out
    // of the console they would use to fix it — the same hazard the blocklist-before-allowlist
    // ordering already exists to prevent. The controller takes no GameGate at all, so this asserts
    // a structural property, not a verdict.
    const admin = createWallet();
    const { controller } = setup([admin.account.did]);
    // Signed WITH the slug, not stamped on after: a slug added post-signature would 401 as a
    // tampered envelope and the test would pass for the wrong reason.
    const env = signOpWithWallet(admin, {
      op: "admin.status",
      nonce: ulid(),
      game: "not-a-game-any-server-admits",
      params: {},
    });
    const { status } = await controller.status(env);
    expect(adminStatusSchema.parse(status)).toMatchObject({ host: "test.example" });
  });

  it("denies a revoked admin device, which is the case admin powers make worst", async () => {
    // The admin surface composes the shared gate, so revocation covers it too. An operator's lost
    // phone could keep removing rooms and managing the blocklist as them. Deliberately NOT the same
    // call as the app gate, which must stay off this surface: a misconfigured game list would lock
    // an operator out of the console they would fix it from, and revocation is their own act.
    const admin = createWallet();
    const { controller } = setup([admin.account.did], [admin.device.did]);
    expect(await statusOf(controller.status(statusEnv(admin)))).toBe(403);
  });

  it("403s a verified non-admin; 401s a bad signature", async () => {
    const admin = createWallet();
    const { controller } = setup([admin.account.did]);
    expect(await statusOf(controller.status(statusEnv(createWallet())))).toBe(403);
    const tampered = { ...statusEnv(admin), params: { x: 1 } };
    expect(await statusOf(controller.status(tampered))).toBe(401);
  });

  it("rejects a replayed read nonce with 409", async () => {
    const admin = createWallet();
    const { controller } = setup([admin.account.did]);
    const env = statusEnv(admin);
    expect((await controller.status(env)).ok).toBe(true);
    expect(await statusOf(controller.status(env))).toBe(409);
  });

  it("returns descriptor facts + live counts from every store, wire-valid", async () => {
    const admin = createWallet();
    const { controller, rooms, profiles, media, places } = setup([admin.account.did]);

    await rooms.commit([
      { kind: "putRoom", room: makeJarRoom("a@test.example") },
      { kind: "putRoom", room: makeJarRoom("b@test.example") },
    ]);
    await profiles.put({ id: "did:key:zSomeone" } as ProfileDoc);
    await media.put({
      hash: "h1",
      type: "image/webp",
      size: 10,
      owner: "did:key:zSomeone",
      uploadedAt: T0,
      lastAccessAt: null,
      reviewedAt: null,
      reviewedBy: null,
    });
    await media.put({
      hash: "h2",
      type: "image/webp",
      size: 20,
      owner: "did:key:zSomeone",
      uploadedAt: T0,
      lastAccessAt: null,
      reviewedAt: null,
      reviewedBy: null,
    });
    await places.commitPlace(
      makePlace("P1"),
      makeSource("P1"),
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
      ],
    );

    const { status } = await controller.status(statusEnv(admin));
    expect(adminStatusSchema.parse(status)).toEqual(status); // wire-valid, no drift
    // The descriptor facts, minus `key` (identity rides the signed descriptor, not the status).
    const { key: _key, ...expected } = FACTS;
    expect(status).toMatchObject({ ...expected, startedAt: STARTED_AT });
    expect(status.counts).toEqual({
      rooms: 2,
      profiles: 1,
      places: 1,
      placesRetired: 0,
      conflictsPending: 1,
      snapshots: 0,
      mediaObjects: 2,
      mediaBytes: 30,
      mediaUnreviewed: 2,
      accessPending: 0,
    });
  });

  it("reports the store's limit when the server has one, and omits it when not", async () => {
    const { rooms, profiles, media, places } = setup([]);
    const limited = new AdminService(
      rooms,
      profiles,
      media,
      places,
      () => FACTS,
      () => false,
      () => 0,
      500_000_000,
    );
    const status = await limited.status();
    expect(adminStatusSchema.parse(status).counts.mediaLimitBytes).toBe(500_000_000);
    const unlimited = await new AdminService(
      rooms,
      profiles,
      media,
      places,
      () => FACTS,
      () => false,
      () => 0,
    ).status();
    expect("mediaLimitBytes" in unlimited.counts).toBe(false);
  });

  it("admin.status reports the lock as it stands now, not as it stood at boot", async () => {
    const { rooms, profiles, media, places } = setup([]);
    let locked = false;
    const status = new AdminService(
      rooms,
      profiles,
      media,
      places,
      () => FACTS,
      () => locked,
      () => 0,
    );
    expect(adminStatusSchema.parse(await status.status()).writeLocked).toBe(false);
    locked = true;
    expect(adminStatusSchema.parse(await status.status()).writeLocked).toBe(true);
  });

  it("admin.room.remove is gated, idempotent by nonce, and reports removed", async () => {
    const admin = createWallet();
    const { controller, removedRooms } = setup([admin.account.did]);

    // Non-admin → 403 before any removal happens.
    const stranger = createWallet();
    expect(
      await statusOf(
        controller.roomRemove(adminEnv(stranger, "admin.room.remove", { id: "j1@test.example" })),
      ),
    ).toBe(403);
    expect(removedRooms).toHaveLength(0);

    const n = ulid();
    const first = await controller.roomRemove(
      adminEnv(admin, "admin.room.remove", { id: "j1@test.example", reason: "spam" }, n),
    );
    expect(first).toEqual({ ok: true, removed: true });
    // A retried nonce returns the memoized result — the room is not re-removed.
    const retry = await controller.roomRemove(
      adminEnv(admin, "admin.room.remove", { id: "j1@test.example", reason: "spam" }, n),
    );
    expect(retry).toEqual({ ok: true, removed: true });
    expect(removedRooms).toEqual(["j1@test.example"]);

    const gone = await controller.roomRemove(
      adminEnv(admin, "admin.room.remove", { id: "missing@test.example" }),
    );
    expect(gone).toEqual({ ok: true, removed: false });
  });

  it("admin.media.remove deletes blob + metadata; unknown hash is a clean false", async () => {
    const admin = createWallet();
    const { controller, media, mediaService, blobs } = setup([admin.account.did]);
    const stored = await mediaService.ingestTrusted(
      "did:key:zOwner" as DidKey,
      Buffer.from("some webp bytes"),
      "image/webp",
    );
    if (typeof stored !== "object") throw new Error("expected the bytes stored");
    const hash = stored.hash;
    expect(blobs.has(hash)).toBe(true);

    const res = await controller.mediaRemove(adminEnv(admin, "admin.media.remove", { hash }));
    expect(res).toEqual({ ok: true, removed: true });
    expect(blobs.has(hash)).toBe(false);
    expect(await media.get(hash)).toBeUndefined();

    const again = await controller.mediaRemove(adminEnv(admin, "admin.media.remove", { hash }));
    expect(again).toEqual({ ok: true, removed: false });
  });

  it("blocklist add/fetch/remove round-trips, denies immediately, and refuses blocking an admin", async () => {
    const admin = createWallet();
    const { controller, blocklist } = setup([admin.account.did]);
    const troll = createWallet();

    await controller.blocklistAdd(
      adminEnv(admin, "admin.blocklist.add", { did: troll.account.did, reason: "abuse" }),
    );
    expect(blocklist.has(troll.account.did)).toBe(true);
    // The blocked DID's signed requests are denied at the shared gate (403), effective now.
    expect(await statusOf(controller.status(statusEnv(troll)))).toBe(403);

    const { entries } = await controller.blocklistFetch(
      adminEnv(admin, "admin.blocklist.fetch", {}),
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      did: troll.account.did,
      reason: "abuse",
      addedBy: admin.account.did,
    });

    // Blocklisting an allowlisted operator is refused (it would brick their admin access).
    expect(
      await statusOf(
        controller.blocklistAdd(adminEnv(admin, "admin.blocklist.add", { did: admin.account.did })),
      ),
    ).toBe(400);

    const lifted = await controller.blocklistRemove(
      adminEnv(admin, "admin.blocklist.remove", { did: troll.account.did }),
    );
    expect(lifted).toEqual({ ok: true, removed: true });
    expect(blocklist.has(troll.account.did)).toBe(false);
    const again = await controller.blocklistRemove(
      adminEnv(admin, "admin.blocklist.remove", { did: troll.account.did }),
    );
    expect(again.removed).toBe(false);
  });
});

describe("AdminController: bad params", () => {
  it("names an unknown key in `fields` on moderation, review, blocklist and settings writes", async () => {
    const admin = createWallet();
    const { controller } = setup([admin.account.did]);
    const extra = { newerField: 1 };
    const hash = "a".repeat(43);
    for (const call of [
      () => controller.mediaRemove(adminEnv(admin, "admin.media.remove", { hash, ...extra })),
      () => controller.roomRemove(adminEnv(admin, "admin.room.remove", { id: "r@h", ...extra })),
      () =>
        controller.mediaReview(
          adminEnv(admin, "admin.media.review", { hash, reviewed: true, ...extra }),
        ),
      () =>
        controller.blocklistAdd(
          adminEnv(admin, "admin.blocklist.add", { did: createWallet().account.did, ...extra }),
        ),
      () =>
        controller.settingsSet(
          adminEnv(admin, "admin.settings.set", { settings: { mailboxTtlSeconds: 60 }, ...extra }),
        ),
      () =>
        controller.settingsReset(
          adminEnv(admin, "admin.settings.reset", { keys: ["mailboxTtlSeconds"], ...extra }),
        ),
    ]) {
      const err = await rejectedWith(call);
      expect(err.getStatus()).toBe(400);
      expect(err.getResponse()).toMatchObject({
        ok: false,
        error: "invalid",
        fields: ["newerField"],
      });
    }
  });
});

describe("AdminController — media list + review (`doc/spec/admin-api.md` §3)", () => {
  // Valid did:key examples (the wire list item validates owner as a did:key).
  const ALICE = "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK" as DidKey;
  const BOB = "did:key:z6MkpTHR8VNsBxYAAWHut2Geadd9jSwuBV8xRoAnwWsdvktH" as DidKey;
  const day = (n: number) => `2026-07-0${n}T00:00:00.000Z`;
  const seed = (media: MediaStore, hash: string, over: Partial<MediaRecord> = {}) =>
    media.put({
      hash,
      type: "image/webp",
      size: 10,
      owner: ALICE,
      uploadedAt: day(1),
      lastAccessAt: null,
      reviewedAt: null,
      reviewedBy: null,
      ...over,
    });

  it("list is gated: 404 no-admins, 403 non-admin, 409 replay", async () => {
    const admin = createWallet();
    const open = setup([]);
    expect(
      await statusOf(open.controller.mediaList(adminEnv(createWallet(), "admin.media.list", {}))),
    ).toBe(404);

    const { controller } = setup([admin.account.did]);
    expect(
      await statusOf(controller.mediaList(adminEnv(createWallet(), "admin.media.list", {}))),
    ).toBe(403);
    const env = adminEnv(admin, "admin.media.list", {});
    expect((await controller.mediaList(env)).ok).toBe(true);
    expect(await statusOf(controller.mediaList(env))).toBe(409); // replayed read nonce
  });

  it("returns newest-first pages and walks by opaque cursor", async () => {
    const admin = createWallet();
    const { controller, media } = setup([admin.account.did]);
    await seed(media, "h1", { uploadedAt: day(1) });
    await seed(media, "h2", { uploadedAt: day(2) });
    await seed(media, "h3", { uploadedAt: day(3) });

    const p1 = await controller.mediaList(adminEnv(admin, "admin.media.list", { limit: 2 }));
    expect(p1.items.map((i) => i.hash)).toEqual(["h3", "h2"]);
    expect(p1.nextCursor).toBeDefined();
    const p2 = await controller.mediaList(
      adminEnv(admin, "admin.media.list", { limit: 2, cursor: p1.nextCursor }),
    );
    expect(p2.items.map((i) => i.hash)).toEqual(["h1"]);
    expect(p2.nextCursor).toBeUndefined();
  });

  it("sorts largest-first and walks size-ordered pages by opaque cursor", async () => {
    const admin = createWallet();
    const { controller, media } = setup([admin.account.did]);
    await seed(media, "h1", { size: 50, uploadedAt: day(1) });
    await seed(media, "h2", { size: 10, uploadedAt: day(2) });
    await seed(media, "h3", { size: 30, uploadedAt: day(3) });

    const p1 = await controller.mediaList(
      adminEnv(admin, "admin.media.list", { limit: 2, sort: "size" }),
    );
    expect(p1.items.map((i) => i.hash)).toEqual(["h1", "h3"]);
    expect(p1.nextCursor).toBeDefined();
    const p2 = await controller.mediaList(
      adminEnv(admin, "admin.media.list", { limit: 2, sort: "size", cursor: p1.nextCursor }),
    );
    expect(p2.items.map((i) => i.hash)).toEqual(["h2"]);
    expect(p2.nextCursor).toBeUndefined();
  });

  it("rejects a malformed cursor with 400", async () => {
    const admin = createWallet();
    const { controller } = setup([admin.account.did]);
    expect(
      await statusOf(
        controller.mediaList(adminEnv(admin, "admin.media.list", { cursor: "@@not-a-cursor@@" })),
      ),
    ).toBe(400);
  });

  it("filters by owner, type, and reviewed state", async () => {
    const admin = createWallet();
    const { controller, media } = setup([admin.account.did]);
    await seed(media, "a1", { owner: ALICE, type: "image/webp", uploadedAt: day(1) });
    await seed(media, "b1", { owner: BOB, type: "image/png", uploadedAt: day(2) });

    const byOwner = await controller.mediaList(adminEnv(admin, "admin.media.list", { owner: BOB }));
    expect(byOwner.items.map((i) => i.hash)).toEqual(["b1"]);
    const byType = await controller.mediaList(
      adminEnv(admin, "admin.media.list", { type: "image/png" }),
    );
    expect(byType.items.map((i) => i.hash)).toEqual(["b1"]);

    await controller.mediaReview(
      adminEnv(admin, "admin.media.review", { hash: "a1", reviewed: true }),
    );
    const reviewed = await controller.mediaList(
      adminEnv(admin, "admin.media.list", { reviewed: "reviewed" }),
    );
    expect(reviewed.items.map((i) => i.hash)).toEqual(["a1"]);
    const unreviewed = await controller.mediaList(
      adminEnv(admin, "admin.media.list", { reviewed: "unreviewed" }),
    );
    expect(unreviewed.items.map((i) => i.hash)).toEqual(["b1"]);
  });

  it("review stamps + clears, reports the actor, and is idempotent by nonce", async () => {
    const admin = createWallet();
    const { controller, media } = setup([admin.account.did]);
    await seed(media, "h1");

    const mark = await controller.mediaReview(
      adminEnv(admin, "admin.media.review", { hash: "h1", reviewed: true }),
    );
    expect(mark).toMatchObject({ ok: true, reviewedBy: admin.account.did });
    expect(mark.reviewedAt).toBeTruthy();
    expect((await media.get("h1"))?.reviewedBy).toBe(admin.account.did);

    // Unmark, then replay the same nonce → the cached result, no re-mutation.
    const unmarkEnv = adminEnv(admin, "admin.media.review", { hash: "h1", reviewed: false });
    const first = await controller.mediaReview(unmarkEnv);
    expect(first).toEqual({ ok: true, reviewedAt: null, reviewedBy: null });
    expect(await controller.mediaReview(unmarkEnv)).toEqual(first);
    expect((await media.get("h1"))?.reviewedAt).toBeNull();
  });
});
