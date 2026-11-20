-- 0017_geocode_zoom (postgres) — drop cached labels asked at the old zoom.
-- Forward-only. The reverse-geocode provider moved from Nominatim `zoom=10` (city) to `zoom=14`
-- (suburb/neighbourhood), so every row already in here answers a different question than the one the
-- code now asks. The positive TTL is 30 days, so without this a player would keep seeing city-only
-- labels for a month in every cell they had already visited — and the change would look broken.
--
-- Safe to run at any size: this is a cache in front of a public API. The cost of emptying it is that
-- the next lookup per cell goes upstream once, behind the existing 1 req/s outbound limiter.
--
-- TRUNCATE, not DELETE: migrations run at boot holding a session advisory lock, so this is on the
-- server's start path. TRUNCATE is O(1) and reclaims immediately; DELETE is O(rows), writes WAL in
-- proportion, and leaves the table as dead tuples for autovacuum. Nothing references this table.

TRUNCATE geocode_cache;
