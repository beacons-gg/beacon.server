-- 0018_place_description_credit (postgres) — attribution for a place's `description`, when the text
-- came from a source with terms. The OSM `description` tag is ODbL and covered by the record's
-- per-source attribution line, so it carries none; a Wikipedia summary is CC BY-SA 4.0 and does.
-- JSON (license/author/licenseUrl/sourceUrl), same shape as an image's credit. Nullable — most
-- descriptions have nothing to attribute.
ALTER TABLE places ADD COLUMN description_credit TEXT;
