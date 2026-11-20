import { originForHost, parseGlobalId, type DidKey, type Media } from "@beaconsgg/protocol-types";
import { liveView } from "../settings/live-config";
import { OutboundHttp, OutboundLimiter, type OutboundClient } from "../common/outbound-http";
import { containsPrivacyMetadata } from "../common/media-metadata";
import { STORAGE_FULL } from "./media.service";

/** The metadata detector, matching `MediaService`'s seam so both paths can be driven in tests. */
export type MetadataDetector = (bytes: Buffer) => Promise<boolean>;

/**
 * Cross-server media re-hosting over the trusted-ingest seam (`doc/spec/places.md` §7 — generic
 * media plumbing, home here so a future non-places consumer never reaches into a feature dir).
 *
 * An exported media entry addresses its bytes as `hash@host`; `transfer` resolves the origin via
 * the shared scheme-on-read rule (`originForHost`), fetches the bytes, re-ingests them locally,
 * and **verifies integrity by hash** — `ingestTrusted` re-hashes server-side, so corrupt or
 * substituted bytes drop the entry. Entries whose hash is already hosted locally are answered
 * with **zero network** (the content-addressed dedupe check), which makes a re-import of an
 * unchanged list a no-op instead of a re-download storm.
 */

/** The media-store surface trusted server-side flows need — a subset of `MediaService`. */
export interface MediaIngester {
  ingestTrusted(
    owner: DidKey,
    bytes: Buffer,
    type: string,
  ): Promise<{ hash: string; id: string } | typeof STORAGE_FULL | undefined>;
  /** The local address for an already-stored hash, or `undefined` — the zero-network fast path. */
  lookupIngested(hash: string): Promise<{ hash: string; id: string } | undefined>;
}

/** The transfer knobs (byte cap + per-fetch timeout; pacing rides the shared outbound client). */
export interface MediaTransferConfig {
  maxBytes: number;
  timeoutMs: number;
}

export class MediaTransfer {
  constructor(
    private readonly outbound: OutboundClient,
    private readonly media: MediaIngester,
    private readonly owner: () => DidKey,
    private readonly cfg: MediaTransferConfig,
    /**
     * Metadata detector, applied to **every** byte string this class fetches.
     *
     * `ingestTrusted` skips this check on the stated grounds that "re-encoding to WebP drops metadata, so
     * the bytes are clean by construction" — true of bytes *this* server re-encoded, and not true of
     * anything arriving here, which by definition came from somewhere else. A foreign server's media and an
     * Atlas volume's are both somebody else's construction, and `media/:hash` is public and
     * unauthenticated, so an EXIF-GPS payload that got through would be served to anyone.
     *
     * Injected rather than reached through `MediaIngester` so the check does not have to widen the
     * ingest interface, and so a test can drive both paths without real image bytes.
     */
    private readonly detect: MetadataDetector = containsPrivacyMetadata,
  ) {}

  /**
   * Re-host each entry (best-effort per entry); returns the entries that verified locally.
   *
   * `origin` overrides where the bytes are fetched from, for a source whose addresses are **not** `hash@host`
   * — an Atlas volume, whose media lives at `manifest.media.base`. Passed in per call rather than by
   * widening {@link mediaOriginUrl} to accept any absolute URL, and the difference matters: that function is
   * reachable from untrusted `places.import` data, where today's `hash@host` shape plus the
   * `unique === entry.hash` check is what stops an uploaded file from naming an arbitrary host and path. A
   * caller that *knows* its addresses are operator-configured says so here.
   *
   * `type` likewise overrides what the response header claims. A volume's bytes are WebP by construction and
   * a plain static host may answer `application/octet-stream`, which `ingestTrusted`'s allowlist refuses —
   * so every photo would silently vanish on a correctly-published volume served by a misconfigured mirror.
   */
  async transfer(
    media: Media[],
    opts: {
      origin?: (entry: Media) => string | undefined;
      type?: string;
      /** The source's own paced client, when it has one — see `MediaTransport`. */
      outbound?: OutboundClient;
      /**
       * Local bytes instead of a fetch — a staged Atlas archive, whose media is already on this
       * disk. Everything downstream is unchanged on purpose: the metadata detector still runs
       * (an archive's bytes are still someone else's construction) and `ingestTrusted` still
       * re-hashes, so a tampered archive entry drops exactly like tampered network bytes.
       */
      load?: (entry: Media) => Promise<Buffer | undefined>;
    } = {},
    /**
     * The hashes the store had no room for, shared across a run (its own argument: `opts` is a
     * source's transport object). Once it holds one, nothing more is downloaded only to be refused:
     * entries held locally are kept, the rest are added to it.
     */
    leftOut: Set<string> = new Set(),
  ): Promise<{ media: Media[]; fetched: number }> {
    const outbound = opts.outbound ?? this.outbound;
    const out: Media[] = [];
    let fetched = 0;
    for (const entry of media) {
      const local = await this.media.lookupIngested(entry.hash);
      if (local) {
        out.push({ ...entry, uris: [local.id] });
        continue;
      }
      if (leftOut.size > 0) {
        leftOut.add(entry.hash);
        continue;
      }
      try {
        let bytes: Buffer;
        let sourceType: string | undefined;
        if (opts.load) {
          const loaded = await opts.load(entry);
          if (!loaded || loaded.length > this.cfg.maxBytes) continue;
          bytes = loaded;
        } else {
          const url = opts.origin ? opts.origin(entry) : mediaOriginUrl(entry);
          if (!url) continue;
          const got = await outbound.http.getBytes(url, this.cfg.maxBytes, {
            timeoutMs: this.cfg.timeoutMs,
            limiter: outbound.limiter,
          });
          bytes = got.bytes;
          sourceType = got.contentType;
        }
        // Someone else's bytes, so someone else's guarantee. Dropped rather than scrubbed: rewriting them
        // would change the hash, and the hash is the identity the entry is addressed by.
        if (await this.detect(bytes)) continue;
        const ingested = await this.media.ingestTrusted(
          this.owner(),
          bytes,
          opts.type ?? sourceType ?? "application/octet-stream",
        );
        if (ingested === STORAGE_FULL) {
          leftOut.add(entry.hash);
        } else if (ingested && ingested.hash === entry.hash) {
          out.push({ ...entry, uris: [ingested.id] });
          fetched += 1;
        }
      } catch {
        // unreachable origin / unreadable file / too large / rejected type — drop this entry, keep the rest
      }
    }
    // `fetched` counts bytes that actually moved, separately from what verified. Only this layer knows the
    // difference, and a caller that added `out.length` to an "images ingested" stat would report ~17k
    // ingests on a re-import where every photo was already held and nothing was downloaded.
    return { media: out, fetched };
  }
}

/**
 * How many times a throttled (`429`/`503`) transfer fetch is retried. A constant, not config: the
 * env knob it replaces (`BEACON_PLACES_IMAGE_RETRIES`) existed for Wikimedia's byte throttle, which
 * left with POI image ingestion — what remains is bulk re-hosting from other beacon servers, where
 * waiting a throttle out still beats dropping the photo but nobody needs to tune how hard.
 */
const TRANSFER_MAX_RETRIES = 3;

/**
 * The ONE paced outbound client for the import-media budget. Everything that fetches image-sized
 * bytes on the ingestion path shares this pair, or the configured pacing is silently doubled. (An
 * Atlas run deliberately bypasses it: the volume's connector supplies its own unpaced client —
 * static files owe nobody fairness.) A narrowed shape, not `ServerConfig` — this module's home is
 * generic media plumbing, so the caller maps whatever knobs it draws the values from.
 */
export function createMediaTransferOutbound(cfg: {
  userAgent: string;
  timeoutMs: number;
  minIntervalMs: number;
}): OutboundClient {
  // `Object.assign` onto a view, never a spread: a spread would read the accessors and flatten a
  // live `cfg` back to boot-time constants, silently undoing the whole round for this client.
  return {
    http: new OutboundHttp(
      Object.assign(liveView(cfg, { userAgent: "userAgent", timeoutMs: "timeoutMs" }), {
        maxRetries: TRANSFER_MAX_RETRIES,
      }),
    ),
    limiter: new OutboundLimiter(() => cfg.minIntervalMs),
  };
}

/**
 * The public media URL for an exported entry's origin (`uris[0]` = `hash@host`), resolved through
 * the platform's one scheme-on-read rule. `undefined` when the address doesn't match the content
 * id (an entry must be addressed by its own hash) or isn't a GlobalId at all.
 */
export function mediaOriginUrl(entry: Media): string | undefined {
  const uri = entry.uris[0];
  if (!uri) return undefined;
  try {
    const { unique, host } = parseGlobalId(uri);
    if (unique !== entry.hash) return undefined;
    return `${originForHost(host)}/media/${encodeURIComponent(entry.hash)}`;
  } catch {
    return undefined;
  }
}
