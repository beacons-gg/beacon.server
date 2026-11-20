import type { GeocodeResult } from "@beaconsgg/protocol-types";
import type { Pool } from "pg";
import type { GeocodeCacheStore } from "./geocode-cache-store";

/** A DB row → the {@link GeocodeResult} DTO. */
interface GeocodeCacheRow {
  cell_key: string;
  result: string; // JSON-encoded GeocodeResult (TEXT, not JSONB: see 0005_geocode)
  expires_at: string;
}

function rowToResult(row: GeocodeCacheRow): GeocodeResult {
  return JSON.parse(row.result) as GeocodeResult;
}

/**
 * Postgres {@link GeocodeCacheStore} — the production twin (`doc/spec/location-lookups.md` §4.4),
 * over the `geocode_cache` table (`0005_geocode`).
 */
export class PgGeocodeCacheStore implements GeocodeCacheStore {
  constructor(private readonly pool: Pool) {}

  async get(cellKey: string, nowIso: string): Promise<GeocodeResult | undefined> {
    const res = await this.pool.query<GeocodeCacheRow>(
      "SELECT cell_key, result, expires_at FROM geocode_cache WHERE cell_key = $1 AND expires_at > $2",
      [cellKey, nowIso],
    );
    const row = res.rows[0];
    return row ? rowToResult(row) : undefined;
  }

  async put(cellKey: string, result: GeocodeResult, expiresAt: string): Promise<void> {
    await this.pool.query(
      "INSERT INTO geocode_cache (cell_key, result, cached_at, expires_at) VALUES ($1, $2, $3, $4) " +
        "ON CONFLICT (cell_key) DO UPDATE SET result = EXCLUDED.result, " +
        "cached_at = EXCLUDED.cached_at, expires_at = EXCLUDED.expires_at",
      [cellKey, JSON.stringify(result), result.cachedAt, expiresAt],
    );
  }

  async sweepExpired(nowIso: string): Promise<number> {
    const res = await this.pool.query("DELETE FROM geocode_cache WHERE expires_at <= $1", [nowIso]);
    return res.rowCount ?? 0;
  }
}
