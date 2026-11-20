import { Injectable, Logger } from "@nestjs/common";
import { z } from "zod";
import type { SettingRow, SettingsStore } from "../stores/settings-store";
import {
  isRuntimeSettingKey,
  reconcileRuntimeSettings,
  RUNTIME_SETTING_KEYS,
  SETTING_SPECS,
  settingKeyIssues,
  validateRuntimeSettings,
  type RuntimeSettingKey,
  type RuntimeSettings,
  type SettingAdjustment,
} from "./registry";

/** Where the value in force came from. Derived from whether an override row exists, never stored. */
export type SettingProvenance = "env" | "admin";

/** What an admin op reports for one setting: the value in force, and whether env still drives it. */
export interface SettingState<K extends RuntimeSettingKey = RuntimeSettingKey> {
  key: K;
  value: RuntimeSettings[K];
  provenance: SettingProvenance;
  /** The operator DID that set it; absent while the environment still drives the setting. */
  updatedBy?: string;
  updatedAt?: string;
  /** What the environment currently supplies, so a console can show what a reset would restore. */
  envValue: RuntimeSettings[K];
  /**
   * What the admin actually stored, present only when it is **not** what {@link value} reports.
   *
   * They differ exactly where `reconcileRuntimeSettings` had something to say: a dependent forced
   * off while its prerequisite is off, or `mediaMaxBytes` clamped to what the boot-sized body parser
   * can accept. The row is left alone in both cases, so the choice comes back when it can be
   * honoured. Without this field a console would show `false (admin)` to the admin who just set
   * `true`, or the boot ceiling to the admin who just raised it, with nothing to explain either.
   */
  storedValue?: RuntimeSettings[K];
  /**
   * Which rule held {@link storedValue} back, present exactly when it is.
   *
   * The two rules leave the same shape and want opposite things from an operator: a `prerequisite`
   * adjustment is fixed by turning a capability on, a `ceiling` one by raising an environment
   * variable and restarting. Without this a console can render nothing better than a generic "not in
   * force" badge over both.
   */
  storedReason?: SettingAdjustment;
}

/**
 * The operator-editable runtime settings (`doc/spec/runtime-settings.md`): admin overrides in a
 * durable store, read through a synchronous in-memory cache, over defaults the environment
 * supplies.
 *
 * **Reads are synchronous and hot.** A capability toggle is consulted on every request to that
 * surface, so {@link get} is a `Map` lookup and never a database round trip. The cache is safe
 * without an invalidation channel only under **one server process per database**, exactly as
 * `SenderBlocklist` records for the same reason.
 *
 * **Env is defaults, and the absence of a row is what makes that true**
 * (`doc/spec/runtime-settings.md` §4). Every runtime key gets its default from `loadConfig`, which
 * is unchanged, and the store holds only the settings an admin has taken over. So:
 *
 * - no override -> the environment wins, and a changed env var lands on the next boot;
 * - an override -> it wins, and a redeploy never silently reverts a deliberate choice;
 * - {@link reset} deletes the override, which is what stops provenance being a one-way door: one
 *   exploratory admin edit must not permanently detach a setting from the environment.
 *
 * Boot therefore writes nothing at all, which is what every other service here does too: a row this
 * build cannot use is reported and ignored, never deleted, because a schema that tightens in one
 * release and a rollback to the previous one must not have destroyed the operator's value in
 * passing.
 *
 * **Prerequisites are coerced, not policed** (registry's `CAPABILITY_PREREQUISITES`). {@link set}
 * refuses a combination `loadConfig` could not produce, because an admin is there to be told why.
 * That refusal is a courtesy and not the guarantee: a reset, a redeploy that changes the env var
 * underneath a row, a hand-edited table and two interleaved writes all reach the same combination
 * with nobody to refuse to. So the assembled view applies the prerequisite the way `loadConfig`
 * does, and the forbidden pair is unrepresentable however the rows got there.
 *
 * **Env values are not re-validated, deliberately.** The registry's schemas are stricter than
 * `loadConfig` in places (`publicUrl` must be an http(s) URL, say, where `loadConfig` accepts any
 * string), and they exist to police *admin writes*, which happen at runtime with nobody watching.
 * Applying them to env values would mean a server that boots today could stop booting after this
 * change, which is not a trade worth making inside a config refactor. Tightening boot validation to
 * match is a real improvement and a separate, deliberate one.
 */
@Injectable()
export class SettingsService {
  private readonly logger = new Logger(SettingsService.name);
  /** Admin overrides only. A key absent here is served from {@link envDefaults}. */
  private readonly overrides = new Map<RuntimeSettingKey, SettingRow>();
  /**
   * The overrides laid over the env defaults and reconciled, recomputed whenever they change.
   *
   * Derived, never a second source of truth. It exists so {@link get} stays one property read on the
   * request path while the prerequisite rules still run, and it is frozen so a future consumer can
   * cache anything it derives keyed on this object's identity.
   */
  private effective: RuntimeSettings;
  /** Which keys {@link recompute} had to change, and why. Reported by {@link state}. */
  private adjusted: Partial<Record<RuntimeSettingKey, SettingAdjustment>> = {};

  constructor(
    private readonly store: SettingsStore,
    /** The env-derived defaults, straight from `loadConfig()`. */
    private readonly envDefaults: RuntimeSettings,
    /** Milliseconds, matching every other injected clock in the server (`() => Date.now()`). */
    private readonly now: () => number = () => Date.now(),
  ) {
    const { settings, adjusted } = reconcileRuntimeSettings(envDefaults, envDefaults);
    this.effective = Object.freeze(settings);
    this.adjusted = adjusted;
  }

  /** Reassemble the view. Runs on every change to {@link overrides}, which is admin-rare. */
  private recompute(): void {
    const raw: Partial<Record<RuntimeSettingKey, unknown>> = {};
    for (const key of RUNTIME_SETTING_KEYS) {
      const override = this.overrides.get(key);
      raw[key] = override ? override.value : this.envDefaults[key];
    }
    const { settings, adjusted } = reconcileRuntimeSettings(
      raw as RuntimeSettings,
      this.envDefaults,
    );
    this.effective = Object.freeze(settings);
    this.adjusted = adjusted;
  }

  /**
   * Load the overrides. Until this runs, every setting reads its environment default.
   *
   * Not `onModuleInit`, because Nest starts every provider's init hook at once: the rooms wheel and
   * the sweeps would race this read, and a server restarted while locked could advance rooms on the
   * env default before its own lock row arrived. The provider factory in `app.module.ts` awaits this
   * during dependency injection instead, so it has finished before any provider's init hook runs.
   */
  async load(): Promise<void> {
    const rows = await this.store.all();

    for (const row of rows) {
      if (!isRuntimeSettingKey(row.key)) continue;
      // An override is only honoured if it is still a value this build accepts. A row can go stale
      // when a schema tightens between releases or somebody edits the table by hand. Repairing it
      // would be inventing an operator's intent, and honouring it would mean serving a value this
      // build has said it will not serve, so it is reported loudly and ignored: the setting falls
      // back to the environment, a defined state the operator can see and re-set.
      //
      // Ignored, not deleted, for the same reason an unknown key is left alone below. A schema that
      // tightens in release N+1 puts a previously-valid override in exactly this position, and
      // deleting it would mean rolling back to N no longer restores a value N would still accept.
      // Leaving the row costs nothing, keeps boot free of writes, and stays recoverable.
      const parsed = SETTING_SPECS[row.key].schema.safeParse(row.value);
      if (!parsed.success) {
        this.logger.error(
          `settings: stored override for "${row.key}" is not valid for this build ` +
            `(${parsed.error.issues[0]?.message ?? "invalid"}); leaving the row and falling back ` +
            `to ${SETTING_SPECS[row.key].env}`,
        );
        continue;
      }
      this.overrides.set(row.key, { ...row, value: parsed.data });
    }

    // A row for a key this build does not know is left in place too. It costs nothing, and a
    // downgrade, or a rename that lands in a later release, should not have already destroyed the
    // operator's value on the way past.
    const unknown = rows.filter((r) => !isRuntimeSettingKey(r.key)).map((r) => r.key);
    if (unknown.length > 0) {
      this.logger.warn(
        `settings: ${unknown.length} stored key(s) unknown to this build, left untouched: ${unknown.join(", ")}`,
      );
    }

    this.recompute();
    // The rows can disagree with an environment that moved while the process was down: an operator
    // who sets BEACON_PLACES=0 between restarts leaves any contributions override without its
    // prerequisite. `recompute` has already forced the dependent off, so this only reports it.
    for (const key of RUNTIME_SETTING_KEYS) {
      const override = this.overrides.get(key);
      if (override && override.value !== this.effective[key]) {
        this.logger.warn(
          `settings: admin override for "${key}" is dormant — a prerequisite is off in ` +
            `${SETTING_SPECS[key].env}'s environment; it applies again when that comes back on`,
        );
      }
    }

    this.logger.log(
      `settings ready (${RUNTIME_SETTING_KEYS.length} keys, ${this.overrides.size} admin-set)`,
    );
  }

  /** The value in force. Synchronous by design: this is on the request path. */
  get<K extends RuntimeSettingKey>(key: K): RuntimeSettings[K] {
    return this.effective[key];
  }

  /**
   * Every runtime setting as currently in force, frozen and stable until something changes.
   *
   * The `*ConfigFrom` builders don't read this: the live view reads {@link get} per key, so the
   * only production caller is {@link set}'s own cross-field validation. Kept because that use is
   * real and because an admin op reading the whole configuration wants exactly this, but the
   * identity guarantee is currently load-bearing for nothing.
   */
  current(): RuntimeSettings {
    return this.effective;
  }

  /** Every setting with its provenance — the admin read, and what a settings screen renders. */
  all(): SettingState[] {
    return RUNTIME_SETTING_KEYS.map((key) => this.state(key));
  }

  /** One setting with its provenance. */
  state<K extends RuntimeSettingKey>(key: K): SettingState<K> {
    const override = this.overrides.get(key);
    // A map cannot express "each key holds its own type", so an override value is stored as
    // `unknown` and narrowed here. Sound because every path that writes one validates against
    // `SETTING_SPECS[key].schema` first.
    const stored = override ? (override.value as RuntimeSettings[K]) : undefined;
    const value = this.get(key);
    return {
      key,
      value,
      provenance: override ? "admin" : "env",
      ...(override ? { updatedBy: override.updatedBy, updatedAt: override.updatedAt } : {}),
      envValue: this.envDefaults[key],
      ...(override && stored !== value
        ? {
            storedValue: stored as RuntimeSettings[K],
            ...(this.adjusted[key] !== undefined ? { storedReason: this.adjusted[key] } : {}),
          }
        : {}),
    };
  }

  /**
   * Validate and durably override **several settings in one write**, so the environment stops
   * driving them.
   *
   * Several at once is the point rather than a convenience. Some of these settings constrain each
   * other (`doc/spec/runtime-settings.md` §3.2), so an operator turning `placesEnabled` off has to
   * turn its dependants off with it: one key at a time forces them through a state {@link
   * validateRuntimeSettings} refuses, in whichever order they pick. The whole patch is checked
   * against the resulting configuration before any of it is stored, so the write an operator means
   * is the write they can make.
   *
   * Throws when a value is not acceptable, so the caller can render *why* rather than a bare
   * refusal: an admin who mistypes a budget deserves the same quality of message a mistyped env var
   * gets at boot. **Every** bad field is reported, not the first, because this is one form and one
   * field at a time is what a bad form does. The per-field issues carry the setting key at the head
   * of their path, so a console can put each message beside its own input.
   *
   * That whole-configuration check is a better error message, not the safety net. Two interleaved
   * calls can each validate before either writes, and a partial failure part-way through the loop
   * leaves some rows written and some not, so the pair they forbid is still reachable here. What
   * makes both harmless is that {@link recompute} reconciles, so the combination cannot be *served*
   * even when it is stored, which is the same protection a reset and a restart rely on. That is also
   * why the recompute is in a `finally`: a write that fails half way still leaves the view assembled
   * from what actually landed.
   */
  async setMany(values: Record<string, unknown>, actorDid: string): Promise<void> {
    const keys = Object.keys(values);
    // Key refusals and value refusals in one collection, so a patch with both faults is one round
    // trip and one encoding. Splitting them across two layers made an operator fix a stale key,
    // resubmit, and only then learn the value was also wrong, which is the one-field-at-a-time flow
    // this op exists to remove.
    const issues: z.ZodIssue[] = settingKeyIssues(keys);
    const parsed: Partial<Record<RuntimeSettingKey, unknown>> = {};

    for (const key of keys) {
      if (!isRuntimeSettingKey(key)) continue; // already refused above, with a reason
      const result = SETTING_SPECS[key].schema.safeParse(values[key]);
      if (result.success) parsed[key] = result.data;
      else
        issues.push(
          ...result.error.issues.map((issue) => ({ ...issue, path: [key, ...issue.path] })),
        );
    }
    if (issues.length > 0) throw new z.ZodError(issues);

    validateRuntimeSettings({ ...this.current(), ...parsed } as RuntimeSettings);

    // One timestamp for the whole patch: these rows were written by one signed op, and stamping them
    // a millisecond apart would invite a reader to infer an order that does not mean anything.
    const updatedAt = new Date(this.now()).toISOString();
    const written: RuntimeSettingKey[] = [];
    try {
      for (const key of Object.keys(parsed) as RuntimeSettingKey[]) {
        // Saving the lock as it already stands leaves its row alone. `updatedAt` is when the lock
        // took hold: a backup waits on it and reads a change as an unlock, so a console re-sending
        // `writeLocked: true` must not restamp it. Only this key: on every other row, `updatedBy`
        // and `updatedAt` mean who last saved it.
        if (key === "writeLocked" && this.overrides.get(key)?.value === parsed[key]) continue;
        // Durable first, then the cache, per key. A failed write must not leave the process serving
        // a value the database does not have, because the next restart would silently undo it.
        const row: SettingRow = { key, value: parsed[key], updatedBy: actorDid, updatedAt };
        await this.store.put(row);
        this.overrides.set(key, row);
        written.push(key);
      }
    } finally {
      this.recompute();
      this.log(
        written,
        actorDid,
        (key) => `set to ${JSON.stringify(this.overrides.get(key)?.value)}`,
      );
    }
  }

  /** One setting, the {@link setMany} bracket with a patch of one. */
  async set<K extends RuntimeSettingKey>(
    key: K,
    value: unknown,
    actorDid: string,
  ): Promise<SettingState<K>> {
    await this.setMany({ [key]: value }, actorDid);
    return this.state(key);
  }

  /**
   * Drop these overrides, handing the settings back to the environment immediately.
   *
   * No value validation, and none is possible: there is no value to refuse, and refusing the reset
   * itself would leave an admin unable to undo their own change except in one particular order.
   * Dropping a prerequisite can strand a dependent override, so {@link recompute} reconciles and the
   * dependant goes dormant rather than taking effect without the capability it needs. The keys are
   * still checked, because "reset `admins`" is a mistake worth naming.
   *
   * Deleting the row is right *here* and wrong at boot, which is the distinction {@link load}
   * turns on: a row this build cannot use is left alone because nobody asked, and this is an admin
   * asking. It is also the only way to clear a row a tightened schema has made unusable, which is why
   * the log follows the store rather than the cache — a stale row is not in {@link overrides} at all,
   * and an operator who just cleared one deserves the line saying so.
   */
  async resetMany(keys: readonly string[], actorDid: string): Promise<void> {
    const issues = settingKeyIssues(keys);
    if (issues.length > 0) throw new z.ZodError(issues);

    const dropped: RuntimeSettingKey[] = [];
    try {
      for (const key of keys as readonly RuntimeSettingKey[]) {
        const had = await this.store.remove(key);
        this.overrides.delete(key);
        if (had) dropped.push(key);
      }
    } finally {
      this.recompute();
      this.log(dropped, actorDid, (key) => `reset to the ${SETTING_SPECS[key].env} default`);
    }
  }

  /** One setting, the {@link resetMany} bracket with a list of one. */
  async reset<K extends RuntimeSettingKey>(key: K, actorDid: string): Promise<SettingState<K>> {
    await this.resetMany([key], actorDid);
    return this.state(key);
  }

  /**
   * One line per key that actually changed, from the `finally` of the write that changed it.
   *
   * **After the fact, so a line can never claim a write that did not land**, and **from the
   * `finally`, so a write that dies half way still says which rows it got through.** The store has
   * no multi-row transaction, so that is a reachable state, and it is the one where a silent log is
   * worst: the settings a live server is now serving would have changed with no record of which.
   *
   * This is deliberately a different fact from the controller's `admin.settings.*` audit line, which
   * says that an *op completed* and is written inside the nonce bracket so a replay cannot forge one.
   * This says what *changed*. A partial failure has the second and not the first, which is exactly
   * the truth of what happened.
   */
  private log(
    keys: readonly RuntimeSettingKey[],
    actorDid: string,
    what: (key: RuntimeSettingKey) => string,
  ): void {
    for (const key of keys) {
      this.logger.log(`settings: "${key}" ${what(key)} by ${actorDid}`);
    }
  }
}
