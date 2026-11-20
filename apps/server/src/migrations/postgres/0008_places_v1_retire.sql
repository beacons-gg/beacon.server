-- 0008_places_v1_retire: reads move to the owned dataset (`doc/spec/places.md`). Forward-only. The
-- v1 proxy+cache places capability is gone: reads now serve the owned dataset (0007's tables). The
-- response-cache table is dead weight — drop it.

DROP TABLE IF EXISTS places_cache;
