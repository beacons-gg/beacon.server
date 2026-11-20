/**
 * `upload` — push a published version to S3-compatible object storage (R2, Spaces, S3).
 *
 * What goes up is `tree.ts`'s enumeration — the same file list `pack` zips — so the hosted tree and
 * the shareable archive cannot drift. The rest is the volume format doing the work:
 *
 * - A version directory is **immutable** and media is **content-addressed**, so everything except
 *   `latest.json` is skip-if-present. A re-run resumes after any failure, and uploading a new
 *   version over an old pool touches only what is new — the README's "a re-sync uploads only new
 *   content-addressed blobs", now without the aws CLI.
 * - `latest.json` uploads **last, always**: it is the one mutable pointer, and a reader must never
 *   see it name a version whose tree is still arriving.
 * - Version files and media get an immutable cache header (they never change under their key);
 *   `latest.json` a short one (it is how a consumer discovers a new version).
 *
 * The client is the same `@aws-sdk/client-s3` + endpoint/forcePathStyle shape the beacon server's
 * media backend already uses — R2 and Spaces speak it verbatim. Reads stay public and untrusted by
 * design (the importer verifies every byte against the signed manifest); these credentials are for
 * WRITING, and belong to the operator's bucket alone.
 */
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { ListObjectsV2Command, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { volumeTree, type VolumeFile } from "./tree";

/** The two write shapes `upload` needs — a seam, so a test never talks to a bucket. */
export interface ObjectStore {
  /** Every key under `prefix`, however many pages that takes. */
  list(prefix: string): Promise<Set<string>>;
  /** Store one file. Returns the bytes sent. */
  put(key: string, file: VolumeFile, contentType: string, cacheControl: string): Promise<number>;
}

export interface UploadReport {
  version: string;
  prefix: string;
  uploaded: number;
  skipped: number;
  bytes: number;
  /** Distinct photos the version references. */
  media: number;
  /** Referenced photos with no blob on disk — not uploadable; `media --retry` recovers them. */
  missing: number;
  dryRun: boolean;
}

export interface UploadOptions {
  outDir: string;
  version: string;
  /** Key prefix the tree lands under — the `<volume>/` role. Empty = the bucket root. */
  prefix: string;
  dryRun: boolean;
  log: (message: string) => void;
}

/** Version files and media never change under their key — say so to every cache in the path. */
const IMMUTABLE = "public, max-age=31536000, immutable";
/** The one mutable pointer — how a consumer discovers a new version, so it must go stale fast. */
const LATEST = "public, max-age=60";

/**
 * How many puts fly at once. Small objects make this latency-bound, not bandwidth-bound: at ~150 ms
 * per round trip, 8 workers sustain only ~3.5 MB/s against a 3.7 GB pool — 32 keeps the uplink busy
 * and stays well under the SDK's 50-socket default.
 */
const CONCURRENCY = 32;

export async function uploadVolume(store: ObjectStore, opts: UploadOptions): Promise<UploadReport> {
  // Independent: the walk is local disk, the LIST is the network. Neither waits for the other.
  const [tree, existing] = await Promise.all([
    volumeTree(opts.outDir, opts.version),
    store.list(opts.prefix),
  ]);
  const keyOf = (file: VolumeFile): string =>
    opts.prefix ? `${opts.prefix}/${file.path}` : file.path;
  const typeOf = (file: VolumeFile): string =>
    file.kind === "media" ? tree.mediaFormat : "application/json";

  const base = {
    version: opts.version,
    prefix: opts.prefix,
    media: tree.media,
    missing: tree.missing,
    dryRun: opts.dryRun,
  };

  // Everything except the pointer is immutable under its key, so present = done; `latest.json` is
  // ALWAYS rewritten, strictly after the rest — it never enters this queue.
  const queue = tree.files.filter((file) => file.kind !== "latest" && !existing.has(keyOf(file)));
  const skipped = tree.files.length - 1 - queue.length;
  const latest = tree.files.find((file) => file.kind === "latest");

  if (opts.dryRun) {
    opts.log(
      `dry-run: would upload ${queue.length + 1} file(s) (${skipped} already present), ` +
        `${tree.media} photo(s) referenced`,
    );
    return { ...base, uploaded: 0, skipped, bytes: 0 };
  }

  let uploaded = 0;
  let bytes = 0;
  let next = 0;
  const worker = async (): Promise<void> => {
    for (let file = queue[next++]; file !== undefined; file = queue[next++]) {
      bytes += await store.put(keyOf(file), file, typeOf(file), IMMUTABLE);
      uploaded += 1;
      if (uploaded % 2000 === 0) opts.log(`  ${uploaded}/${queue.length} uploaded …`);
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, worker));

  if (latest) {
    bytes += await store.put(keyOf(latest), latest, "application/json", LATEST);
    uploaded += 1;
  }
  return { ...base, uploaded, skipped, bytes };
}

/**
 * A key prefix as the bucket wants it: trimmed (the S3 env family's convention), no
 * leading/trailing slashes (the tree's own paths carry none). One spelling, used by the `--prefix`
 * flag and the `CARTOGRAPHER_S3_PREFIX` default alike.
 */
export function normalizePrefix(raw: string): string {
  return raw.trim().replace(/^\/+|\/+$/g, "");
}

/**
 * The URL an operator gives a Beacon server to import the volume: its **root**, where `latest.json`
 * lives. A server reads `latest.json` there and follows it to the current version, so an import from
 * this URL picks up every later upload too; a version URL would pin the import to one version. The
 * bucket's public origin is only known when `CARTOGRAPHER_S3_PUBLIC_URL` says it, since the S3 API
 * endpoint is not where the public reads.
 */
export function volumeImportUrl(publicUrl: string | undefined, prefix: string): string {
  const origin = publicUrl?.trim().replace(/\/+$/, "") || "<your bucket's public origin>";
  return `${origin}/${prefix ? `${prefix}/` : ""}`;
}

/** A required env var, or an error that says what to set — the same rule every stage follows. */
export function required(
  env: Record<string, string | undefined>,
  name: string,
  what: string,
): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is not set — it must be ${what}`);
  return value;
}

/**
 * The real store, from `CARTOGRAPHER_S3_*` — the ONE reader of that env family. Endpoint absent =
 * AWS itself; for R2 it is `https://<account-id>.r2.cloudflarestorage.com` and the region stays
 * `auto`. `defaultPrefix` is where the tree lands when `--prefix` is not given.
 */
export function s3StoreFromEnv(env: Record<string, string | undefined>): {
  store: ObjectStore;
  bucket: string;
  defaultPrefix: string;
  publicUrl: string | undefined;
} {
  const bucket = required(env, "CARTOGRAPHER_S3_BUCKET", "the bucket volumes upload into");
  const defaultPrefix = normalizePrefix(env["CARTOGRAPHER_S3_PREFIX"] ?? "");
  const endpoint = env["CARTOGRAPHER_S3_ENDPOINT"]?.trim();
  const client = new S3Client({
    region: env["CARTOGRAPHER_S3_REGION"]?.trim() || "auto",
    credentials: {
      accessKeyId: required(
        env,
        "CARTOGRAPHER_S3_ACCESS_KEY_ID",
        "a key that may write the bucket",
      ),
      secretAccessKey: required(env, "CARTOGRAPHER_S3_SECRET_ACCESS_KEY", "its secret"),
    },
    forcePathStyle: env["CARTOGRAPHER_S3_FORCE_PATH_STYLE"] === "1",
    ...(endpoint ? { endpoint } : {}),
  });
  return {
    bucket,
    defaultPrefix,
    publicUrl: env["CARTOGRAPHER_S3_PUBLIC_URL"]?.trim() || undefined,
    store: {
      async list(prefix: string): Promise<Set<string>> {
        const keys = new Set<string>();
        let token: string | undefined;
        do {
          const page = await client.send(
            new ListObjectsV2Command({
              Bucket: bucket,
              ...(prefix ? { Prefix: `${prefix}/` } : {}),
              ...(token ? { ContinuationToken: token } : {}),
            }),
          );
          for (const object of page.Contents ?? []) {
            if (object.Key !== undefined) keys.add(object.Key);
          }
          token = page.IsTruncated ? page.NextContinuationToken : undefined;
        } while (token);
        return keys;
      },
      async put(key, file, contentType, cacheControl): Promise<number> {
        const length =
          file.kind === "latest"
            ? file.content.length
            : (file.bytes ?? (await stat(file.disk)).size);
        await client.send(
          new PutObjectCommand({
            Bucket: bucket,
            Key: key,
            Body: file.kind === "latest" ? file.content : createReadStream(file.disk),
            ContentLength: length,
            ContentType: contentType,
            CacheControl: cacheControl,
          }),
        );
        return length;
      },
    },
  };
}
