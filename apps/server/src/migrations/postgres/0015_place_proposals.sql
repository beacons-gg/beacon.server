-- 0015_place_proposals (postgres) — player-submitted places awaiting review
-- (`doc/spec/place-proposals.md` §3). Forward-only. Mirrors the sqlite twin exactly. A proposal is
-- a contribution a player signed and submitted: either a NEW place (`place_unique` NULL) or an
-- improvement to an existing one (`place_unique` set). Nothing here is visible to any read path —
-- an approved proposal is applied separately, as a `contrib` source record through the same
-- merge/commit pipeline every connector uses, and this row is stamped with the outcome.
--
-- `fields` is TEXT, not JSON/JSONB — the places rule since 0007 ("JSON columns are TEXT in both
-- dialects so the store decodes uniformly"). A real json column would make node-pg hand back an
-- already-parsed object, and the shared `JSON.parse` converter would throw on Postgres only.
--
-- A new-place proposal's `id` BECOMES the created place's `unique` (both ULIDs), which makes approval
-- idempotent by construction: a retry re-upserts the same place instead of minting a second one.

CREATE TABLE IF NOT EXISTS place_proposals (
  id            TEXT PRIMARY KEY, -- ULID; for a new-place proposal, also the created place's unique
  place_unique  TEXT,             -- NULL = a new-place proposal; set = an improvement to this place
  proposed_by   TEXT NOT NULL,    -- the contributor's DID (cryptographically verified at submit)
  credit        INTEGER NOT NULL, -- 0/1: publish the contributor alongside the place (opt-in)
  fields        TEXT NOT NULL,    -- JSON: the proposed canonical-field values
  note          TEXT,             -- free text from the contributor to the reviewer
  status        TEXT NOT NULL,    -- 'pending' | 'approved' | 'rejected'
  reviewed_by   TEXT,             -- the admin who decided (who/when/why)
  reviewed_at   TEXT,
  review_reason TEXT,
  applied_place TEXT,             -- the place the approval landed on
  created_at    TEXT NOT NULL
);

-- Both listings page by keyset on `id` DESC (ULIDs are clock-ordered, so id ordering IS recency
-- ordering — the listSnapshots precedent). Indexing on created_at instead would not serve it.
CREATE INDEX IF NOT EXISTS place_proposals_status_idx ON place_proposals (status, id);
CREATE INDEX IF NOT EXISTS place_proposals_did_idx ON place_proposals (proposed_by, id);
-- The per-contributor pending cap, checked on every submit. Partial rather than folded into the
-- index above: `(proposed_by, status, id)` would force a sort on the unfiltered per-DID listing,
-- while `(proposed_by, id)` alone makes the count probe a heap row per row to test status — so it
-- would scale with a contributor's LIFETIME proposals, not their pending ones.
CREATE INDEX IF NOT EXISTS place_proposals_pending_idx
  ON place_proposals (proposed_by) WHERE status = 'pending';
-- For the contributor list ("who improved this place?", `doc/spec/place-proposals.md` §4.1), which
-- reads approved, credited rows by place.
CREATE INDEX IF NOT EXISTS place_proposals_place_idx ON place_proposals (place_unique);
