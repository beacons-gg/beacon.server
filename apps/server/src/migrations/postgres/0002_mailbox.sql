-- 0002_mailbox (postgres) — per-recipient mailbox drop (`doc/spec/mailbox-and-media.md` §4).
-- Forward-only. Mirrors the sqlite twin: opaque, size-bounded, signed messages with a
-- server-decided TTL. Timestamps are ISO-8601 UTC TEXT (lexicographic = chronological), matching
-- the sqlite store, so both twins share the same TTL-sweep query.

CREATE TABLE IF NOT EXISTS mailbox (
  id           TEXT PRIMARY KEY,      -- server-assigned message id (ULID)
  recipient    TEXT NOT NULL,         -- `to` (recipient account did:key)
  sender       TEXT NOT NULL,         -- `from` (verified sender account did:key)
  body         TEXT NOT NULL,         -- opaque payload (server never parses it)
  received_at  TEXT NOT NULL,         -- ISO-8601 UTC
  expires_at   TEXT NOT NULL,         -- ISO-8601 UTC — server-decided TTL
  nonce        TEXT NOT NULL UNIQUE   -- send idempotency: a retried send returns the same row
);
CREATE INDEX IF NOT EXISTS mailbox_recipient_idx ON mailbox (recipient);
CREATE INDEX IF NOT EXISTS mailbox_expires_idx ON mailbox (expires_at);
