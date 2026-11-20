-- 0013_media_review (postgres) — admin moderation review state on media objects
-- (`doc/spec/admin-api.md` §3). Forward-only. Mirrors the sqlite twin: two nullable columns on the
-- content-addressed `media` row — when an operator marks an object reviewed we stamp who + when;
-- both null = not yet reviewed. State is per-content-hash and cascades on delete (same row). No
-- CREATE INDEX CONCURRENTLY — the runner wraps each migration in a transaction.

ALTER TABLE media ADD COLUMN reviewed_at TEXT;  -- ISO-8601 UTC an admin marked it reviewed (nullable)
ALTER TABLE media ADD COLUMN reviewed_by TEXT;  -- reviewing admin account did:key (nullable)

-- Keyset order (uploaded_at DESC, hash DESC) for the paginated admin list.
CREATE INDEX IF NOT EXISTS media_uploaded_at_hash_idx ON media (uploaded_at, hash);
-- Partial index: the unreviewed review-queue filter + the stats unreviewed count both hit this.
CREATE INDEX IF NOT EXISTS media_unreviewed_idx ON media (uploaded_at, hash) WHERE reviewed_at IS NULL;
