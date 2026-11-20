-- 0004_nonces (postgres) — durable replay/idempotency log for signed capability requests
-- (`doc/spec/mailbox-and-media.md` §3.2). Forward-only. Mirrors the sqlite twin: one row per seen
-- op `nonce`, decoupled from the message/media lifetime so a replay is caught even after the
-- underlying record is acked/swept. Reads store `result = ''` (replay is rejected); writes store
-- their committed result JSON (replay returns it). Timestamps are ISO-8601 UTC TEXT (lexicographic
-- = chronological), matching the sqlite store, so both twins share the same sweep query.

CREATE TABLE IF NOT EXISTS capability_nonces (
  nonce      TEXT PRIMARY KEY,   -- the op envelope's ULID nonce (globally unique per client op)
  result     TEXT NOT NULL,      -- committed result JSON for idempotent replay ('' for reads)
  expires_at TEXT NOT NULL       -- ISO-8601 UTC — retained ≥ the ±freshness window
);
CREATE INDEX IF NOT EXISTS capability_nonces_expires_idx ON capability_nonces (expires_at);
