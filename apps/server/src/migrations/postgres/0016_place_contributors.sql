-- 0016_place_contributors (postgres) — the read behind a place's credited contributors.
-- Forward-only, additive: an index only.
--
-- Keyed on `applied_place` rather than `place_unique` because that's the column that answers the
-- question for BOTH proposal shapes: an improvement lands on the place it named, and an approved
-- new-place proposal lands on a place whose unique is the proposal's own id. `place_unique` is null
-- for the second kind, so indexing it would miss exactly the people who put the place there.
--
-- Partial, because the only rows this read ever wants are the approved ones whose author asked to be
-- named — a small slice of a table that is mostly pending and mostly anonymous.
CREATE INDEX IF NOT EXISTS place_proposals_credited_idx
  ON place_proposals (applied_place)
  WHERE status = 'approved' AND credit = 1;
