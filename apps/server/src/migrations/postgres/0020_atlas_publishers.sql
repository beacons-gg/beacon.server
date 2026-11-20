-- The pinned publisher per Atlas volume — the durable half of trust-on-first-use.
-- A volume's first import records who signed it; every later import must match or the run is
-- refused, so a swapped publisher screams instead of sliding through. Rotation is a deliberate
-- unpin (places.atlas.unpin), never an overwrite.
CREATE TABLE IF NOT EXISTS atlas_publishers (
  volume text PRIMARY KEY,
  publisher text NOT NULL,
  pinned_at text NOT NULL,
  pinned_by text NOT NULL
);
