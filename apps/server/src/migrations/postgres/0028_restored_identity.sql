-- 0028_restored_identity (postgres): who a restored server is.
--
-- One row, written in the transaction that loads a backup and read at boot, so a server takes the
-- name and key its data belongs to without its environment changing. `host` wins over BEACON_HOST:
-- every room id and photo address carries it. `key_envelope` is the backup's recovery phrase, sealed
-- with BEACON_KEY_PASSPHRASE; null when the server already started with that key. A backup leaves
-- this table out, since its own manifest and identity.key say the same things.
CREATE TABLE IF NOT EXISTS restored_identity (
  singleton    BOOLEAN PRIMARY KEY DEFAULT true CHECK (singleton),
  host         TEXT COLLATE "C" NOT NULL,
  key_envelope TEXT COLLATE "C",
  restored_at  TEXT COLLATE "C" NOT NULL
);

-- Superseded by the table above. A server restored under another name by the release that had it
-- keeps that name: its latest done restore's, with no key, since that release took none.
INSERT INTO restored_identity (host, key_envelope, restored_at)
SELECT data_host, NULL, COALESCE(finished_at, created_at) FROM backup_runs
WHERE kind = 'restore' AND status = 'done' AND data_host IS NOT NULL
ORDER BY id DESC LIMIT 1
ON CONFLICT (singleton) DO NOTHING;
ALTER TABLE backup_runs DROP COLUMN IF EXISTS data_host;
