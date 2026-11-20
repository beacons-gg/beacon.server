import type { AdminSetting } from "@beaconsgg/protocol-types";
import type { ServerConfig } from "../config";
import { DEPLOY_TIME_FIELDS, DEPLOY_TIME_KEYS, SETTING_SPECS } from "./registry";
import type { SettingsService } from "./settings.service";

/**
 * The whole configuration as one operator-facing list (`doc/spec/runtime-settings.md` §5, PR 3).
 *
 * **Both halves, not just the editable one.** The 29 deploy-time fields are reported read-only
 * rather than omitted, because an operator looking for "why can I not change the admin list" is
 * better served by a row that says so and names `BEACON_ADMINS` than by a field that is simply not
 * there. `editable` is the difference, and it is a separate fact from `provenance`: read-only fields
 * always come from the environment, so collapsing the two would make "you may not change this" and
 * "nobody has changed this" the same word.
 *
 * **The secrets are reported as set or unset and never by value** (registry `SECRET_KEYS`, derived
 * from the one place secrecy is declared). An admin op that echoed key material, an S3 credential or
 * the database DSN would turn read access to the console into read access to the secret, and the
 * console has no use for the bytes.
 *
 * **`configured` says whether the variable is actually exported**, on every row rather than only the
 * secret ones. Without it a field on its built-in default and a field an operator deliberately set to
 * that same value are indistinguishable, on the one screen built to answer "I set that variable and
 * nothing changed". It reads the environment rather than comparing against a fresh `loadConfig({})`,
 * because a variable set *to* the default is exactly the case the comparison gets wrong.
 *
 * The derived `capabilities` is left out: it is a consequence of the toggles rather than a thing to
 * configure, and `admin.status` already reports it beside the descriptor facts it belongs with.
 *
 * Order is the registry's: editable fields first, in their grouped declaration order, then the
 * deploy-time ones. A console can render the list as it arrives and get a sensible page. An absent
 * optional is omitted rather than sent as `null`, matching every other optional on this wire, and
 * the four shapes a value may take are checked by the compiler at each assignment below: a config
 * field typed as anything else fails `typecheck` here rather than as a schema failure in front of an
 * operator.
 */
export function settingsReport(
  config: ServerConfig,
  settings: SettingsService,
  /** The environment the server booted with — `process.env` in the app, a fixture in tests. */
  env: NodeJS.ProcessEnv,
): AdminSetting[] {
  const isSet = (name: string): boolean => (env[name] ?? "").trim() !== "";

  const runtime: AdminSetting[] = settings.all().map((state) => ({
    key: state.key,
    env: SETTING_SPECS[state.key].env,
    editable: true,
    provenance: state.provenance,
    configured: isSet(SETTING_SPECS[state.key].env),
    ...(state.value !== undefined ? { value: state.value } : {}),
    ...(state.updatedBy !== undefined ? { updatedBy: state.updatedBy } : {}),
    ...(state.updatedAt !== undefined ? { updatedAt: state.updatedAt } : {}),
    ...(state.envValue !== undefined ? { envValue: state.envValue } : {}),
    ...(state.storedValue !== undefined ? { storedValue: state.storedValue } : {}),
    ...(state.storedReason !== undefined ? { storedReason: state.storedReason } : {}),
  }));

  const deploy: AdminSetting[] = DEPLOY_TIME_KEYS.map((key) => {
    const { env: name, secret } = DEPLOY_TIME_FIELDS[key];
    const value = config[key];
    return {
      key,
      env: name,
      editable: false,
      // Always `env`: nothing else can supply a field the settings table does not hold. No
      // `envValue` either, because for these it *is* the value, and a second copy would invite a
      // console to draw a "differs from the default" badge over two identical numbers.
      provenance: "env" as const,
      configured: isSet(name),
      ...(secret ? { secret: true as const } : value !== undefined ? { value } : {}),
    };
  });

  return [...runtime, ...deploy];
}
