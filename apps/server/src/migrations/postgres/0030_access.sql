-- 0030_access (postgres): the member list a server at `accessLevel` request or private takes writes
-- from (`doc/spec/admin-api.md` §6).
--
-- One row per account: a member, a pending request or a declined one. Admins are members without a
-- row. A declined row is kept so the player cannot ask again until an admin approves them or
-- removes the row. Text columns are byte-ordered, as 0023_byte_order makes every other one.
CREATE TABLE IF NOT EXISTS access_members (
  did          TEXT COLLATE "C" PRIMARY KEY,  -- the account did:key
  status       TEXT COLLATE "C" NOT NULL CHECK (status IN ('member', 'pending', 'declined')),
  note         TEXT COLLATE "C",              -- the player's note from their request
  requested_at TEXT COLLATE "C",              -- ISO-8601 UTC, when the player last asked
  decided_by   TEXT COLLATE "C",              -- the admin DID that approved, declined or added
  decided_at   TEXT COLLATE "C"               -- ISO-8601 UTC
);
