/**
 * `upload` against a hand-rolled tree and a fake bucket. What matters here is ordering and scope:
 * immutable files skip when present, `latest.json` rewrites always and lands strictly LAST — the
 * property that keeps a reader from ever following the pointer into a half-arrived version.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { blobPath } from "@beaconsgg/atlas-volume";
import { volumeTree, type VolumeFile } from "../tree";
import {
  normalizePrefix,
  s3StoreFromEnv,
  uploadVolume,
  volumeImportUrl,
  type ObjectStore,
} from "../upload";

const VERSION = "2026-08";
const HASH = "sha256:abcdef1234";

/** A minimal on-disk tree: one cell, one place referencing HASH, the blob present or not. */
async function writeTree(
  dir: string,
  over: { blob?: boolean; geom?: boolean } = {},
): Promise<void> {
  const versionDir = join(dir, VERSION);
  await mkdir(join(versionDir, "cells"), { recursive: true });
  const geom = over.geom ?? true;
  const tile = {
    cell: "c23nb",
    revision: 1,
    places: [{ id: "01A", media: [{ hash: HASH }] }, { id: "01B" }],
  };
  const index = {
    cellPrecision: 5,
    cells: [{ cell: "c23nb", places: 2, hash: "x", bytes: 1, ...(geom ? { geomHash: "y" } : {}) }],
  };
  await writeFile(join(versionDir, "index.json"), JSON.stringify(index));
  await writeFile(
    join(versionDir, "manifest.json"),
    JSON.stringify({ mediaProfile: { format: "image/webp" } }),
  );
  await writeFile(join(versionDir, "dict.json"), "{}");
  await writeFile(join(versionDir, "cells/c23nb.json"), JSON.stringify(tile));
  if (geom) await writeFile(join(versionDir, "cells/c23nb.geom.json"), "{}");
  if (over.blob ?? true) {
    const blob = blobPath(dir, HASH);
    await mkdir(dirname(blob), { recursive: true });
    await writeFile(blob, Buffer.from("webp-bytes"));
  }
}

let root: string;
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "cartographer-upload-"));
  await writeTree(root);
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

/** Records every put in order; pretends `present` already exists in the bucket. */
function fakeStore(present: string[] = []) {
  const puts: { key: string; contentType: string; cacheControl: string }[] = [];
  const store: ObjectStore = {
    list: async () => new Set(present),
    put: async (key, _file: VolumeFile, contentType, cacheControl) => {
      puts.push({ key, contentType, cacheControl });
      return 10;
    },
  };
  return { store, puts };
}

const upload = (store: ObjectStore, over: { prefix?: string; dryRun?: boolean } = {}) =>
  uploadVolume(store, {
    outDir: root,
    version: VERSION,
    prefix: over.prefix ?? "us-west",
    dryRun: over.dryRun ?? false,
    log: () => {},
  });

describe("normalizePrefix — one spelling for the flag and the env default", () => {
  it("trims and strips the slashes a bucket key must not carry", () => {
    expect(normalizePrefix(" /atlas/ ")).toBe("atlas");
    expect(normalizePrefix("atlas/us-west")).toBe("atlas/us-west");
    expect(normalizePrefix("")).toBe("");
  });
});

describe("volumeImportUrl — the volume root, so an import follows latest.json", () => {
  it("names the root under the prefix, never a version", () => {
    expect(volumeImportUrl("https://atlas.example.org/", "us-west")).toBe(
      "https://atlas.example.org/us-west/",
    );
    expect(volumeImportUrl("https://atlas.example.org", "")).toBe("https://atlas.example.org/");
  });

  it("says where the origin goes when the public URL is not set", () => {
    expect(volumeImportUrl(undefined, "us-west")).toBe("<your bucket's public origin>/us-west/");
  });
});

describe("s3StoreFromEnv — the one reader of the CARTOGRAPHER_S3_* family", () => {
  it("resolves the standing prefix default beside the bucket", () => {
    const { bucket, defaultPrefix } = s3StoreFromEnv({
      CARTOGRAPHER_S3_BUCKET: "beacon",
      CARTOGRAPHER_S3_PREFIX: "/atlas/",
      CARTOGRAPHER_S3_ACCESS_KEY_ID: "k",
      CARTOGRAPHER_S3_SECRET_ACCESS_KEY: "s",
    });
    expect(bucket).toBe("beacon");
    expect(defaultPrefix).toBe("atlas");
  });

  it("reads the public origin when set, and leaves it unknown otherwise", () => {
    const base = {
      CARTOGRAPHER_S3_BUCKET: "beacon",
      CARTOGRAPHER_S3_ACCESS_KEY_ID: "k",
      CARTOGRAPHER_S3_SECRET_ACCESS_KEY: "s",
    };
    expect(
      s3StoreFromEnv({ ...base, CARTOGRAPHER_S3_PUBLIC_URL: " https://atlas.example.org " })
        .publicUrl,
    ).toBe("https://atlas.example.org");
    expect(s3StoreFromEnv(base).publicUrl).toBeUndefined();
  });

  it("refuses to run without the bucket, naming the variable", () => {
    expect(() => s3StoreFromEnv({})).toThrow(/CARTOGRAPHER_S3_BUCKET/);
  });
});

describe("uploadVolume", () => {
  it("ships the whole tree under the prefix, latest.json strictly last", async () => {
    const { store, puts } = fakeStore();
    const report = await upload(store);
    // latest + manifest + index + dict + tile + geom tile + 1 blob
    expect(report).toMatchObject({ uploaded: 7, skipped: 0, media: 1, missing: 0 });
    expect(puts.at(-1)?.key).toBe("us-west/latest.json");
    expect(puts.map((p) => p.key)).toContain(`us-west/${VERSION}/cells/c23nb.geom.json`);
    // Media Content-Type comes from the manifest's profile; everything else is JSON. The pointer
    // is the one short-lived object — every immutable file says so to caches.
    const media = puts.find((p) => p.key.startsWith("us-west/media/"));
    expect(media?.contentType).toBe("image/webp");
    expect(media?.cacheControl).toContain("immutable");
    expect(puts.at(-1)?.cacheControl).not.toContain("immutable");
  });

  it("re-run uploads ONLY the pointer — immutables skip, so any failure resumes for free", async () => {
    const first = fakeStore();
    await upload(first.store);
    const again = fakeStore(first.puts.map((p) => p.key));
    const report = await upload(again.store);
    expect(report).toMatchObject({ uploaded: 1, skipped: 6 });
    expect(again.puts.map((p) => p.key)).toEqual(["us-west/latest.json"]);
  });

  it("dry-run puts nothing and says what it would do", async () => {
    const { store, puts } = fakeStore();
    const report = await upload(store, { dryRun: true });
    expect(puts).toEqual([]);
    expect(report).toMatchObject({ uploaded: 0, dryRun: true });
  });

  it("a referenced photo with no blob is counted, never uploaded as a broken key", async () => {
    const gone = await mkdtemp(join(tmpdir(), "cartographer-upload-gone-"));
    try {
      await writeTree(gone, { blob: false, geom: false });
      const tree = await volumeTree(gone, VERSION);
      expect(tree).toMatchObject({ media: 0, missing: 1, mediaFormat: "image/webp" });
      expect(tree.files.some((file) => file.kind === "media")).toBe(false);
    } finally {
      await rm(gone, { recursive: true, force: true });
    }
  });
});
