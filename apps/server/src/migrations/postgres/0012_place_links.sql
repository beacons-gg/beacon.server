-- 0012_place_links (postgres) — more detail-only descriptor fields: the English Wikipedia article
-- URL (wikipedia=en:… / wikipedia:en tags) and the "also known as" name list (alt_name/
-- short_name/official_name/old_name, deduped; JSON array). Nullable; connectors set them from
-- tags at classification time, admins can override.
ALTER TABLE places ADD COLUMN wikipedia TEXT;
ALTER TABLE places ADD COLUMN alt_names TEXT;
