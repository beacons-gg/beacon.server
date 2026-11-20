import { coarsen, decode } from "@beaconsgg/geo";
import type { GeocodeResult } from "@beaconsgg/protocol-types";
import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";
import type { ServerConfig } from "../config";
import { liveView } from "../settings/live-config";
import { OutboundError } from "../common/outbound-http";
import type { GeocodeCacheStore } from "../stores/geocode-cache-store";
import {
  NEIGHBORHOOD_MIN_PRECISION,
  type GeocodeProvider,
  type PlaceLabel,
} from "./geocode-provider";

/** How often to reclaim expired cache rows. TTLs are days, so a minute is ample. */
const SWEEP_MS = 60_000;

/**
 * The label as this cell may honestly serve it — see {@link NEIGHBORHOOD_MIN_PRECISION}, which lives
 * beside the zoom it is a judgement about.
 *
 * Applied on the way *in*, before the row is stored, so a cache entry can never hold an answer finer
 * than its own key: the key is the cell, the cell is what was geocoded, and every read of that row
 * has exactly the same claim to make.
 */
function honestFor(cellKey: string, label: PlaceLabel): PlaceLabel {
  if (cellKey.length >= NEIGHBORHOOD_MIN_PRECISION) return label;
  const { neighborhood: _tooCoarseToClaim, ...rest } = label;
  return rest;
}

/** The geocode knobs the service needs, lifted out of {@link ServerConfig} so it's easy to test. */
export interface GeocodeConfig {
  enabled: boolean;
  precision: number;
  ttlSeconds: number;
  negativeTtlSeconds: number;
  /** Whether the server is locked read-only (live): the sweep waits, and a lookup stores nothing. */
  writeLocked: boolean;
}
/** The geocode slice, as accessors over the live config — see settings/live-config.ts. */
export function geocodeConfigFrom(c: ServerConfig): GeocodeConfig {
  return liveView(c, {
    enabled: "geocodeEnabled",
    precision: "geocodePrecision",
    ttlSeconds: "geocodeTtlSeconds",
    negativeTtlSeconds: "geocodeNegativeTtlSeconds",
    writeLocked: "writeLocked",
  });
}

/** The result of a lookup: a served label (cache or fresh), or a soft upstream failure. */
export type GeocodeLookup =
  | { ok: true; result: GeocodeResult; cached: boolean }
  | { ok: false; status: 503; error: string; message: string };

/**
 * The geocode capability (`doc/spec/location-lookups.md` §4): reverse-geocode a geohash to a coarse
 * city/state/ country label via a {@link GeocodeProvider}, cached read-through. The geohash is
 * **coarsened** to the configured precision so nearby points share one cache entry (and a caller
 * can't cache-bust with sub-cell precision). A provider that returns no label is
 * **negative-cached** on a shorter TTL so an empty area (ocean) doesn't re-hit the upstream. An
 * upstream error is a soft `503`, never a `500`.
 */
@Injectable()
export class GeocodeService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger("Geocode");
  private readonly now: () => number;
  private sweepHandle: ReturnType<typeof setInterval> | undefined;

  constructor(
    private readonly provider: GeocodeProvider,
    private readonly store: GeocodeCacheStore,
    private readonly cfg: GeocodeConfig,
    now: () => number = () => Date.now(),
  ) {
    this.now = now;
  }

  onModuleInit(): void {
    // Unconditional interval, capability checked per tick — see the mailbox sweep for why gating this
    // at boot stopped being safe once `BEACON_GEOCODE` became a runtime setting.
    this.warnIfCoarse();
    // Swallow a rejected sweep (pool/connection/disk) so a transient GC failure degrades cleanup rather
    // than becoming an unhandled rejection (same shape as the mailbox sweep).
    this.sweepHandle = setInterval(() => {
      if (!this.cfg.enabled) return;
      this.warnIfCoarse();
      if (this.cfg.writeLocked) return;
      this.store.sweepExpired(this.nowIso()).catch((err: unknown) => {
        this.logger.warn(
          `geocode sweep failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
    }, SWEEP_MS);
    this.sweepHandle.unref?.();
  }
  onModuleDestroy(): void {
    if (this.sweepHandle) clearInterval(this.sweepHandle);
  }

  /** The last precision warned about, so a live change is reported once rather than every tick. */
  private warnedPrecision: number | undefined;

  /**
   * A precision below the neighbourhood floor silently costs the finest half of every label: the
   * upstream call is still made and paid for at the finer zoom, the answer is just not servable. The
   * symptom otherwise is "the labels look like they used to", which nobody files a bug about.
   *
   * Re-checked on each sweep rather than only at boot, because `geocodePrecision` is operator-
   * editable now and an admin who coarsens it at runtime deserves the same line the env var got.
   */
  private warnIfCoarse(): void {
    const precision = this.cfg.precision;
    if (precision === this.warnedPrecision) return;
    this.warnedPrecision = precision;
    if (precision < NEIGHBORHOOD_MIN_PRECISION) {
      this.logger.warn(
        `geocode precision ${precision} is coarser than ${NEIGHBORHOOD_MIN_PRECISION}: ` +
          "labels will name a city but never a neighbourhood.",
      );
    }
  }

  /** Whether the capability is enabled (routes 404 when off). */
  get enabled(): boolean {
    return this.cfg.enabled;
  }

  /**
   * Look up the place label for a geohash. Coarsens to the cache cell, serves a non-expired cache hit,
   * else reverse-geocodes the cell center, stores it (positive TTL for a label / negative TTL for an
   * empty result), and returns it. An `OutboundError` from the provider becomes a soft `503`.
   */
  async lookup(geohash: string): Promise<GeocodeLookup> {
    const cellKey = coarsen(geohash, this.cfg.precision);
    const nowMs = this.now();
    const nowIso = new Date(nowMs).toISOString();

    const cached = await this.store.get(cellKey, nowIso);
    if (cached) return { ok: true, result: cached, cached: true };

    let label: PlaceLabel | undefined;
    try {
      const center = decode(cellKey);
      label = await this.provider.reverse(center.lat, center.lng);
    } catch (err) {
      if (err instanceof OutboundError) {
        this.logger.warn(`geocode upstream failed (${cellKey}): ${err.kind} — ${err.message}`);
        return {
          ok: false,
          status: 503,
          error: "upstreamUnavailable",
          message: "geocoder unavailable",
        };
      }
      throw err;
    }

    const result: GeocodeResult = {
      geohash: cellKey,
      // PlaceLabel is exactly the optional-field subset of GeocodeResult, and `normalize()` only emits
      // present keys — so spreading the whole label copies only real keys (exactOptionalPropertyTypes-safe).
      ...(label ? honestFor(cellKey, label) : {}),
      source: this.provider.id,
      attribution: this.provider.attribution,
      cachedAt: nowIso,
    };
    // A read still answers while locked. It just leaves the cache as it found it, so the next lookup
    // of this cell after the unlock asks the provider once more.
    if (!this.cfg.writeLocked) {
      const ttl = label ? this.cfg.ttlSeconds : this.cfg.negativeTtlSeconds;
      const expiresAt = new Date(nowMs + ttl * 1000).toISOString();
      await this.store.put(cellKey, result, expiresAt);
    }
    return { ok: true, result, cached: false };
  }

  private nowIso(): string {
    return new Date(this.now()).toISOString();
  }
}
