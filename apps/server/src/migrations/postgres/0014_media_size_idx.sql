-- 0014_media_size_idx (postgres) — index for the "largest first" admin media sort
-- (`doc/spec/admin-api.md` §3). Forward-only. Mirrors the sqlite twin: the size sort walks a keyset
-- over (size DESC, hash DESC), so a composite (size, hash) index serves that ORDER BY + the `(size
-- < ? OR (size = ? AND hash < ?))` keyset predicate as an index seek (matching
-- media_uploaded_at_hash_idx for the recency sort). No CREATE INDEX CONCURRENTLY — the runner wraps
-- each migration in a transaction.

CREATE INDEX IF NOT EXISTS media_size_hash_idx ON media (size, hash);
