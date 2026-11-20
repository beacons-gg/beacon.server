-- 0007_places_v2 (postgres) — the owned places dataset (`doc/spec/places.md` §3). Forward-only. v2
-- replaces the v1 proxy+cache model: canonical `places` rows are what queries serve (always);
-- `place_sources` tracks where each fact came from (one row per source+source_id, merged into the
-- canonical row by field priority); `place_cells` is the geohash spatial index; `place_snapshots`
-- is the durable ingestion-run audit + refresh unit; `place_conflicts` is the pending-revision
-- queue protecting admin-held fields. JSON columns are TEXT in both dialects so the store decodes
-- uniformly. The v1 `places_cache` table is dropped by 0008, when reads move to this dataset.

CREATE TABLE IF NOT EXISTS places (
  unique_id  TEXT PRIMARY KEY,  -- ULID; addressable as unique@host; survives export/import
  category   TEXT NOT NULL,     -- taxonomy bucket (the game-facing contract)
  name       TEXT,
  lat        DOUBLE PRECISION NOT NULL,     -- representative point (markers, sort, cell indexing)
  lng        DOUBLE PRECISION NOT NULL,
  geometry   TEXT,              -- JSON GeoJSON Polygon|MultiPolygon, when the place is an area
  media      TEXT,              -- JSON Media[] (content-addressed thumb+full, with credit)
  status     TEXT NOT NULL,     -- 'active' | 'retired' (soft — games may hold references)
  created_at TEXT NOT NULL,     -- ISO-8601 UTC
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS place_sources (
  source       TEXT NOT NULL,   -- 'osm' | 'list:<name>' | 'admin' | future connectors
  source_id    TEXT NOT NULL,   -- e.g. 'node/123'; for admin rows, the place unique_id
  place_unique TEXT NOT NULL,
  fields       TEXT NOT NULL,   -- JSON: the mapped canonical-field values this source contributes
  raw          TEXT,            -- JSON: raw payload (e.g. OSM tags) for re-mapping/debug
  attribution  TEXT,            -- e.g. '© OpenStreetMap contributors (ODbL)'
  edited_by    TEXT,            -- admin-source audit (who/when)
  edited_at    TEXT,
  synced_at    TEXT NOT NULL,
  gone_at      TEXT,            -- set when a fresh in-scope sync no longer returns it
  PRIMARY KEY (source, source_id)
);
CREATE INDEX IF NOT EXISTS place_sources_place_idx ON place_sources (place_unique);
CREATE INDEX IF NOT EXISTS place_sources_live_idx ON place_sources (source, gone_at);

CREATE TABLE IF NOT EXISTS place_cells (
  cell         TEXT NOT NULL,   -- fixed-precision geohash (the point's cell, or the polygon's cover)
  place_unique TEXT NOT NULL,
  PRIMARY KEY (cell, place_unique)
);
CREATE INDEX IF NOT EXISTS place_cells_place_idx ON place_cells (place_unique);

CREATE TABLE IF NOT EXISTS place_snapshots (
  id           TEXT PRIMARY KEY, -- ULID
  source       TEXT NOT NULL,
  params       TEXT NOT NULL,    -- JSON: {boundary, categories?} verbatim (re-run = refresh)
  requested_by TEXT NOT NULL,    -- admin DID
  status       TEXT NOT NULL,    -- 'queued' | 'running' | 'done' | 'failed'
  stats        TEXT,             -- JSON progress/result counters
  error        TEXT,
  created_at   TEXT NOT NULL,
  started_at   TEXT,
  finished_at  TEXT
);

CREATE TABLE IF NOT EXISTS place_conflicts (
  id             TEXT PRIMARY KEY, -- ULID
  place_unique   TEXT NOT NULL,
  field          TEXT NOT NULL,    -- the admin-held canonical field the incoming value collided on
  current_value  TEXT,             -- JSON: the admin-held value at conflict time
  incoming_value TEXT NOT NULL,    -- JSON: what the connector brought
  source         TEXT NOT NULL,
  snapshot_id    TEXT,
  created_at     TEXT NOT NULL,
  resolved_at    TEXT
);
CREATE INDEX IF NOT EXISTS place_conflicts_place_idx ON place_conflicts (place_unique);

-- `LIKE 'prefix%'` cannot use a default-collation btree in Postgres; text_pattern_ops makes the
-- viewport cell scan indexable regardless of the database's collation.
CREATE INDEX IF NOT EXISTS place_cells_cell_tpo_idx ON place_cells (cell text_pattern_ops);
