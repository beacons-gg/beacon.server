/**
 * Durable persistence for operator-editable runtime settings (`doc/spec/runtime-settings.md`), the
 * dynamic replacement for reading all 71 config fields from the environment at boot.
 *
 * **The table holds admin overrides, and nothing else.** A setting an admin has never touched has
 * no row: the environment supplies it, `loadConfig` recomputes it on every boot, and a row saying
 * so would be a copy of a value this process is about to derive anyway. That absence *is* the
 * provenance (`doc/spec/runtime-settings.md` §4): no row means the environment drives the setting,
 * so an env change lands on the next boot; a row means an admin took it over, so a redeploy leaves
 * it alone; and {@link SettingsStore.remove} is how a reset back to the environment is spelled.
 *
 * This is where the design parts company with `SenderBlocklist`, which seeds its env entries **into**
 * its table. That is right for a blocklist, because there the env list *is* the data and a row is the
 * only record that a DID is denied. Here the environment is recomputed from scratch every boot, so a
 * seeded row records nothing and costs a write per key per restart.
 *
 * `SettingsService` keeps an in-memory cache over this store, because these values are read on the
 * request path (a capability toggle is consulted per call) and a database round trip per read would
 * be absurd. That cache is correct without an invalidation channel only because of **one server
 * process per database**: the same assumption `SenderBlocklist` records. Anything that breaks that
 * rule breaks both, and they should move together.
 *
 * Same pattern as the other stores: {@link PgSettingsStore} implements it, and the service suites run on an in-memory fake
 * (`__tests__/memory-stores.ts`) held to the same parity suite.
 */

/** One admin-set setting. `value` is the decoded JSON, in the shape the registry declares. */
export interface SettingRow {
  key: string;
  value: unknown;
  /** The operator DID that set it. */
  updatedBy: string;
  /** ISO-8601 UTC. */
  updatedAt: string;
}

export interface SettingsStore {
  /** Upsert an override (a re-put replaces value/updatedBy/updatedAt). */
  put(row: SettingRow): Promise<void>;
  /** Drop an override, handing the setting back to the environment; true if a row was there. */
  remove(key: string): Promise<boolean>;
  /**
   * Every override, by key in byte order (the keys are camelCase, so uppercase sorts first). The boot
   * rehydrate and the admin fetch read it.
   */
  all(): Promise<SettingRow[]>;
}

/**
 * JSON has no `undefined`, so an absent optional setting is stored as `null`. Both directions live
 * here, next to each other, so a caller of {@link SettingsStore} never has to know: a value
 * round-trips as written.
 */
export function encodeValue(value: unknown): string {
  return JSON.stringify(value ?? null);
}
export function decodeValue(json: string): { ok: true; value: unknown } | { ok: false } {
  try {
    const parsed: unknown = JSON.parse(json);
    return { ok: true, value: parsed === null ? undefined : parsed };
  } catch {
    return { ok: false };
  }
}
