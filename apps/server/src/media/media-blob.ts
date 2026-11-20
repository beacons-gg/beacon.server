import { createReadStream, type Dirent } from "node:fs";
import { mkdir, open, readdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Readable } from "node:stream";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import type { ServerConfig } from "../config";
import { liveView } from "../settings/live-config";

/** The `Cache-Control` every stored object carries: content is immutable, the address IS the hash. */
export const MEDIA_CACHE_CONTROL = "public, max-age=31536000, immutable";

/** DI token for the {@link MediaBlobStore} (fs/s3 byte backend), built from config in the app module. */
export const MEDIA_BLOB = "BEACON_MEDIA_BLOB";

/**
 * How to serve a stored blob (`doc/spec/mailbox-and-media.md` §5.3): a **stream** the app pipes to
 * the client (fs, or S3 with no CDN — never fully buffered, so a large object doesn't sit resident
 * per request), or a **redirect** to a public URL (S3 + CDN — bytes never proxy through us).
 */
export type BlobLocation = { kind: "stream"; stream: Readable } | { kind: "redirect"; url: string };

/**
 * Content-addressed byte store for media (`doc/spec/mailbox-and-media.md` §5.4). The metadata index
 * lives in the SQL {@link MediaStore}; this holds only the bytes, keyed by their content `hash`.
 */
export interface MediaBlobStore {
  /** Store bytes content-addressed. `contentType` is used by object stores that serve directly (S3/CDN). */
  put(hash: string, bytes: Buffer, contentType: string, signal?: AbortSignal): Promise<void>;
  /** How to serve the blob — a stream to pipe, or a URL to redirect to. Undefined if the blob is missing. */
  locate(hash: string): Promise<BlobLocation | undefined>;
  /**
   * The bytes themselves, always from the backend and never a CDN redirect: a backup must read what
   * this server actually holds, not what a CDN answers. Undefined only if the object is absent; any
   * other failure rejects, so a caller can tell a missing file from a backend having a bad moment.
   * `signal` ends the read, the stream included.
   */
  read(hash: string, signal?: AbortSignal): Promise<Readable | undefined>;
  /**
   * Every stored object's hash and size, read once rather than asked about file by file, which is
   * what a restore's second pass runs on while the server is locked. A backend failure rejects.
   */
  list(signal?: AbortSignal): AsyncIterable<{ hash: string; size: number }>;
  /** Delete the bytes (admin moderation — `doc/spec/admin-api.md` §3). Idempotent: missing is a no-op. */
  delete(hash: string): Promise<void>;
  close?(): void | Promise<void>;
}

/** Content-addressed object key: `<prefix><hash[0:2]>/<hash>` (sharded; hash is base64url → path-safe). */
export function blobKey(hash: string, prefix = ""): string {
  return `${prefix}${hash.slice(0, 2)}/${hash}`;
}

/**
 * Local-filesystem blob backend — the dev/self-host twin. Files are content-addressed and sharded
 * so one directory doesn't accumulate every blob. Served by streaming through the app (the app sets
 * the content-type from the SQL metadata), so `put` ignores `contentType`. Writes are idempotent.
 */
export class FsMediaBlobStore implements MediaBlobStore {
  constructor(private readonly dir: string) {}

  private pathFor(hash: string): string {
    return join(this.dir, blobKey(hash));
  }

  async put(
    hash: string,
    bytes: Buffer,
    _contentType?: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const path = this.pathFor(hash);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, bytes, signal ? { signal } : {});
  }

  async locate(hash: string): Promise<BlobLocation | undefined> {
    const path = this.pathFor(hash);
    try {
      await stat(path); // cheap existence check (keeps 404-on-missing); the bytes then stream, not buffer
    } catch {
      return undefined; // ENOENT (or unreadable) → treat as missing
    }
    return { kind: "stream", stream: createReadStream(path) };
  }

  async read(hash: string, signal?: AbortSignal): Promise<Readable | undefined> {
    try {
      // Opened here rather than left to the stream, so a failure to open is answered now and only
      // ENOENT reads as absent: EACCES or EIO must not look like a file that was never there.
      const file = await open(this.pathFor(hash));
      // A stream handed an already-aborted signal errors with nobody listening yet, which crashes.
      if (signal?.aborted) {
        await file.close();
        throw signal.reason as Error;
      }
      return file.createReadStream(signal ? { signal } : {});
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw err;
    }
  }

  async *list(signal?: AbortSignal): AsyncGenerator<{ hash: string; size: number }> {
    for (const shard of await this.entries(this.dir)) {
      if (!shard.isDirectory()) continue;
      for (const file of await this.entries(join(this.dir, shard.name))) {
        signal?.throwIfAborted();
        // Only what `blobKey` would write, as the S3 backend's listing does.
        if (file.isFile() && file.name.slice(0, 2) === shard.name) {
          const { size } = await stat(join(this.dir, shard.name, file.name));
          yield { hash: file.name, size };
        }
      }
    }
  }

  /** A directory's entries; a directory that is not there has none. */
  private async entries(dir: string): Promise<Dirent[]> {
    try {
      return await readdir(dir, { withFileTypes: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
  }

  async delete(hash: string): Promise<void> {
    try {
      await rm(this.pathFor(hash));
    } catch {
      /* ENOENT → already gone (idempotent) */
    }
  }
}

/**
 * Whether an S3 SDK error means the object is absent, rather than a request failing. A missing
 * bucket is a 404 too and is not an absent object: it means the configuration is wrong.
 */
export function isS3NotFound(err: unknown): boolean {
  const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
  if (e.name === "NoSuchBucket") return false;
  return e.$metadata?.httpStatusCode === 404 || e.name === "NoSuchKey" || e.name === "NotFound";
}

export interface S3BlobOptions {
  endpoint?: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle: boolean;
  prefix: string;
  /** Public CDN base; set ⇒ `locate` redirects here instead of streaming through the app. */
  /**
   * `?: string | undefined` rather than `?: string`, because this one is **read per request**: it is
   * an operator-editable setting (`BEACON_MEDIA_CDN_URL`) and `createMediaBlob` passes it through as
   * an accessor, so the property is always present and its value is whatever is in force now.
   */
  cdnUrl?: string | undefined;
}

/**
 * S3-compatible blob backend (`doc/spec/mailbox-and-media.md` §5.4): works with **Cloudflare R2**,
 * **DigitalOcean Spaces**, and AWS S3 via a configurable `endpoint` + `region` + credentials.
 *
 * Uploads set an **immutable** `Cache-Control` + `ContentType` (content is immutable — the address IS
 * the hash). Serving: with a public `cdnUrl` configured, `locate` returns a **redirect** to
 * `<cdnUrl>/<key>` so the bytes are served by the CDN/bucket directly (the model for R2/DO public
 * buckets); without one, it **streams the object through the app** as a fallback. Object existence is
 * gated upstream by the SQL metadata store, so `locate`'s redirect path issues no S3 call.
 */
export class S3MediaBlobStore implements MediaBlobStore {
  private readonly client: S3Client;
  private readonly bucket: string;
  private readonly prefix: string;
  /**
   * Read from the options per {@link locate}, never copied into a field.
   *
   * `mediaCdnUrl` is a runtime setting, and this is its only consumer. Copying it at construction
   * made it the one key an operator could set, see reported back as set, and have no effect until
   * the next restart — on the s3 backend that is the whole serving path
   * (`doc/spec/runtime-settings.md` §5: an accessor chain has to be lazy at every hop).
   */
  private get cdnUrl(): string | undefined {
    return this.opts.cdnUrl;
  }

  constructor(private readonly opts: S3BlobOptions) {
    this.client = new S3Client({
      region: opts.region,
      forcePathStyle: opts.forcePathStyle,
      credentials: { accessKeyId: opts.accessKeyId, secretAccessKey: opts.secretAccessKey },
      ...(opts.endpoint ? { endpoint: opts.endpoint } : {}),
    });
    this.bucket = opts.bucket;
    this.prefix = opts.prefix;
  }

  async put(hash: string, bytes: Buffer, contentType: string, signal?: AbortSignal): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: blobKey(hash, this.prefix),
        Body: bytes,
        ContentType: contentType,
        CacheControl: MEDIA_CACHE_CONTROL,
      }),
      signal ? { abortSignal: signal } : {},
    );
  }

  async locate(hash: string): Promise<BlobLocation | undefined> {
    const key = blobKey(hash, this.prefix);
    if (this.cdnUrl) return { kind: "redirect", url: `${this.cdnUrl}/${key}` };
    // Stream-through fallback (no public CDN configured): pipe the object's body rather than buffering
    // it — the SDK's Node `Body` is a Readable, so a large object never sits fully resident.
    try {
      const out = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
      if (!out.Body) return undefined;
      return { kind: "stream", stream: out.Body as unknown as Readable };
    } catch {
      return undefined; // NoSuchKey / network → treat as missing (SQL is the source of truth)
    }
  }

  async read(hash: string, signal?: AbortSignal): Promise<Readable | undefined> {
    try {
      const out = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: blobKey(hash, this.prefix) }),
        signal ? { abortSignal: signal } : {},
      );
      return out.Body as unknown as Readable | undefined;
    } catch (err) {
      if (isS3NotFound(err)) return undefined;
      throw err;
    }
  }

  async *list(signal?: AbortSignal): AsyncGenerator<{ hash: string; size: number }> {
    let token: string | undefined;
    do {
      const page = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: this.prefix,
          ...(token !== undefined ? { ContinuationToken: token } : {}),
        }),
        signal ? { abortSignal: signal } : {},
      );
      for (const object of page.Contents ?? []) {
        const hash = object.Key?.split("/").pop() ?? "";
        // Only what `blobKey` would write: a bucket can hold other things under the same prefix.
        if (object.Key === blobKey(hash, this.prefix)) yield { hash, size: object.Size ?? 0 };
      }
      token = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (token !== undefined);
  }

  async delete(hash: string): Promise<void> {
    // S3 DeleteObject is idempotent (204 for a missing key) — no existence check needed.
    await this.client.send(
      new DeleteObjectCommand({ Bucket: this.bucket, Key: blobKey(hash, this.prefix) }),
    );
  }

  close(): void {
    this.client.destroy();
  }
}

/** Build the blob backend from config (mirrors the store factory's one-switch selection). */
export function createMediaBlob(config: ServerConfig): MediaBlobStore {
  if (config.mediaBackend !== "s3") return new FsMediaBlobStore(config.mediaDir);

  const { mediaS3Bucket, mediaS3AccessKeyId, mediaS3SecretAccessKey } = config;
  if (!mediaS3Bucket || !mediaS3AccessKeyId || !mediaS3SecretAccessKey) {
    throw new Error(
      "BEACON_MEDIA_BACKEND=s3 requires BEACON_MEDIA_S3_BUCKET, BEACON_MEDIA_S3_ACCESS_KEY_ID, and " +
        "BEACON_MEDIA_S3_SECRET_ACCESS_KEY (mailbox-and-media.md §5.4).",
    );
  }
  // `Object.assign` onto a live view, not a spread: everything else here is deploy-time and copying
  // it is right, but `mediaCdnUrl` is operator-editable and a spread would read the accessor once and
  // pin the redirect target to whatever it was at boot.
  return new S3MediaBlobStore(
    Object.assign(liveView(config, { cdnUrl: "mediaCdnUrl" }), {
      region: config.mediaS3Region,
      bucket: mediaS3Bucket,
      accessKeyId: mediaS3AccessKeyId,
      secretAccessKey: mediaS3SecretAccessKey,
      forcePathStyle: config.mediaS3ForcePathStyle,
      prefix: config.mediaS3Prefix,
      ...(config.mediaS3Endpoint ? { endpoint: config.mediaS3Endpoint } : {}),
    }),
  );
}
