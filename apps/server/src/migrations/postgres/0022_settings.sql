-- 0022_settings (postgres) — operator-editable runtime settings (`doc/spec/runtime-settings.md`).
-- The 41 ServerConfig fields that are policy rather than deploy shape can be changed through a
-- signed admin op instead of a redeploy. The environment still supplies every default: loadConfig()
-- parses it exactly as before.
--
-- This table holds ADMIN OVERRIDES ONLY. A setting nobody has overridden has no row, and that
-- absence is what "the environment drives this one" means (§4): an env change lands on the next
-- boot, because there is nothing here to prefer over it. A row means an admin took the setting over,
-- so a redeploy leaves it alone. Resetting deletes the row.
--
-- Storing a row per setting instead would mean writing 41 rows on every boot that say only what
-- loadConfig() is about to recompute. That is why this differs from `blacklist` (0009_admin), which
-- does seed its env entries: there the env list IS the data, and a row is the only record that a DID
-- is denied.
--
-- Deploy-time settings (§3.1) are deliberately absent: they are read from env and nothing else, so
-- there is no row here that could disagree with them.
CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,  -- a ServerConfig field name, from the registry in settings/registry.ts
  value      TEXT NOT NULL,     -- JSON-encoded, so one column carries string/number/boolean/string[]
  updated_by TEXT NOT NULL,     -- the operator DID that set it
  updated_at TEXT NOT NULL      -- ISO-8601 UTC
);
