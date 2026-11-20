import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWallet, sha256Base64url } from "@beaconsgg/identity";
import { HttpException, StreamableFile } from "@nestjs/common";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { containsPrivacyMetadata } from "../common/media-metadata";
import { NonceService } from "../common/nonce.service";
import { MediaController } from "../media/media.controller";
import { FsMediaBlobStore, S3MediaBlobStore, createMediaBlob } from "../media/media-blob";
import { type MediaConfig, MediaService, STORAGE_FULL } from "../media/media.service";
import type { DidKey } from "@beaconsgg/protocol-types";
import { testConfig } from "./test-config";
import { memoryMedia, memoryNonces } from "./memory-stores";
import {
  memoryBlobStore,
  rejectedWith,
  signedEnv,
  testBlocklistFromEnv,
  testGameGate,
  testSignedRequestGate,
} from "./test-helpers";

type Wallet = ReturnType<typeof createWallet>;

/** A minimal Express-response stub capturing the header + redirect the media fetch sets. */
function mockRes() {
  const headers: Record<string, string> = {};
  let redirectedTo: string | undefined;
  const res = {
    set(field: string, value: string) {
      headers[field] = value;
    },
    redirect(_code: number, url: string) {
      redirectedTo = url;
    },
  };
  return { res, headers, redirect: () => redirectedTo };
}

// A 1×1 grayscale PNG with no metadata, and a tiny JPEG carrying a GPS EXIF block (both verified
// against the detector: clean → false, dirty → true).
const CLEAN_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC",
  "base64",
);
const DIRTY_JPEG = Buffer.from(
  "/9j/4QBMRXhpZgAASUkqAAgAAAABACWIBAABAAAAGgAAAAAAAAABAAIABQADAAAALAAAAAAAAAAoAAAAAQAAAAAAAAABAAAAAAAAAAEAAAD/2Q==",
  "base64",
);

const BASE: MediaConfig = {
  writeLocked: false,
  enabled: true,
  host: "media.example:3001",
  maxBytes: 5_000_000,
  types: ["image/png", "image/jpeg"],
  quotaBytes: 50_000_000,
  rateMax: 60,
  rateWindowMs: 60_000,
};

const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const fn of cleanup.splice(0)) fn();
  delete process.env["BEACON_BLOCKLIST"];
});

function setup(
  overrides: Partial<MediaConfig> = {},
  revokedDevices: string[] = [],
  admitted: string[] = [],
  admins: string[] = [],
) {
  const store = memoryMedia();
  const dir = mkdtempSync(join(tmpdir(), "beacon-media-"));
  const blob = new FsMediaBlobStore(dir);
  const service = new MediaService(store, blob, { ...BASE, ...overrides });
  const nonce = new NonceService(memoryNonces(), { retentionMs: 10 * 60_000, writeLocked: false });
  const controller = new MediaController(
    service,
    testSignedRequestGate({ blocklist: testBlocklistFromEnv(), revokedDevices }),
    nonce,
    testGameGate(admitted),
    admins,
  );
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  return { store, service, controller };
}

/** A base64-in-JSON upload body; override params to tamper with the signed attestation. */
function uploadBody(
  w: Wallet,
  bytes: Buffer,
  params: { hash?: string; type?: string; size?: number } = {},
) {
  const env = signedEnv(w, "media.put", {
    hash: params.hash ?? sha256Base64url(bytes),
    type: params.type ?? "image/png",
    size: params.size ?? bytes.length,
  });
  return { env, data: bytes.toString("base64") };
}

async function rejectStatus(promise: Promise<unknown>): Promise<number> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof HttpException) return err.getStatus();
    throw err;
  }
  throw new Error("expected the call to reject");
}

async function readStream(sf: StreamableFile): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of sf.getStream()) chunks.push(Buffer.from(c));
  return Buffer.concat(chunks);
}

describe("MediaController", () => {
  it("stores and serves back the exact bytes (content-addressed round trip)", async () => {
    const { controller } = setup();
    const alice = createWallet();
    const { id } = await controller.put(uploadBody(alice, CLEAN_PNG));
    const hash = sha256Base64url(CLEAN_PNG);
    expect(id).toBe(`${hash}@media.example:3001`);

    const { res, headers } = mockRes();
    const sf = await controller.get(hash, res);
    if (!sf) throw new Error("expected a StreamableFile (fs backend streams bytes)");
    expect(sf).toBeInstanceOf(StreamableFile);
    expect((await readStream(sf)).equals(CLEAN_PNG)).toBe(true);
    expect(sf.getHeaders().type).toBe("image/png");
    expect(headers["Cache-Control"]).toContain("immutable");
  });

  it("refuses an upload naming no game, or a game this server does not take (403)", async () => {
    const w = createWallet();
    const bytes = Buffer.from("a png, notionally");
    const gameless = {
      env: signedEnv(
        w,
        "media.put",
        { hash: sha256Base64url(bytes), type: "image/png", size: bytes.length },
        undefined,
        null,
      ),
      data: bytes.toString("base64"),
    };
    expect(await rejectStatus(setup().controller.put(gameless))).toBe(403);
    const closed = setup({}, [], ["other-game"]).controller;
    expect(await rejectStatus(closed.put(uploadBody(w, bytes)))).toBe(403);
  });

  it("takes an operator's own upload naming no game: a place photo is nobody's game's", async () => {
    const operator = createWallet();
    const bytes = Buffer.from("a place photo, notionally");
    const env = signedEnv(
      operator,
      "media.put",
      { hash: sha256Base64url(bytes), type: "image/png", size: bytes.length },
      undefined,
      null,
    );
    const { controller } = setup({}, [], ["kites"], [operator.account.did]);
    await expect(controller.put({ env, data: bytes.toString("base64") })).resolves.toMatchObject({
      ok: true,
    });
  });

  it("rejects a hash that doesn't match the bytes (400)", async () => {
    const { controller } = setup();
    const alice = createWallet();
    const body = uploadBody(alice, CLEAN_PNG, { hash: sha256Base64url(Buffer.from("other")) });
    expect(await rejectStatus(controller.put(body))).toBe(400);
  });

  it("rejects a declared size that doesn't match the bytes (400)", async () => {
    const { controller } = setup();
    const alice = createWallet();
    expect(await rejectStatus(controller.put(uploadBody(alice, CLEAN_PNG, { size: 999 })))).toBe(
      400,
    );
  });

  it("rejects a disallowed MIME type (415)", async () => {
    const { controller } = setup();
    const alice = createWallet();
    expect(
      await rejectStatus(controller.put(uploadBody(alice, CLEAN_PNG, { type: "image/gif" }))),
    ).toBe(415);
  });

  it("rejects media carrying EXIF/GPS metadata — detect, never strip (422)", async () => {
    const { controller, store } = setup();
    const alice = createWallet();
    const body = uploadBody(alice, DIRTY_JPEG, { type: "image/jpeg" });
    expect(await rejectStatus(controller.put(body))).toBe(422);
    // Nothing was stored (rejected, not sanitized-and-stored).
    expect(await store.get(sha256Base64url(DIRTY_JPEG))).toBeUndefined();
  });

  it("rejects an over-size object (413)", async () => {
    const { controller } = setup({ maxBytes: 8 });
    const alice = createWallet();
    expect(await rejectStatus(controller.put(uploadBody(alice, CLEAN_PNG)))).toBe(413);
  });

  it("enforces the per-DID storage quota (413)", async () => {
    const { controller } = setup({ quotaBytes: 10 }); // smaller than one PNG
    const alice = createWallet();
    expect(await rejectStatus(controller.put(uploadBody(alice, CLEAN_PNG)))).toBe(413);
  });

  it("enforces the server's storage limit across every uploader (413); held content still dedupes", async () => {
    const { controller } = setup({ limitBytes: CLEAN_PNG.length * 2 });
    const alice = createWallet();
    const bob = createWallet();
    const second = Buffer.concat([CLEAN_PNG, Buffer.from([0])]);
    const { id } = await controller.put(uploadBody(alice, CLEAN_PNG));
    // Bob is far inside his own quota; the store as a whole is what is full.
    expect(await rejectStatus(controller.put(uploadBody(bob, second)))).toBe(413);
    // Content already held takes no more room, so it is answered as before.
    await expect(controller.put(uploadBody(bob, CLEAN_PNG))).resolves.toMatchObject({ id });
  });

  it("enforces the per-DID upload rate (429)", async () => {
    const { controller } = setup({ rateMax: 1 });
    const alice = createWallet();
    await controller.put(uploadBody(alice, CLEAN_PNG));
    // A second, distinct object from the same uploader trips the window.
    const other = Buffer.concat([CLEAN_PNG, Buffer.from([0])]);
    expect(await rejectStatus(controller.put(uploadBody(alice, other)))).toBe(429);
  });

  it("dedupes identical content (same id, stored once)", async () => {
    const { controller, store } = setup();
    const alice = createWallet();
    const bob = createWallet();
    const first = await controller.put(uploadBody(alice, CLEAN_PNG));
    const again = await controller.put(uploadBody(bob, CLEAN_PNG)); // different uploader, same bytes
    expect(again.id).toBe(first.id);
    const rec = await store.get(sha256Base64url(CLEAN_PNG));
    expect(rec?.owner).toBe(alice.account.did); // the first uploader owns the single row
  });

  it("reads a stored blob's bytes back directly, and undefined for a missing one", async () => {
    const dir = mkdtempSync(join(tmpdir(), "beacon-media-"));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const blob = new FsMediaBlobStore(dir);
    const hash = sha256Base64url(CLEAN_PNG);
    await blob.put(hash, CLEAN_PNG);

    const stream = await blob.read(hash);
    const chunks: Buffer[] = [];
    for await (const chunk of stream as AsyncIterable<Buffer>) chunks.push(chunk);
    expect(Buffer.concat(chunks).equals(CLEAN_PNG)).toBe(true);
    await expect(blob.read("missing-hash")).resolves.toBeUndefined();
    const listed: { hash: string; size: number }[] = [];
    for await (const entry of blob.list()) listed.push(entry);
    expect(listed).toEqual([{ hash, size: CLEAN_PNG.length }]);

    // An aborted read gives up on the file rather than handing back a stream that errors unheard.
    const aborted = new AbortController();
    aborted.abort(new Error("stopped"));
    await expect(blob.read(hash, aborted.signal)).rejects.toThrow("stopped");

    // Only an absent file reads as absent: here the shard directory is a plain file (ENOTDIR).
    writeFileSync(join(dir, "zz"), "not a directory");
    await expect(blob.read("zzsomehash")).rejects.toMatchObject({ code: "ENOTDIR" });
  });

  it("throttles the last-access stamp — no DB write per fetch on a hot blob", async () => {
    const store = memoryMedia();
    const dir = mkdtempSync(join(tmpdir(), "beacon-media-"));
    const blob = new FsMediaBlobStore(dir);
    let ms = Date.parse("2026-07-12T00:00:00.000Z");
    const service = new MediaService(store, blob, BASE, containsPrivacyMetadata, () => ms);
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const alice = createWallet();
    const hash = sha256Base64url(CLEAN_PNG);
    await service.put(
      alice.account.did,
      { hash, type: "image/png", size: CLEAN_PNG.length },
      CLEAN_PNG,
    );

    // Consume the returned stream to completion the way the HTTP pipe does, so the fd is closed
    // before the test's temp dir is removed (a discarded lazy `open` would else ENOENT post-cleanup).
    const drain = async () => {
      const r = await service.get(hash);
      if (r?.location.kind === "stream") for await (const _ of r.location.stream) void _;
    };

    await drain(); // first fetch stamps last_access_at
    const first = (await store.get(hash))?.lastAccessAt;
    expect(first).toBeTruthy();

    ms += 60_000; // a minute later — inside the throttle window → no re-stamp
    await drain();
    expect((await store.get(hash))?.lastAccessAt).toBe(first);

    ms += 60 * 60 * 1000; // past the hourly window → stamps again
    await drain();
    expect((await store.get(hash))?.lastAccessAt).not.toBe(first);
  });

  it("denies a blocked uploader (403)", async () => {
    const alice = createWallet();
    process.env["BEACON_BLOCKLIST"] = alice.account.did;
    const { controller } = setup();
    expect(await rejectStatus(controller.put(uploadBody(alice, CLEAN_PNG)))).toBe(403);
  });

  it("denies a revoked device (403), so a lost phone can't spend its owner's quota", async () => {
    // Media goes through the shared gate, so a revoked device can't keep uploading under its
    // owner's byte quota until that quota runs out.
    const alice = createWallet();
    const { controller } = setup({}, [alice.device.did]);
    expect(await rejectStatus(controller.put(uploadBody(alice, CLEAN_PNG)))).toBe(403);
  });

  it("returns the stored address on a replayed upload (nonce idempotency)", async () => {
    const { controller, store } = setup();
    const alice = createWallet();
    const body = uploadBody(alice, CLEAN_PNG); // one envelope → one nonce
    const first = await controller.put(body);
    const replay = await controller.put(body); // same nonce
    expect(replay.id).toBe(first.id);
    expect(await store.get(sha256Base64url(CLEAN_PNG))).toBeDefined();
  });

  it("404s put + get when the capability is disabled", async () => {
    const { controller } = setup({ enabled: false });
    const alice = createWallet();
    expect(await rejectStatus(controller.put(uploadBody(alice, CLEAN_PNG)))).toBe(404);
    expect(await rejectStatus(controller.get(sha256Base64url(CLEAN_PNG), mockRes().res))).toBe(404);
  });

  it("404s a fetch for unknown content as unknownMedia, and a disabled capability as unknownRoute", async () => {
    const { controller } = setup();
    const err = await rejectedWith(() =>
      controller.get(sha256Base64url(Buffer.from("nope")), mockRes().res),
    );
    expect(err.getStatus()).toBe(404);
    expect(err.getResponse()).toMatchObject({ ok: false, error: "unknownMedia" });

    const off = setup({ enabled: false }).controller;
    const absent = await rejectedWith(() => off.get(sha256Base64url(CLEAN_PNG), mockRes().res));
    expect(absent.getResponse()).toMatchObject({ ok: false, error: "unknownRoute" });
  });

  it("names an unknown key in the upload or its params in `fields`", async () => {
    const { controller } = setup();
    const alice = createWallet();
    const body = uploadBody(alice, CLEAN_PNG);
    const wrapper = await rejectedWith(() => controller.put({ ...body, newerField: 1 }));
    expect(wrapper.getStatus()).toBe(400);
    expect(wrapper.getResponse()).toMatchObject({ error: "invalid", fields: ["newerField"] });

    const env = signedEnv(alice, "media.put", {
      hash: sha256Base64url(CLEAN_PNG),
      type: "image/png",
      size: CLEAN_PNG.length,
      newerField: 1,
    });
    const params = await rejectedWith(() =>
      controller.put({ env, data: CLEAN_PNG.toString("base64") }),
    );
    expect(params.getStatus()).toBe(400);
    expect(params.getResponse()).toMatchObject({ error: "invalid", fields: ["newerField"] });
  });
});

describe("S3MediaBlobStore + createMediaBlob", () => {
  const s3Env = {
    BEACON_MEDIA_BACKEND: "s3",
    BEACON_MEDIA_S3_BUCKET: "beacon-media",
    BEACON_MEDIA_S3_ACCESS_KEY_ID: "key",
    BEACON_MEDIA_S3_SECRET_ACCESS_KEY: "secret",
    BEACON_MEDIA_S3_ENDPOINT: "https://acct.r2.cloudflarestorage.com",
  } as NodeJS.ProcessEnv;

  it("refuses to boot on an unknown backend instead of storing on disk (beacon.server#81)", () => {
    for (const typo of ["S3", "s4", "disk"]) {
      expect(() => testConfig({ BEACON_MEDIA_BACKEND: typo } as NodeJS.ProcessEnv)).toThrow(
        /Invalid BEACON_MEDIA_BACKEND: .* \(must be fs \| s3\)/,
      );
    }
    expect(testConfig({}).mediaBackend).toBe("fs");
    expect(testConfig({ BEACON_MEDIA_BACKEND: " s3 " } as NodeJS.ProcessEnv).mediaBackend).toBe(
      "s3",
    );
  });

  it("throws when the s3 backend is selected without bucket/credentials", () => {
    const cfg = testConfig({ BEACON_MEDIA_BACKEND: "s3" } as NodeJS.ProcessEnv);
    expect(() => createMediaBlob(cfg)).toThrow(/BEACON_MEDIA_S3_BUCKET/);
  });

  it("redirects to the public CDN URL (bytes never proxy through the app)", async () => {
    const cfg = testConfig({
      ...s3Env,
      BEACON_MEDIA_CDN_URL: "https://cdn.example.com/media/", // trailing slash is stripped
    } as NodeJS.ProcessEnv);
    const blob = createMediaBlob(cfg);
    // base64url hash → sharded key `<hash[0:2]>/<hash>`; no S3 call on the redirect path.
    expect(await blob.locate("AbCdEf")).toEqual({
      kind: "redirect",
      url: "https://cdn.example.com/media/Ab/AbCdEf",
    });
    await blob.close?.();
  });

  it("honors an S3 key prefix in the redirect URL", async () => {
    const s3 = new S3MediaBlobStore({
      region: "auto",
      bucket: "b",
      accessKeyId: "k",
      secretAccessKey: "s",
      forcePathStyle: false,
      prefix: "kites/",
      cdnUrl: "https://cdn.example.com",
    });
    expect(await s3.locate("XyZ012")).toEqual({
      kind: "redirect",
      url: "https://cdn.example.com/kites/Xy/XyZ012",
    });
    s3.close();
  });
});

describe("containsPrivacyMetadata (detector)", () => {
  it("is false for a clean image and true for one carrying GPS EXIF", async () => {
    expect(await containsPrivacyMetadata(CLEAN_PNG)).toBe(false);
    expect(await containsPrivacyMetadata(DIRTY_JPEG)).toBe(true);
  });

  it("is false (no crash) for non-image bytes", async () => {
    expect(await containsPrivacyMetadata(Buffer.from("definitely not an image"))).toBe(false);
  });
});

describe("BEACON_MEDIA_LIMIT_BYTES", () => {
  it("is no limit unset or empty, a whole number of bytes when set, and fails boot when malformed", () => {
    expect(testConfig().mediaLimitBytes).toBeUndefined();
    expect(testConfig({ BEACON_MEDIA_LIMIT_BYTES: "" }).mediaLimitBytes).toBeUndefined();
    expect(testConfig({ BEACON_MEDIA_LIMIT_BYTES: "500000000" }).mediaLimitBytes).toBe(500_000_000);
    // A typo must not quietly become a server with no limit.
    for (const bad of ["500MB", "5e8", "-1", "1.5"]) {
      expect(() => testConfig({ BEACON_MEDIA_LIMIT_BYTES: bad })).toThrow(
        /BEACON_MEDIA_LIMIT_BYTES/,
      );
    }
  });
});

// Moved here from the deleted places-images suite (its other subjects went with the POI image
// ingestor); `ingestTrusted` itself is alive — media transfer re-hosts through it.
describe("MediaService.ingestTrusted", () => {
  const OWNER = "did:key:z6MkserverOwnerKey" as DidKey;
  const cfg: MediaConfig = { ...BASE, maxBytes: 1000, types: ["image/webp"] };
  let blobs: Map<string, Buffer>;
  let svc: MediaService;

  beforeEach(() => {
    const memory = memoryBlobStore();
    blobs = memory.blobs;
    svc = new MediaService(memoryMedia(), memory.blob, cfg);
  });

  it("stores clean server bytes content-addressed and dedupes; returns hash + <hash>@host", async () => {
    const bytes = Buffer.from("RIFF....WEBP fake");
    const first = await svc.ingestTrusted(OWNER, bytes, "image/webp");
    if (typeof first !== "object") throw new Error("expected the bytes stored");
    expect(first.id).toBe(`${first.hash}@media.example:3001`);
    expect(blobs.size).toBe(1);
    const again = await svc.ingestTrusted(OWNER, bytes, "image/webp");
    expect(again).toMatchObject({ hash: first.hash });
    expect(blobs.size).toBe(1); // deduped by content hash
  });

  it("rejects a disallowed type or an oversize blob", async () => {
    expect(await svc.ingestTrusted(OWNER, Buffer.from("x"), "image/gif")).toBeUndefined();
    expect(await svc.ingestTrusted(OWNER, Buffer.alloc(2000), "image/webp")).toBeUndefined();
  });

  it("answers storageFull for new bytes past the limit, and still answers bytes already held", async () => {
    const memory = memoryBlobStore();
    const limited = new MediaService(memoryMedia(), memory.blob, { ...cfg, limitBytes: 25 });
    const first = Buffer.alloc(20, 1);
    expect(await limited.ingestTrusted(OWNER, first, "image/webp")).toMatchObject({
      hash: sha256Base64url(first),
    });
    expect(await limited.ingestTrusted(OWNER, Buffer.alloc(10, 2), "image/webp")).toBe(
      STORAGE_FULL,
    );
    expect(memory.blobs.size).toBe(1);
    expect(await limited.ingestTrusted(OWNER, first, "image/webp")).toMatchObject({
      hash: sha256Base64url(first),
    });
  });
});
