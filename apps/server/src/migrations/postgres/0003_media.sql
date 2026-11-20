-- 0003_media (postgres) — content-addressed media metadata (`doc/spec/mailbox-and-media.md` §5.4).
-- Forward-only. Mirrors the sqlite twin: bytes live in the blob backend (fs/s3); this is only the
-- metadata index. `hash` (sha256 base64url) is the content id + primary key (identical content
-- dedupes). `last_access_at` is stamped on fetch (no auto-eviction yet, §5.6). BIGINT size for
-- headroom.

CREATE TABLE IF NOT EXISTS media (
  hash           TEXT PRIMARY KEY,   -- sha256 base64url content id
  type           TEXT NOT NULL,      -- MIME type
  size           BIGINT NOT NULL,    -- byte length
  owner          TEXT NOT NULL,      -- uploader account did:key (quota + blacklist attribution)
  uploaded_at    TEXT NOT NULL,      -- ISO-8601 UTC
  last_access_at TEXT                -- ISO-8601 UTC, stamped on fetch (nullable until first fetch)
);
CREATE INDEX IF NOT EXISTS media_owner_idx ON media (owner);
