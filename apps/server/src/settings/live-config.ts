import { deriveCapabilities, type ServerConfig } from "../config";
import { DEPLOY_TIME_KEYS, RUNTIME_SETTING_KEYS, type DerivedKey } from "./registry";
import type { SettingsService } from "./settings.service";

/** DI token for the boot snapshot: `loadConfig()` run once, before any override is applied. */
export const BOOT_CONFIG = "BEACON_BOOT_CONFIG";
/**
 * DI token for the **live** {@link ServerConfig}. Inject this, not `loadConfig()`: a factory that
 * calls `loadConfig()` gets a snapshot, and every value it copies out is stale from that moment.
 */
export const SERVER_CONFIG = "BEACON_SERVER_CONFIG";
/**
 * DI token for the environment `loadConfig` was handed at boot.
 *
 * The parsed config cannot answer "did the operator export this variable, or is this the built-in
 * default?", because both produce the same value, and that question is the whole of what the admin
 * read has to say about a field nobody can edit at runtime. Injected rather than read from
 * `process.env` at the point of use so a test drives the report from the same fixture it built the
 * config from, instead of from whatever the test runner happens to have exported.
 */
export const BOOT_ENV = "BEACON_BOOT_ENV";
/** DI token for who a restore made this server (`RestoredIdentity`), read once at boot; else null. */
export const RESTORED_IDENTITY = "BEACON_RESTORED_IDENTITY";

/**
 * Project a source object under new names, **lazily** — the one place the accessor idiom is written.
 *
 * This round's whole discipline is "hold the object, read at the point of use". A consumer that
 * copies a value out of the config at construction is exactly as stale as it was before the round,
 * and the failure is silent: everything still compiles, every test still passes, and the setting just
 * never moves. Doing that by hand in fifteen places makes it a convention policed by review.
 *
 * `liveView(cfg, { ttlSeconds: "mailboxTtlSeconds" })` makes it structural instead. A source key that
 * does not exist fails with a did-you-mean, a mapping whose type does not fit the field it fills
 * fails where the result is used, and the result is enumerable accessors, so "nothing was copied" is
 * true by construction rather than by a test. What it does **not** catch is a mapping to a
 * *same-typed* sibling (`ttlSeconds: "mailboxMaxBody"`); no shape of this helper could, and the
 * hand-written getters it replaced could not either.
 *
 * **One caveat:** spreading the result (`{ ...liveView(...) }`) flattens the getters back to values
 * and silently undoes all of it. Use {@link Object.assign} with the view as the *target* to add
 * fields to it.
 */
export function liveView<S extends object, M extends Record<string, keyof S>>(
  src: S,
  map: M,
): { [K in keyof M]: S[M[K]] } {
  const out = {} as Record<string, unknown>;
  for (const to of Object.keys(map)) {
    const from = map[to] as keyof S;
    Object.defineProperty(out, to, { get: () => src[from], enumerable: true });
  }
  return out as { [K in keyof M]: S[M[K]] };
}

/**
 * How each derived field is computed, so a derived key cannot be added without saying how.
 *
 * A mapped type over {@link DerivedKey}, so the compiler requires exactly one entry per derived key
 * — the same trick the registry uses for `SETTING_SPECS`. Each function takes the **view**, not the
 * boot snapshot, so a derived value composes over live inputs rather than frozen ones.
 */
const DERIVATIONS: { readonly [K in DerivedKey]: (c: ServerConfig) => ServerConfig[K] } = {
  capabilities: deriveCapabilities,
};

/**
 * One `ServerConfig` whose operator-editable fields are **live** (`doc/spec/runtime-settings.md`
 * §5, PR 2).
 *
 * This is the whole point of the round. `loadConfig()` returns a snapshot, and every consumer that
 * called it got a value frozen at boot, which is why changing a policy knob needed a redeploy. The
 * view has the same shape and the same type, so nothing downstream changes, but:
 *
 * - the **42 runtime keys** are accessors over {@link SettingsService}, so a signed admin write is
 *   visible to the next read;
 * - the **derived keys** recompute from those, so turning the mailbox on reaches the signed
 *   descriptor the network reads and not merely the routes;
 * - the **deploy-time keys** are copied from the boot snapshot, because nothing can change them
 *   without a restart and a getter would imply otherwise.
 *
 * Built by walking the registry's lists rather than by naming 71 fields again, so the compile-time
 * exhaustiveness that classification already carries is what makes this total. A field nobody
 * classified fails `typecheck` in `registry.ts` long before it could go missing here.
 *
 * **Reading is the contract.** Every consumer must read `config.x` at the point of use rather than
 * copying it into its own field at construction, or the value it holds is exactly as stale as it was
 * before this round. That is why `*ConfigFrom` returns accessors and why `DidRateLimiter` keeps its
 * options object instead of destructuring it. The `live-config.test.ts` suite is what stops that
 * discipline decaying: it drives each config object from a settings change and requires the change
 * to arrive.
 */
export function createLiveConfig(boot: ServerConfig, settings: SettingsService): ServerConfig {
  const view = {} as Record<string, unknown>;

  // Deploy-time first, as plain data. `in` rather than a blind copy so an absent optional key
  // (no `BEACON_MNEMONIC`, no S3 bucket) stays absent instead of becoming present-and-undefined.
  for (const key of DEPLOY_TIME_KEYS) {
    if (key in boot) view[key] = boot[key];
  }

  // No special cases here, deliberately. Every rule about what a value may be — prerequisites, and
  // the one boot-bounded ceiling — lives in `reconcileRuntimeSettings`, so `SettingsService.get`,
  // `SettingState.value` and this view cannot disagree about the number in force.
  for (const key of RUNTIME_SETTING_KEYS) {
    Object.defineProperty(view, key, { get: () => settings.get(key), enumerable: true });
  }

  for (const [key, derive] of Object.entries(DERIVATIONS)) {
    Object.defineProperty(view, key, {
      get: () => derive(view as unknown as ServerConfig),
      enumerable: true,
    });
  }

  // Frozen so nobody writes through the view expecting it to stick; a settings change goes through
  // `SettingsService.set`, which is durable and audited. Accessors keep working when frozen.
  return Object.freeze(view) as unknown as ServerConfig;
}
