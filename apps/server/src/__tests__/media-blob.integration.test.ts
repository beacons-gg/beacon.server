import type { Readable } from "node:stream";
import { sha256Base64url } from "@beaconsgg/identity";
import { describe, expect, it } from "vitest";
import { S3MediaBlobStore } from "../media/media-blob";

/**
 * Integration coverage for the **S3 blob backend's network path** (`PutObject` / `GetObject`
 * stream), which the unit tests can't reach (they only assert redirect-URL construction; the S3
 * backend is `doc/spec/mailbox-and-media.md` §5.4). Gated on `BEACON_TEST_S3_ENDPOINT` exactly like
 * the Postgres suites are gated on `BEACON_TEST_DATABASE_URL`: it runs against a MinIO / R2 / DO /
 * S3 endpoint when configured, and is **skipped** otherwise so `pnpm test` stays green with no
 * object store.
 *
 * Locally / in CI:
 *   docker run -d -p 9000:9000 -e MINIO_ROOT_USER=beacon -e MINIO_ROOT_PASSWORD=beacon-secret \
 *     pgsty/minio:RELEASE.2026-08-04T00-00-00Z server /data
 *   # create the bucket (mc), then:
 *   BEACON_TEST_S3_ENDPOINT=http://localhost:9000 BEACON_TEST_S3_BUCKET=beacon-media \
 *   BEACON_TEST_S3_ACCESS_KEY_ID=beacon BEACON_TEST_S3_SECRET_ACCESS_KEY=beacon-secret \
 *     pnpm --filter @beaconsgg/server-app test
 */

const endpoint = process.env["BEACON_TEST_S3_ENDPOINT"];
const suite = endpoint ? describe : describe.skip;

async function collect(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of stream) chunks.push(Buffer.from(c));
  return Buffer.concat(chunks);
}

suite("S3MediaBlobStore — integration (needs a MinIO / S3-compatible endpoint)", () => {
  const store = new S3MediaBlobStore({
    ...(endpoint ? { endpoint } : {}), // exactOptionalPropertyTypes: only set when present
    region: process.env["BEACON_TEST_S3_REGION"] ?? "us-east-1",
    bucket: process.env["BEACON_TEST_S3_BUCKET"] ?? "beacon-media",
    accessKeyId: process.env["BEACON_TEST_S3_ACCESS_KEY_ID"] ?? "",
    secretAccessKey: process.env["BEACON_TEST_S3_SECRET_ACCESS_KEY"] ?? "",
    forcePathStyle: true, // MinIO (and some DO setups) need path-style addressing
    prefix: "itest/",
  });

  it("puts an object and streams the exact bytes back (content-addressed round trip)", async () => {
    // Unique per run so a persistent bucket doesn't dedupe across runs; content-addressed key.
    const bytes = Buffer.from(`beacon-s3-itest ${new Date().toISOString()} ${process.pid}`);
    const hash = sha256Base64url(bytes);

    await store.put(hash, bytes, "application/octet-stream");
    const loc = await store.locate(hash);
    expect(loc?.kind).toBe("stream");
    if (loc?.kind !== "stream") throw new Error("expected a stream location");
    expect((await collect(loc.stream)).equals(bytes)).toBe(true);
  });

  it("reads the bytes back directly with `read`, and undefined for a missing object", async () => {
    const bytes = Buffer.from(`beacon-s3-itest-read ${new Date().toISOString()} ${process.pid}`);
    const hash = sha256Base64url(bytes);

    await store.put(hash, bytes, "application/octet-stream");
    const stream = await store.read(hash);
    if (!stream) throw new Error("expected a stream");
    expect((await collect(stream)).equals(bytes)).toBe(true);
    expect(
      await store.read(sha256Base64url(Buffer.from(`missing-read ${Date.now()}`))),
    ).toBeUndefined();
  });

  it("lists a stored object by hash and size", async () => {
    const bytes = Buffer.from(`beacon-s3-itest-list ${new Date().toISOString()} ${process.pid}`);
    const hash = sha256Base64url(bytes);
    await store.put(hash, bytes, "application/octet-stream");

    const found = new Map<string, number>();
    for await (const entry of store.list()) found.set(entry.hash, entry.size);
    expect(found.get(hash)).toBe(bytes.length);
  });

  it("returns undefined for a missing object", async () => {
    expect(
      await store.locate(sha256Base64url(Buffer.from(`missing ${Date.now()}`))),
    ).toBeUndefined();
  });
});
