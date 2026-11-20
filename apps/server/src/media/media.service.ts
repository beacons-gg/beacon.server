import { sha256Base64url } from "@beaconsgg/identity";
import { type DidKey, type MediaPutParams, formatGlobalId } from "@beaconsgg/protocol-types";
import { Injectable, type OnModuleDestroy } from "@nestjs/common";
import { DidRateLimiter } from "../common/did-rate-limit";
import { containsPrivacyMetadata } from "../common/media-metadata";
import type { ServerConfig } from "../config";
import { liveView } from "../settings/live-config";
import type { MediaCursor, MediaListPage, MediaListQuery, MediaStore } from "../stores/media-store";
import type { BlobLocation, MediaBlobStore } from "./media-blob";

/** Default page size for the admin media list when a request omits `limit` (`doc/spec/admin-api.md` §3). */
export const MEDIA_LIST_DEFAULT_LIMIT = 50;

/** Encode a keyset cursor as one opaque base64url token — the wire never sees its `(uploadedAt, hash, size)` shape. */
export function encodeMediaCursor(c: MediaCursor): string {
  return Buffer.from(JSON.stringify([c.uploadedAt, c.hash, c.size])).toString("base64url");
}
/** Decode an opaque cursor token back to `(uploadedAt, hash, size)`; `undefined` if malformed (the controller 400s). */
export function decodeMediaCursor(token: string): MediaCursor | undefined {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(token, "base64url").toString("utf8"));
    if (
      Array.isArray(parsed) &&
      parsed.length === 3 &&
      typeof parsed[0] === "string" &&
      typeof parsed[1] === "string" &&
      typeof parsed[2] === "number"
    ) {
      return { uploadedAt: parsed[0], hash: parsed[1], size: parsed[2] };
    }
  } catch {
    // malformed base64/JSON → an invalid cursor
  }
  return undefined;
}

/** The media knobs the service needs, lifted out of {@link ServerConfig} so it's easy to test. */
export interface MediaConfig {
  enabled: boolean;
  host: string; // for the `<hash>@host` address
  maxBytes: number;
  types: string[]; // MIME allowlist
  quotaBytes: number; // per-DID total
  /** `ServerConfig.mediaLimitBytes`. */
  limitBytes?: number | undefined;
  rateMax: number;
  rateWindowMs: number;
  /** Whether the server is locked read-only (live): a fetch still answers, and stamps nothing. */
  writeLocked: boolean;
}
/** The media slice, as accessors over the live config — see settings/live-config.ts. */
export function mediaConfigFrom(c: ServerConfig): MediaConfig {
  return liveView(c, {
    enabled: "mediaEnabled",
    host: "host",
    maxBytes: "mediaMaxBytes",
    types: "mediaTypes",
    quotaBytes: "mediaQuotaBytes",
    limitBytes: "mediaLimitBytes",
    rateMax: "mediaRateMax",
    rateWindowMs: "mediaRateWindowMs",
    writeLocked: "writeLocked",
  });
}

/** What {@link MediaService.ingestTrusted} answers when the bytes would take the store past its limit. */
export const STORAGE_FULL = "storageFull";

export type MediaPutResult =
  | { ok: true; id: string; deduped: boolean }
  | { ok: false; status: 400 | 413 | 415 | 422 | 429; error: string; message: string };

/** The metadata detector, injectable so tests can drive both accept/reject paths deterministically. */
export type MetadataDetector = (bytes: Buffer) => Promise<boolean>;

/**
 * Minimum spacing between `last_access_at` stamps for a single blob. The media GET is public,
 * unauthenticated, and un-rate-limited, so an un-throttled stamp would turn every fetch of a hot
 * blob into a DB write (a write-amplification DoS on the room-op write path). last-access is unused
 * for now (no auto-eviction, `doc/spec/mailbox-and-media.md` §5.6), so a coarse hourly stamp is
 * ample for the future eviction it records.
 */
const TOUCH_MIN_INTERVAL_MS = 60 * 60 * 1000;

/**
 * The media capability (`doc/spec/mailbox-and-media.md` §5): content-addressed, **public**,
 * verify-on-ingest storage. `put` validates the upload against its signed attestation and **never
 * mutates the bytes** (that would change the hash) — it re-hashes and rejects a mismatch, and
 * detects-and-rejects any EXIF/GPS metadata. `get` streams the exact stored bytes so a fetcher can
 * re-verify the hash.
 */
@Injectable()
export class MediaService implements OnModuleDestroy {
  private readonly limiter: DidRateLimiter;
  private readonly detect: MetadataDetector;
  private readonly now: () => number;

  constructor(
    private readonly store: MediaStore,
    private readonly blob: MediaBlobStore,
    private readonly cfg: MediaConfig,
    detect: MetadataDetector = containsPrivacyMetadata,
    now: () => number = () => Date.now(),
  ) {
    // A view, not a copy: pinning the two numbers here would fix the budget at boot, which is the
    // staleness this round removes. `DidRateLimiter` reads them per check.
    this.limiter = new DidRateLimiter(liveView(cfg, { windowMs: "rateWindowMs", max: "rateMax" }));
    this.detect = detect;
    this.now = now;
  }

  /** Release the blob backend on shutdown (drains the S3 client's sockets; fs is a no-op). */
  async onModuleDestroy(): Promise<void> {
    await this.blob.close?.();
  }

  get enabled(): boolean {
    return this.cfg.enabled;
  }

  /**
   * Ingest an upload: validate type/size, charge the per-DID rate, re-hash and reject a mismatch,
   * dedupe by content hash, detect-and-reject metadata, then check quota and store. Bytes are never
   * mutated. The rate check sits ahead of the expensive hash + exifr parse so a throttled flood is
   * rejected before it does that work (the cheap O(1) validations run first so trivially-malformed
   * requests don't spend budget).
   */
  async put(owner: DidKey, params: MediaPutParams, bytes: Buffer): Promise<MediaPutResult> {
    if (!this.cfg.types.includes(params.type)) {
      return {
        ok: false,
        status: 415,
        error: "unsupportedType",
        message: `type not allowed: ${params.type}`,
      };
    }
    if (bytes.length !== params.size) {
      return {
        ok: false,
        status: 400,
        error: "invalid",
        message: "byte length does not match declared size",
      };
    }
    if (bytes.length > this.cfg.maxBytes) {
      return {
        ok: false,
        status: 413,
        error: "tooLarge",
        message: `exceeds ${this.cfg.maxBytes} bytes`,
      };
    }
    if (!this.limiter.check(owner, this.now())) {
      return { ok: false, status: 429, error: "rateLimited", message: "too many uploads" };
    }
    if (sha256Base64url(bytes) !== params.hash) {
      return {
        ok: false,
        status: 400,
        error: "hashMismatch",
        message: "bytes do not match the signed hash",
      };
    }

    // Idempotent: identical content is already stored → return its address, no re-detect/quota/write.
    const existing = await this.store.get(params.hash);
    if (existing) return { ok: true, id: this.address(params.hash), deduped: true };

    if (await this.detect(bytes)) {
      return {
        ok: false,
        status: 422,
        error: "metadataPresent",
        message: "media carries EXIF/GPS metadata — strip it client-side before upload",
      };
    }
    const used = await this.store.totalBytesFor(owner);
    if (used + bytes.length > this.cfg.quotaBytes) {
      return { ok: false, status: 413, error: "quotaExceeded", message: "storage quota exceeded" };
    }
    if (!(await this.persist(params.hash, params.type, bytes, owner))) {
      // The same code as the per-DID quota: a client that handles one handles the other, and a new
      // code would reach only clients that declared it (beacon.core's `doc/core-compatibility.md`
      // §4).
      return { ok: false, status: 413, error: "quotaExceeded", message: "server storage is full" };
    }
    return { ok: true, id: this.address(params.hash), deduped: false };
  }

  /**
   * Locate a blob for serving (bytes to stream, or a redirect URL) + its content-type, stamping
   * last-access (no auto-eviction yet). The SQL metadata gates existence and carries the type.
   */
  async get(hash: string): Promise<{ location: BlobLocation; type: string } | undefined> {
    const rec = await this.store.get(hash);
    if (!rec) return undefined;
    const location = await this.blob.locate(hash);
    if (!location) return undefined; // metadata without a blob (shouldn't happen) → treat as missing
    // Throttled stamp: skip the write when this blob was touched within the last hour, so a hot public
    // GET doesn't write on every request. `rec.lastAccessAt` is already in hand — no extra read.
    const nowMs = this.now();
    const last = rec.lastAccessAt ? Date.parse(rec.lastAccessAt) : Number.NaN;
    if (!this.cfg.writeLocked && (Number.isNaN(last) || nowMs - last >= TOUCH_MIN_INTERVAL_MS)) {
      await this.store.touch(hash, new Date(nowMs).toISOString());
    }
    return { location, type: rec.type };
  }

  /**
   * Server-side **trusted** ingest (`doc/spec/location-lookups.md` §5.4): store already-clean,
   * server-produced bytes (a re-encoded WebP) content-addressed, owned by the server DID. Unlike
   * {@link put}, there is no signed attestation to verify, no EXIF detect-and-reject (re-encoding
   * to WebP drops metadata, so the bytes are clean by construction), and no per-DID quota (the
   * server is the owner). It still enforces the type allowlist + size cap and the store's limit,
   * and dedupes by content hash. Returns the content id + `<hash>@host` address, `undefined` when
   * the bytes fail the type/size gate, or {@link STORAGE_FULL} when new bytes would not fit (bytes
   * already held always do: they take no more room).
   */
  async ingestTrusted(
    owner: DidKey,
    bytes: Buffer,
    type: string,
  ): Promise<{ hash: string; id: string } | typeof STORAGE_FULL | undefined> {
    if (!this.cfg.types.includes(type)) return undefined;
    if (bytes.length > this.cfg.maxBytes) return undefined;

    const hash = sha256Base64url(bytes);
    const existing = await this.store.get(hash);
    if (!existing && !(await this.persist(hash, type, bytes, owner))) return STORAGE_FULL;
    return { hash, id: this.address(hash) };
  }

  /**
   * Whether `size` more bytes stay within the store's limit. Read from the store each time rather than
   * counted here, so a removal frees room at once and two processes on one database agree; the scan
   * stays small because the limit itself bounds the table. Not atomic: writes checked at the same
   * moment may all pass, so the limit can be passed by what is in flight at once, each object at most
   * `maxBytes`. A hoster's allowance tolerates that; a hard ceiling would need a lock per write.
   */
  private async fits(size: number): Promise<boolean> {
    const limit = this.cfg.limitBytes;
    if (limit === undefined) return true;
    const { bytes } = await this.store.stats();
    return bytes + size <= limit;
  }

  /** The local address for an already-stored hash (the content-addressed dedupe fast path). */
  async lookupIngested(hash: string): Promise<{ hash: string; id: string } | undefined> {
    const existing = await this.store.get(hash);
    return existing ? { hash, id: this.address(hash) } : undefined;
  }

  /**
   * Admin moderation (`doc/spec/admin-api.md` §3): delete a media object — blob bytes first, then
   * the metadata row (so a crash between the two leaves metadata-without-blob, which `get` already
   * treats as missing, never a served orphan). Both deletes are idempotent, so an unknown hash is
   * simply `false` — and a stray blob with no metadata row still gets cleaned. Content addressing
   * means a re-upload re-creates the object; blocking the owner is the operator's remedy for repeat
   * abuse.
   */
  async remove(hash: string): Promise<boolean> {
    await this.blob.delete(hash);
    return this.store.delete(hash);
  }

  /** Admin browse (`doc/spec/admin-api.md` §3): a filtered, keyset-paginated page — a passthrough to the store. */
  list(query: MediaListQuery): Promise<MediaListPage> {
    return this.store.list(query);
  }

  /**
   * Admin review toggle (`doc/spec/admin-api.md` §3): stamp `reviewedAt`/`reviewedBy` (mark), or
   * clear them (unmark). Returns the resulting stamp; an unknown hash changes nothing and reports
   * unreviewed.
   */
  async review(
    hash: string,
    by: DidKey,
    reviewed: boolean,
  ): Promise<{ reviewedAt: string | null; reviewedBy: DidKey | null }> {
    const reviewedAt = reviewed ? new Date(this.now()).toISOString() : null;
    const reviewedBy = reviewed ? by : null;
    const matched = await this.store.setReviewed(hash, reviewedBy, reviewedAt);
    return matched ? { reviewedAt, reviewedBy } : { reviewedAt: null, reviewedBy: null };
  }

  /**
   * Persist bytes to the blob backend + a metadata row — shared by {@link put} and {@link ingestTrusted},
   * and the one place the store's limit is checked, so no writer can pass it. `false`: no room.
   */
  private async persist(
    hash: string,
    type: string,
    bytes: Buffer,
    owner: DidKey,
  ): Promise<boolean> {
    if (!(await this.fits(bytes.length))) return false;
    await this.blob.put(hash, bytes, type);
    await this.store.put({
      hash,
      type,
      size: bytes.length,
      owner,
      uploadedAt: new Date(this.now()).toISOString(),
      lastAccessAt: null,
      reviewedAt: null,
      reviewedBy: null,
    });
    return true;
  }

  private address(hash: string): string {
    return formatGlobalId({ unique: hash, host: this.cfg.host });
  }
}
