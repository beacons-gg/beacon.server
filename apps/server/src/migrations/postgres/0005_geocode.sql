-- 0005_geocode (postgres) — reverse-geocode label cache (`doc/spec/location-lookups.md` §4.4).
-- Forward-only. Mirrors the sqlite twin: a read-through cache in front of the geocoding provider,
-- keyed by a coarsened geohash `cell_key`. `result` is the JSON GeocodeResult, stored as TEXT (not
-- JSONB) so both dialects decode identically. `expires_at` gates reads and drives the TTL sweep.

CREATE TABLE IF NOT EXISTS geocode_cache (
  cell_key   TEXT PRIMARY KEY,   -- coarsened geohash cell (the cache key)
  result     TEXT NOT NULL,      -- JSON-encoded GeocodeResult
  cached_at  TEXT NOT NULL,      -- ISO-8601 UTC (when fetched)
  expires_at TEXT NOT NULL       -- ISO-8601 UTC (positive or negative TTL)
);
CREATE INDEX IF NOT EXISTS geocode_cache_expires_idx ON geocode_cache (expires_at);
