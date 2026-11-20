-- 0026_backup_runs (postgres): the log of backup and restore runs.
--
-- The durable record the console polls, the same shape as `place_snapshots`. It lives outside what
-- it records: a backup leaves this table out, along with `schema_migrations`, so a restore brings
-- none of the source server's job history with it.
--
-- `target` is `{endpoint?, region, bucket, prefix}` and nothing else. Credentials arrive with each
-- request and stay in the run's memory, so there is no column here that could hold one.
--
-- `COLLATE "C"` like every text column (0023): ids and timestamps compare by byte.
CREATE TABLE IF NOT EXISTS backup_runs (
  id           TEXT COLLATE "C" PRIMARY KEY, -- ULID
  kind         TEXT COLLATE "C" NOT NULL,    -- 'backup' | 'restore'
  status       TEXT COLLATE "C" NOT NULL,    -- 'queued' | 'running' | 'done' | 'failed'
  requested_by TEXT COLLATE "C" NOT NULL,    -- admin DID
  target       TEXT COLLATE "C" NOT NULL,    -- JSON, the destination without its credentials
  locked       BOOLEAN,                      -- a backup: whether the server was locked for it
  stats        TEXT COLLATE "C",             -- JSON progress/result counters
  warnings     TEXT COLLATE "C",             -- JSON string[]
  error        TEXT COLLATE "C",
  created_at   TEXT COLLATE "C" NOT NULL,
  started_at   TEXT COLLATE "C",
  finished_at  TEXT COLLATE "C"
);

-- At most one run of either kind is live: this is what refuses a second start, atomically. A restart
-- cannot strand the slot, because boot closes interrupted runs before the routes listen.
CREATE UNIQUE INDEX IF NOT EXISTS backup_runs_one_active_idx
  ON backup_runs ((true)) WHERE status IN ('queued', 'running');
