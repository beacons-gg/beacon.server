import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import { lookup as dnsLookupAll } from "node:dns/promises";
import { Agent as HttpAgent } from "node:http";
import { Agent as HttpsAgent } from "node:https";
import { BlockList, isIP, type LookupFunction } from "node:net";
import type { Readable } from "node:stream";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  type ListObjectsV2CommandOutput,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import type { BackupS3Target } from "@beaconsgg/protocol-types";
import { isS3NotFound } from "../media/media-blob";

/** Optional headers an object is stored with. */
export interface BackupObjectMeta {
  contentType?: string;
  cacheControl?: string;
}

/**
 * Multipart settings for a streamed upload. 2 parts in flight of 8 MiB each keeps a table's upload
 * to about 16 MiB of memory however large the table is, which a 512 MB tenant can spare.
 */
const STREAM_PART_BYTES = 8 * 1024 * 1024;
const STREAM_QUEUE = 2;

/** Run several deletes at once, but few: a run has only a handful of old files to clear. */
const REMOVE_CONCURRENCY = 4;

/** How long a connection may take to open. */
const CONNECTION_TIMEOUT_MS = 10_000;

/**
 * How long a socket may sit with no bytes moving. An idle limit and deliberately not a request
 * limit: one part of a large table on a slow link can take minutes and is healthy all the while,
 * and without any limit a stalled transfer would hold the only run slot forever.
 */
const SOCKET_IDLE_TIMEOUT_MS = 60_000;

/** A destination this server will not talk to: the operator's input, so a 400. */
export class BackupEndpointError extends Error {}

/** Every address that is not on the public internet, IPv4-mapped IPv6 included (`BlockList` does that). */
const NON_PUBLIC = new BlockList();
for (const [network, bits] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10], // carrier-grade NAT
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) {
  NON_PUBLIC.addSubnet(network, bits, "ipv4");
}
for (const [network, bits] of [
  ["::", 128],
  ["::1", 128],
  ["64:ff9b::", 96], // NAT64, an IPv4 address in disguise
  ["100::", 64],
  ["2001::", 32], // Teredo
  ["2001:db8::", 32],
  ["2002::", 16], // 6to4
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
] as const) {
  NON_PUBLIC.addSubnet(network, bits, "ipv6");
}

/** Whether an IP literal is loopback, private, link-local or otherwise not a public address. */
export function isNonPublicAddress(address: string): boolean {
  return NON_PUBLIC.check(address, isIP(address) === 6 ? "ipv6" : "ipv4");
}

function refusal(host: string, address?: string): BackupEndpointError {
  return new BackupEndpointError(
    `the backup endpoint ${host}${address !== undefined && address !== host ? ` resolves to ${address}, which` : ""} ` +
      "is not a public address, and BEACON_BACKUP_PRIVATE_ENDPOINTS is off on this server",
  );
}

/** How {@link checkBackupEndpoint} resolves a name: every address, as a connection would see them. */
export type EndpointResolver = (host: string) => Promise<readonly { address: string }[]>;

/**
 * Refuse a destination on the server's own network when `allowPrivate` is off, for a hoster whose
 * admins must not be able to aim a job at internal addresses. Backup and restore both call this
 * before they start; an absent endpoint is AWS.
 *
 * This is the clear answer at the door. {@link BackupBucket} checks again as each connection opens,
 * because a name that was public a moment ago can be re-pointed by whoever controls its DNS.
 */
export async function checkBackupEndpoint(
  target: Pick<BackupS3Target, "endpoint">,
  allowPrivate: boolean,
  resolve: EndpointResolver = (host) => dnsLookupAll(host, { all: true }),
): Promise<void> {
  if (allowPrivate || target.endpoint === undefined) return;
  const host = new URL(target.endpoint).hostname.replace(/^\[|\]$/g, "");
  if (isIP(host) !== 0) {
    if (isNonPublicAddress(host)) throw refusal(host);
    return;
  }
  let addresses: readonly { address: string }[];
  try {
    addresses = await resolve(host);
  } catch {
    throw new BackupEndpointError(`the backup endpoint ${host} could not be resolved`);
  }
  const bad = addresses.find((a) => isNonPublicAddress(a.address));
  if (bad) throw refusal(host, bad.address);
}

/** A socket `lookup` that refuses to connect to a non-public address, however the name resolved. */
const publicOnlyLookup = ((
  hostname: string,
  options: { all?: boolean },
  callback: (err: Error | null, address?: unknown, family?: number) => void,
): void => {
  dnsLookup(hostname, { ...options, all: true }, (err, addresses: LookupAddress[]) => {
    if (err) {
      callback(err);
      return;
    }
    const bad = addresses.find((a) => isNonPublicAddress(a.address));
    const first = addresses[0];
    if (bad) callback(refusal(hostname, bad.address));
    else if (options.all) callback(null, addresses);
    else callback(null, first?.address, first?.family);
  });
}) as LookupFunction;

/** How a {@link BackupBucket} connects. */
export interface BackupBucketOptions {
  /** `BEACON_BACKUP_PRIVATE_ENDPOINTS`: off, and a connection to a non-public address is refused. */
  allowPrivateEndpoints: boolean;
  connectionTimeoutMs?: number;
  socketTimeoutMs?: number;
}

/**
 * One backup destination, addressed by paths relative to its prefix (`media/ab/ab...`, `manifest.json`).
 * Backup and restore share it, so everything S3 stays behind this interface and the credentials
 * stay in the client that holds them. Nothing here logs.
 */
export class BackupBucket {
  private readonly client: S3Client;
  private readonly bucket: string;
  private readonly root: string;

  constructor(
    target: BackupS3Target,
    private readonly signal: AbortSignal,
    options: BackupBucketOptions,
  ) {
    const agentOptions = {
      keepAlive: true,
      ...(options.allowPrivateEndpoints ? {} : { lookup: publicOnlyLookup }),
    };
    this.client = new S3Client({
      requestHandler: {
        connectionTimeout: options.connectionTimeoutMs ?? CONNECTION_TIMEOUT_MS,
        socketTimeout: options.socketTimeoutMs ?? SOCKET_IDLE_TIMEOUT_MS,
        httpAgent: new HttpAgent(agentOptions),
        httpsAgent: new HttpsAgent(agentOptions),
      },
      region: target.region,
      forcePathStyle: target.forcePathStyle,
      credentials: { accessKeyId: target.accessKeyId, secretAccessKey: target.secretAccessKey },
      ...(target.endpoint !== undefined ? { endpoint: target.endpoint } : {}),
      // The SDK's default adds trailing checksums that S3-compatible stores (MinIO, R2, Spaces) do
      // not all accept, and an owner chooses the store. A file's integrity is covered by the
      // SHA-256 check before upload and the manifest's sizes after it.
      requestChecksumCalculation: "WHEN_REQUIRED",
      responseChecksumValidation: "WHEN_REQUIRED",
    });
    this.bucket = target.bucket;
    this.root = `${target.prefix}/`;
  }

  private key(path: string): string {
    return `${this.root}${path}`;
  }

  /** Every page of a listing under `path`. */
  private async *listPages(
    path: string,
    delimiter?: string,
  ): AsyncGenerator<ListObjectsV2CommandOutput> {
    let token: string | undefined;
    do {
      const page = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: this.key(path),
          ...(delimiter !== undefined ? { Delimiter: delimiter } : {}),
          ...(token !== undefined ? { ContinuationToken: token } : {}),
        }),
        { abortSignal: this.signal },
      );
      yield page;
      token = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (token !== undefined);
  }

  /** The size of every object under `path`, keyed by its path relative to the prefix. */
  async objectSizes(path: string): Promise<Map<string, number>> {
    const sizes = new Map<string, number>();
    for await (const page of this.listPages(path)) {
      for (const object of page.Contents ?? []) {
        if (object.Key !== undefined) {
          sizes.set(object.Key.slice(this.root.length), object.Size ?? 0);
        }
      }
    }
    return sizes;
  }

  /** The object's bytes, or undefined when it is absent; any other failure rejects. */
  async read(path: string, signal?: AbortSignal): Promise<Readable | undefined> {
    try {
      const out = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: this.key(path) }),
        { abortSignal: signal ? AbortSignal.any([this.signal, signal]) : this.signal },
      );
      return out.Body as unknown as Readable | undefined;
    } catch (err) {
      if (isS3NotFound(err)) return undefined;
      throw err;
    }
  }

  /** A small object as text, refusing one over `maxBytes`; undefined when it is absent. */
  async readText(path: string, maxBytes: number): Promise<string | undefined> {
    const body = await this.read(path);
    if (body === undefined) return undefined;
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of body) {
      total += (chunk as Buffer).length;
      if (total > maxBytes) {
        body.destroy();
        throw new Error(`${path} is larger than ${maxBytes} bytes`);
      }
      chunks.push(chunk as Buffer);
    }
    return Buffer.concat(chunks).toString("utf8");
  }

  async put(path: string, body: Buffer | string, meta: BackupObjectMeta = {}): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: this.key(path),
        Body: body,
        ...(meta.contentType !== undefined ? { ContentType: meta.contentType } : {}),
        ...(meta.cacheControl !== undefined ? { CacheControl: meta.cacheControl } : {}),
      }),
      { abortSignal: this.signal },
    );
  }

  /** Stream `body` of unknown length: multipart above one part, a plain put below it. */
  async putStream(path: string, body: Readable, meta: BackupObjectMeta = {}): Promise<void> {
    const upload = new Upload({
      client: this.client,
      queueSize: STREAM_QUEUE,
      partSize: STREAM_PART_BYTES,
      params: {
        Bucket: this.bucket,
        Key: this.key(path),
        Body: body,
        ...(meta.contentType !== undefined ? { ContentType: meta.contentType } : {}),
        ...(meta.cacheControl !== undefined ? { CacheControl: meta.cacheControl } : {}),
      },
    });
    const abort = (): void => void upload.abort();
    this.signal.addEventListener("abort", abort);
    try {
      await upload.done();
    } finally {
      this.signal.removeEventListener("abort", abort);
    }
  }

  /** Remove one object. Idempotent: S3 answers 204 for a key that is not there. */
  async remove(path: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: this.key(path) }), {
      abortSignal: this.signal,
    });
  }

  /** The direct child "folders" of `path`, by name (`db/` lists `<timestamp>`). */
  async folders(path: string): Promise<string[]> {
    const keyPrefix = this.key(path);
    const names: string[] = [];
    for await (const page of this.listPages(path, "/")) {
      for (const entry of page.CommonPrefixes ?? []) {
        if (entry.Prefix !== undefined) {
          names.push(entry.Prefix.slice(keyPrefix.length).replace(/\/$/, ""));
        }
      }
    }
    return names;
  }

  /** Remove every object under `path`. Paged, so a large folder never sits in memory. */
  async removeTree(path: string): Promise<void> {
    for await (const page of this.listPages(path)) {
      const keys = (page.Contents ?? []).flatMap((c) => (c.Key !== undefined ? [c.Key] : []));
      for (let i = 0; i < keys.length; i += REMOVE_CONCURRENCY) {
        await Promise.all(
          keys.slice(i, i + REMOVE_CONCURRENCY).map((Key) =>
            this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key }), {
              abortSignal: this.signal,
            }),
          ),
        );
      }
    }
  }

  close(): void {
    this.client.destroy();
  }
}
