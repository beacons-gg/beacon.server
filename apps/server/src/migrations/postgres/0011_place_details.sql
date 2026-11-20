-- 0011_place_details (postgres) — the detail-only descriptor fields: free-text description (the
-- OSM tag, or synthesized surveillance details — Flock/ALPR/operator) and the place's website.
-- Nullable; connectors set them from tags at classification time, admins can override.
ALTER TABLE places ADD COLUMN description TEXT;
ALTER TABLE places ADD COLUMN website TEXT;
