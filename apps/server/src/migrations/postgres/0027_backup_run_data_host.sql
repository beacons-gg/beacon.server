-- 0027_backup_run_data_host (postgres): the name a restored server's data carries.
--
-- A backup may be restored on a server still running under a temporary name, so the data's real name
-- can differ from BEACON_HOST until the owner switches over. Set on a restore's run, in the
-- transaction that loads the data, and cleared when the server boots under that name. Null on a
-- backup, and on a restore from before this column.
ALTER TABLE backup_runs ADD COLUMN IF NOT EXISTS data_host TEXT COLLATE "C";
