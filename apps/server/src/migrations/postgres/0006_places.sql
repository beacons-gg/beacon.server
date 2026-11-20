-- 0006_places (postgres) — OSM places query cache, for a places proxy that 0008 removes.
-- Forward-only. Mirrors the sqlite twin: a read-through cache in front of Overpass, keyed by
-- "<geohash-cell>:<preset>". `result` is the JSON PlacesResult, stored as TEXT (not JSONB) so both
-- dialects decode identically. `expires_at` gates reads and drives the TTL sweep.

CREATE TABLE IF NOT EXISTS places_cache (
  cache_key  TEXT PRIMARY KEY,   -- "<geohash-cell>:<preset>" (the cache key)
  result     TEXT NOT NULL,      -- JSON-encoded PlacesResult
  cached_at  TEXT NOT NULL,      -- ISO-8601 UTC (when fetched)
  expires_at TEXT NOT NULL       -- ISO-8601 UTC
);
CREATE INDEX IF NOT EXISTS places_cache_expires_idx ON places_cache (expires_at);
