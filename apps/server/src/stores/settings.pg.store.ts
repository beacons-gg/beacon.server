import type { Pool } from "pg";
import { decodeValue, encodeValue, type SettingRow, type SettingsStore } from "./settings-store";

const SETTINGS_COLUMNS = "key, value, updated_by, updated_at";

/** A DB row. `value` is JSON text. */
interface SettingDbRow {
  key: string;
  value: string;
  updated_by: string;
  updated_at: string;
}

/**
 * Decode a DB row. A row whose `value` is not parseable JSON is **dropped rather than guessed at**:
 * the caller falls back to the environment, which is a defined state, where a repaired row would be
 * an invented one. Same instinct as refusing a malformed signed field rather than fixing it up.
 */
function rowToSetting(r: SettingDbRow): SettingRow | undefined {
  const decoded = decodeValue(r.value);
  if (!decoded.ok) return undefined;
  return { key: r.key, value: decoded.value, updatedBy: r.updated_by, updatedAt: r.updated_at };
}

/** Decode a result set, dropping the rows {@link rowToSetting} refuses. */
function rowsToSettings(rows: SettingDbRow[]): SettingRow[] {
  const out: SettingRow[] = [];
  for (const r of rows) {
    const decoded = rowToSetting(r);
    if (decoded !== undefined) out.push(decoded);
  }
  return out;
}

/** The bind tuple for {@link SETTINGS_COLUMNS}. */
function settingToBind(row: SettingRow): [string, string, string, string] {
  return [row.key, encodeValue(row.value), row.updatedBy, row.updatedAt];
}

/**
 * Upsert one row through `db`: the store's pool, or a restore's client inside the transaction that
 * loads the data, so its lock lands with the data or not at all.
 */
export async function putSetting(db: Pick<Pool, "query">, row: SettingRow): Promise<void> {
  await db.query(
    `INSERT INTO settings (${SETTINGS_COLUMNS}) VALUES ($1, $2, $3, $4) ` +
      "ON CONFLICT (key) DO UPDATE SET value = excluded.value, " +
      "updated_by = excluded.updated_by, updated_at = excluded.updated_at",
    settingToBind(row),
  );
}

/**
 * Postgres {@link SettingsStore} — the production twin (`doc/spec/runtime-settings.md`), over the
 * `settings` table (`0022_settings`).
 */
export class PgSettingsStore implements SettingsStore {
  constructor(private readonly pool: Pool) {}

  put(row: SettingRow): Promise<void> {
    return putSetting(this.pool, row);
  }

  async remove(key: string): Promise<boolean> {
    const res = await this.pool.query("DELETE FROM settings WHERE key = $1", [key]);
    return (res.rowCount ?? 0) > 0;
  }

  async all(): Promise<SettingRow[]> {
    const res = await this.pool.query<SettingDbRow>(
      `SELECT ${SETTINGS_COLUMNS} FROM settings ORDER BY key`,
    );
    return rowsToSettings(res.rows);
  }
}
