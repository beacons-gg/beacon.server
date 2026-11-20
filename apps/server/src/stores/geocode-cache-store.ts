import type { GeocodeResult } from "@beaconsgg/protocol-types";

/**
 * Durable cache for reverse-geocoded place labels (`doc/spec/location-lookups.md` §4.4). Same
 * pattern as the other stores: {@link PgGeocodeCacheStore} implements it, and the service suites
 * run on an in-memory fake held to the same parity suite. Keyed by a coarsened geohash **cell
 * key**; the stored value is the full {@link GeocodeResult} JSON. `get` is expiry-filtered (an
 * expired row misses), so a stale label is never served; the TTL sweep just reclaims space.
 */
export interface GeocodeCacheStore {
  /** The cached label for a cell key, or `undefined` when absent **or expired** (`nowIso` gates it). */
  get(cellKey: string, nowIso: string): Promise<GeocodeResult | undefined>;
  /** Upsert a label for a cell key with its absolute `expiresAt` (positive or negative TTL). */
  put(cellKey: string, result: GeocodeResult, expiresAt: string): Promise<void>;
  /** Delete expired rows; returns the number removed. */
  sweepExpired(nowIso: string): Promise<number>;
}
