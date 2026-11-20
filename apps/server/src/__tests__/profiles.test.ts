import {
  authorizeDevice,
  buildProfile,
  createAccount,
  createDevice,
  signUtf8,
  verifyProfile,
} from "@beaconsgg/identity";
import { canonicalJson, MAX_PROFILE_BYTES, profileBytes } from "@beaconsgg/protocol-types";
import { HttpStatus } from "@nestjs/common";
import { beforeEach, describe, expect, it } from "vitest";
import { ProfilesController } from "../profiles/profiles.controller";
import { ProfilesService } from "../profiles/profiles.service";
import { memoryProfiles } from "./memory-stores";
import { rejectedWith, testBlocklist } from "./test-helpers";
import type { ProfileStore } from "../stores/profile-store";

const ISSUED = "2026-06-29T00:00:00Z";

/** A resolvable gate + a full-microtask flush, for the concurrency test below. */
function makeGate(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}
const flush = (): Promise<void> => new Promise((r) => setImmediate(r));

describe("ProfilesService (revocation registry)", () => {
  let svc: ProfilesService;
  beforeEach(() => {
    svc = new ProfilesService(testBlocklist()); // no store -> pure in-memory registry
  });

  it("accepts a profile, enforces revocation, and rejects a rollback", async () => {
    const account = createAccount();
    const phone = createDevice();
    const laptop = createDevice();
    const devices = [
      { did: phone.did, auth: authorizeDevice(account, phone.did, { issued: ISSUED }) },
      { did: laptop.did, auth: authorizeDevice(account, laptop.did, { issued: ISSUED }) },
    ];
    const v1 = buildProfile(account, { version: 1, devices });
    const v2 = buildProfile(account, { version: 2, devices, revoked: [phone.did] });

    expect(await svc.publish(v1)).toMatchObject({ ok: true });
    expect(svc.isRevoked(account.did, phone.did)).toBe(false); // not revoked at v1

    expect(await svc.publish(v2)).toMatchObject({ ok: true });
    expect(svc.isRevoked(account.did, phone.did)).toBe(true); // revoked at v2
    expect(svc.isRevoked(account.did, laptop.did)).toBe(false);

    // A replay of the pre-revocation v1 is stale — revocation can't be rolled back.
    expect(await svc.publish(v1)).toEqual({ ok: false, error: "stale" });
    expect(svc.isRevoked(account.did, phone.did)).toBe(true);

    // No profile on file for an account -> best-effort "not revoked".
    expect(svc.isRevoked("did:key:z6MkStranger", phone.did)).toBe(false);
  });

  it("serializes concurrent publishes for one account so durable writes stay ordered", async () => {
    const account = createAccount();
    const phone = createDevice();
    const devices = [
      { did: phone.did, auth: authorizeDevice(account, phone.did, { issued: ISSUED }) },
    ];
    const v1 = buildProfile(account, { version: 1, devices });
    const v2 = buildProfile(account, { version: 2, devices, revoked: [phone.did] });

    // A store whose durable `put` blocks on a per-version gate, recording apply order at completion.
    const applied: number[] = [];
    const gates: Record<number, { promise: Promise<void>; resolve: () => void }> = {
      1: makeGate(),
      2: makeGate(),
    };
    const store: ProfileStore = {
      all: () => Promise.resolve([]),
      put: async (p) => {
        await gates[p.version]?.promise;
        applied.push(p.version);
      },
      count: () => Promise.resolve(0),
    };
    const svc = new ProfilesService(testBlocklist(), store);

    const pubV1 = svc.publish(v1);
    const pubV2 = svc.publish(v2);
    await flush(); // v1 holds the per-account lock, parked in put(1); v2 waits for the lock

    // Release v2's durable write FIRST. Under the lock, publish(v2) hasn't called put yet — so v1
    // still commits before v2. WITHOUT the lock, v2 would apply first and the store would end on v1.
    gates[2]!.resolve();
    gates[1]!.resolve();
    expect(await Promise.all([pubV1, pubV2])).toMatchObject([{ ok: true }, { ok: true }]);

    expect(applied).toEqual([1, 2]); // ordered despite releasing v2 first
    expect(svc.isRevoked(account.did, phone.did)).toBe(true); // ended on v2's revocation
  });

  it("rejects a tampered profile as invalid", async () => {
    const account = createAccount();
    const phone = createDevice();
    const v1 = buildProfile(account, {
      version: 1,
      devices: [{ did: phone.did, auth: authorizeDevice(account, phone.did, { issued: ISSUED }) }],
    });
    expect(await svc.publish({ ...v1, version: 5 })).toEqual({ ok: false, error: "invalid" });
  });

  it("refuses a blocked account's publish, and only once the doc's own signature has verified", async () => {
    const account = createAccount();
    const phone = createDevice();
    const devices = [
      { did: phone.did, auth: authorizeDevice(account, phone.did, { issued: ISSUED }) },
    ];
    const v1 = buildProfile(account, { version: 1, devices });
    const blocked = new ProfilesService(testBlocklist([account.did]));

    // A tampered doc is `invalid`, NOT `denied`: the id is only worth testing once `acceptProfile`
    // has verified the self-signature, so the block check sits behind it rather than at the boundary,
    // where `profile.id` would still be a claim anyone could put in a body.
    expect(await blocked.publish({ ...v1, version: 5 })).toEqual({ ok: false, error: "invalid" });

    expect(await blocked.publish(v1)).toEqual({ ok: false, error: "denied" });
    // Refused before either write, so the registry never took the doc.
    expect(blocked.get(account.did)).toBeUndefined();
  });

  it("persists revocation across a restart (a fresh service on the same store stays revoked)", async () => {
    // The store's own durability, JSONB included, is profile-store.test.ts; this is the service's
    // half: a fresh service rehydrates from whatever the store holds.
    const store = memoryProfiles();
    const account = createAccount();
    const phone = createDevice();
    const devices = [
      { did: phone.did, auth: authorizeDevice(account, phone.did, { issued: ISSUED }) },
    ];
    const v1 = buildProfile(account, { version: 1, devices });
    const v2 = buildProfile(account, { version: 2, devices, revoked: [phone.did] });

    const svc1 = new ProfilesService(testBlocklist(), store);
    await svc1.onModuleInit();
    expect(await svc1.publish(v1)).toMatchObject({ ok: true });
    expect(await svc1.publish(v2)).toMatchObject({ ok: true }); // revoke the phone at v2
    expect(svc1.isRevoked(account.did, phone.did)).toBe(true);

    // "restart": a new service over the same store rehydrates from it.
    const svc2 = new ProfilesService(testBlocklist(), store);
    await svc2.onModuleInit();
    expect(svc2.isRevoked(account.did, phone.did)).toBe(true); // revocation survived
    // …and the high-water survived too: a replay of the pre-revocation v1 is still stale.
    expect(await svc2.publish(v1)).toEqual({ ok: false, error: "stale" });
  });
});

/** `body` signed by `account`'s root and off the wire, as the JSON body parser hands it over. */
function resigned(account: ReturnType<typeof createAccount>, body: object): unknown {
  const sig = signUtf8(canonicalJson(body), account.root.privateKey);
  return JSON.parse(JSON.stringify({ ...body, proof: { type: "Ed25519", key: account.did, sig } }));
}

describe("POST /profiles: a profile a newer app published", () => {
  /** A signed v2 carrying `pronouns`, a field this build has never heard of, and a revocation. */
  function newerProfile() {
    const account = createAccount();
    const phone = createDevice();
    const laptop = createDevice();
    const devices = [
      { did: laptop.did, auth: authorizeDevice(account, laptop.did, { issued: ISSUED }) },
    ];
    const { proof: _p, ...body } = buildProfile(account, {
      version: 2,
      devices,
      revoked: [phone.did],
    });
    return { account, phone, laptop, raw: resigned(account, { ...body, pronouns: "they/them" }) };
  }

  it("accepts it, keeps the field, serves it back verifiable, and enforces its revocation", async () => {
    const svc = new ProfilesService(testBlocklist());
    const controller = new ProfilesController(svc);
    const { account, phone, laptop, raw } = newerProfile();

    expect(await controller.publish(raw)).toEqual({ ok: true, id: account.did, version: 2 });
    expect(svc.isRevoked(account.did, phone.did)).toBe(true); // the revocation the strict parse used to drop
    expect(svc.isRevoked(account.did, laptop.did)).toBe(false);
    const served = controller.resolve(account.did);
    expect(served).toMatchObject({ pronouns: "they/them" });
    expect(verifyProfile(JSON.parse(JSON.stringify(served)))).toBe(true);
  });

  it("keeps the field across a restart", async () => {
    const store = memoryProfiles();
    const { account, raw } = newerProfile();
    expect(await new ProfilesService(testBlocklist(), store).publish(raw)).toMatchObject({
      ok: true,
    });

    const svc2 = new ProfilesService(testBlocklist(), store);
    await svc2.onModuleInit();
    const served = svc2.get(account.did);
    expect(served).toMatchObject({ pronouns: "they/them" });
    expect(verifyProfile(JSON.parse(JSON.stringify(served)))).toBe(true);
  });

  it("still refuses a body that is not a profile, or one whose signature does not cover the field", async () => {
    const controller = new ProfilesController(new ProfilesService(testBlocklist()));
    for (const body of [null, "junk", { id: "did:key:z6Mk" }]) {
      const err = await rejectedWith(() => controller.publish(body));
      expect(err.getStatus()).toBe(HttpStatus.BAD_REQUEST);
      expect(err.getResponse()).toEqual({ ok: false, error: "invalid" });
    }
    // The field added after signing is a tamper, as it is on every read.
    const { raw } = newerProfile();
    const tampered = { ...(raw as Record<string, unknown>), mood: "sly" };
    const err = await rejectedWith(() => controller.publish(tampered));
    expect(err.getResponse()).toEqual({ ok: false, error: "invalid" });
  });
});

describe("POST /profiles: the size cap", () => {
  /** A signed profile of exactly `bytes`, padded with `pad` in a field this build does not know. */
  function signedOfSize(bytes: number, pad = "x") {
    const account = createAccount();
    const phone = createDevice();
    const devices = [
      { did: phone.did, auth: authorizeDevice(account, phone.did, { issued: ISSUED }) },
    ];
    const { proof: _p, ...body } = buildProfile(account, { version: 1, devices, updated: ISSUED });
    const padBytes = Buffer.byteLength(pad, "utf8");
    const room = bytes - profileBytes(resigned(account, { ...body, notes: "" }));
    const doc = resigned(account, { ...body, notes: pad.repeat(Math.ceil(room / padBytes)) });
    return { account, doc };
  }

  it("accepts a doc of exactly the cap, and answers one byte more 413 tooLarge without storing it", async () => {
    const svc = new ProfilesService(testBlocklist());
    const controller = new ProfilesController(svc);
    const atCap = signedOfSize(MAX_PROFILE_BYTES);
    expect(profileBytes(atCap.doc)).toBe(MAX_PROFILE_BYTES);
    expect(await controller.publish(atCap.doc)).toMatchObject({ ok: true });

    const over = signedOfSize(MAX_PROFILE_BYTES + 1);
    const err = await rejectedWith(() => controller.publish(over.doc));
    expect(err.getStatus()).toBe(HttpStatus.PAYLOAD_TOO_LARGE);
    expect(err.getResponse()).toEqual({
      ok: false,
      error: "tooLarge",
      message: `profile exceeds ${MAX_PROFILE_BYTES} bytes`,
    });
    expect(svc.get(over.account.did)).toBeUndefined();
  });

  it("counts UTF-8 bytes, so a doc under the cap in characters but over it in bytes is refused", async () => {
    const controller = new ProfilesController(new ProfilesService(testBlocklist()));
    const { doc } = signedOfSize(MAX_PROFILE_BYTES + 2, "é"); // two bytes, one character
    expect(JSON.stringify(doc).length).toBeLessThan(MAX_PROFILE_BYTES);
    expect(profileBytes(doc)).toBeGreaterThan(MAX_PROFILE_BYTES);
    const err = await rejectedWith(() => controller.publish(doc));
    expect(err.getStatus()).toBe(HttpStatus.PAYLOAD_TOO_LARGE);
  });

  it("answers a number the canonicalizer refuses 400 invalid, as before the cap, not a 500", async () => {
    const controller = new ProfilesController(new ProfilesService(testBlocklist()));
    const { doc } = signedOfSize(2_000);
    const json = JSON.stringify(doc);
    // Only JSON.parse can write it: `1e400` parses to Infinity, which canonical JSON has no form for.
    for (const body of [
      '{"x":1e400}',
      json.replace(/"version":1/, '"version":1e400'),
      json.replace(/^\{/, '{"notes2":1e400,'),
    ]) {
      expect(body).toContain("1e400");
      const err = await rejectedWith(() => controller.publish(JSON.parse(body)));
      expect(err.getStatus()).toBe(HttpStatus.BAD_REQUEST);
      expect(err.getResponse()).toEqual({ ok: false, error: "invalid" });
    }
  });

  it("answers a small body nested too deep to measure 413 too, not a 500", async () => {
    const controller = new ProfilesController(new ProfilesService(testBlocklist()));
    const { doc } = signedOfSize(2_000);
    const deep: unknown = JSON.parse("[".repeat(20_000) + "]".repeat(20_000));
    const err = await rejectedWith(() =>
      controller.publish({ ...(doc as Record<string, unknown>), deep }),
    );
    expect(err.getStatus()).toBe(HttpStatus.PAYLOAD_TOO_LARGE);
  });
});
