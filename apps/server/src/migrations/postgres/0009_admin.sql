-- 0009_admin (postgres) — the durable, admin-managed sender blacklist (`doc/spec/admin-api.md` §3).
-- Replaces the env-only BEACON_BLACKLIST set: env entries are seeded into this table at boot
-- (idempotently), and admins manage it live via the signed admin.blacklist.* ops. Consulted on
-- every signed capability/admin request via the in-memory write-through cache in SenderBlacklist.
CREATE TABLE IF NOT EXISTS blacklist (
  did      TEXT PRIMARY KEY,  -- the denied account did:key
  reason   TEXT,              -- bounded operator note (optional)
  added_by TEXT NOT NULL,     -- operator DID, or 'env' for BEACON_BLACKLIST boot seeds
  added_at TEXT NOT NULL      -- ISO-8601 UTC
);
