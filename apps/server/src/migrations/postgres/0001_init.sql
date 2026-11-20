-- 0001_init (postgres) — custodied rooms + nonce idempotency log + revocation registry.
-- Forward-only. Per-dialect twin of ../sqlite/0001_init.sql; see ../runner.ts for the contract.

-- Custodied rooms. `data` is the full Room as JSONB (the engine treats it as opaque).
-- `geohash` backs roomsInCells (a prefix test); `lifecycle_due_at` backs lifecycleRoomsDue
-- (NULL for non-lifecycle rooms, so the partial index only carries lifecycle rooms).
CREATE TABLE IF NOT EXISTS rooms (
  id               TEXT PRIMARY KEY,
  data             JSONB NOT NULL,
  geohash          TEXT NOT NULL,
  lifecycle_due_at BIGINT
);
CREATE INDEX IF NOT EXISTS rooms_geohash_idx ON rooms (geohash text_pattern_ops);
CREATE INDEX IF NOT EXISTS rooms_lifecycle_due_idx
  ON rooms (lifecycle_due_at) WHERE lifecycle_due_at IS NOT NULL;

-- Nonce -> OpResult idempotency log (`doc/spec/room-operation.md` §6.2). `seq` gives FIFO
-- retention.
CREATE TABLE IF NOT EXISTS nonces (
  seq    BIGSERIAL PRIMARY KEY,
  nonce  TEXT NOT NULL UNIQUE,
  result JSONB NOT NULL
);

-- Durable published-profile registry (revocation with teeth — beacon.core `doc/spec/identity.md`
-- §6).
CREATE TABLE IF NOT EXISTS profiles (
  id  TEXT PRIMARY KEY,
  doc JSONB NOT NULL
);
