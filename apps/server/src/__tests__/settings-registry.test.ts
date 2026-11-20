import { MAX_MAILBOX_BODY } from "@beaconsgg/protocol-types";
import { describe, expect, it } from "vitest";
import { MAX_QUERY_CELLS } from "../common/query";
import { loadConfig, type ServerConfig } from "../config";
import { GEOCODE_PROVIDERS } from "../geocode/geocode-provider";
import {
  DEPLOY_TIME_FIELDS,
  DEPLOY_TIME_KEYS,
  DERIVED_KEYS,
  RUNTIME_SETTING_KEYS,
  SETTING_SPECS,
  isRuntimeSettingKey,
  reconcileRuntimeSettings,
  runtimeSettingsFrom,
  validateRuntimeSettings,
} from "../settings/registry";
import { testConfig } from "./test-config";

/**
 * The classification (`doc/spec/runtime-settings.md` §3). Most of it is enforced by the compiler
 * and not restated here: `_EveryFieldIsClassified` catches a field nobody classified, the
 * `satisfies` clause on each list catches a key that is not a config field, `SETTING_SPECS` is a
 * mapped type so it cannot be missing or gain a key, and `SECRET_KEYS satisfies readonly
 * DeployTimeKey[]` already makes a secret impossible to classify as runtime. Only what a type
 * cannot say is tested here.
 */

describe("the settings registry classifies every config field exactly once", () => {
  it("puts no key in two lists", () => {
    const all = [...RUNTIME_SETTING_KEYS, ...DEPLOY_TIME_KEYS, ...DERIVED_KEYS];
    expect(all).toHaveLength(new Set(all).size);
  });

  it("covers every field a parsed config actually has", () => {
    // The compiler checks the lists against `keyof ServerConfig`, a *type*. This checks them against
    // the object `loadConfig` really returns, which is what an admin op will enumerate.
    const fields = Object.keys(testConfig());
    const classified = new Set<string>([
      ...RUNTIME_SETTING_KEYS,
      ...DEPLOY_TIME_KEYS,
      ...DERIVED_KEYS,
    ]);
    expect(fields.filter((f) => !classified.has(f))).toEqual([]);
  });

  it("keeps the three access-control settings out of the runtime set (§3.3)", () => {
    // A setting that can disable a control does not itself become admin-editable: an admin who
    // could edit these could empty the allowlist, open the server to every origin, or make req.ip
    // client-controlled and silently defeat the IP rate limiter.
    for (const key of ["admins", "corsOrigins", "trustProxy"] as const) {
      expect(RUNTIME_SETTING_KEYS).not.toContain(key);
    }
  });

  it("keeps placesCellPrecision deploy-time, because it writes the place_cells index (§3.4)", () => {
    expect(RUNTIME_SETTING_KEYS).not.toContain("placesCellPrecision");
  });

  it("narrows an arbitrary string to a runtime key", () => {
    expect(isRuntimeSettingKey("mailboxTtlSeconds")).toBe(true);
    expect(isRuntimeSettingKey("admins")).toBe(false); // deploy-time, not editable
    expect(isRuntimeSettingKey("constructor")).toBe(false); // not an inherited property
    expect(isRuntimeSettingKey("nonsense")).toBe(false);
  });
});

describe("the declared schemas accept what the server actually ships", () => {
  it("validates every default the environment produces with nothing set", () => {
    const defaults = runtimeSettingsFrom(testConfig());
    const rejected = RUNTIME_SETTING_KEYS.filter(
      (key) => !SETTING_SPECS[key].schema.safeParse(defaults[key]).success,
    );
    // A default its own schema rejects would mean an admin could never re-set that value after
    // changing it, which is a registry bug rather than an operator one.
    expect(rejected).toEqual([]);
  });

  it("gives every field its own variable, which is what makes a correlated name catchable", () => {
    // The check that catches the hazard, and it is not the obvious one. Several fields *derive* from
    // another field's variable — `host` defaults to `localhost:${port}` — so naming `PORT` as the
    // variable behind `host` sails through any "set it and watch the field move" test while telling
    // an operator to edit the wrong line of their compose file.
    //
    // What makes that name wrong is not that it fails to move `host`; it does move it. It is that
    // `PORT` is already spoken for. **A correlated variable is correlated because it is some other
    // field's variable**, so injectivity is the property that rules the whole class out, and it is
    // one line.
    const byName = new Map<string, string[]>();
    for (const [key, name] of Object.entries(ENV_NAMES)) {
      byName.set(name, [...(byName.get(name) ?? []), key]);
    }
    const shared = [...byName].filter(([, keys]) => keys.length > 1);
    expect(shared).toEqual([]);
    expect(byName.size).toBe(RUNTIME_SETTING_KEYS.length + DEPLOY_TIME_KEYS.length);
  });

  it("names, for every field, the env var that supplies it — and needs that var to supply it", () => {
    // The registry writes each env-var name a second time (`loadConfig` has the first), and the names
    // are what an operator is told to edit: in a reset log line, in a stale-override error, and now
    // in every read-only row of the admin console. A prefix check would pass a plausible-but-wrong
    // name, so each one is exercised for real, in **both** directions:
    //
    // - **sufficient** — set the named variable alone and the field moves off its default;
    // - **necessary** — in an environment where every variable is set, remove that one and the field
    //   moves back, so a name that only matters while some other variable is unset fails here.
    //
    // Neither half catches a name borrowed from another field; the injectivity check above is what
    // does that. These two catch a name that is simply wrong, or dead.
    const chosen = new Map<string, string>();
    const insufficient: string[] = [];
    for (const [key, name] of Object.entries(ENV_NAMES)) {
      const probe = probeFor(key as keyof ServerConfig, name);
      if (probe === undefined) insufficient.push(`${key} (${name})`);
      else chosen.set(name, probe);
    }
    expect(insufficient).toEqual([]);

    const all = Object.fromEntries(chosen) as NodeJS.ProcessEnv;
    const unnecessary: string[] = [];
    for (const [key, name] of Object.entries(ENV_NAMES)) {
      const without = { ...all };
      delete without[name];
      const field = key as keyof ServerConfig;
      // A required variable is necessary by refusal: without it there is no config at all.
      const read = (env: NodeJS.ProcessEnv): string => {
        try {
          return JSON.stringify(loadConfig(env)[field]);
        } catch (err) {
          if (err instanceof Error && err.message.startsWith("BEACON_DATABASE_URL is not set")) {
            return "refused";
          }
          throw err;
        }
      };
      if (read(all) === read(without)) {
        unnecessary.push(`${key} (${name})`);
      }
    }
    expect(unnecessary).toEqual([]);
  });
});

/** Every field's declared variable: the runtime 42 from their specs, the deploy 29 from the table. */
const ENV_NAMES: Record<string, string> = {
  ...Object.fromEntries(RUNTIME_SETTING_KEYS.map((key) => [key, SETTING_SPECS[key].env])),
  ...Object.fromEntries(DEPLOY_TIME_KEYS.map((key) => [key, DEPLOY_TIME_FIELDS[key].env])),
};

/**
 * The first probe that moves `key` off its default with only `name` set, or undefined if none does.
 *
 * The two contribution flags are computed as `placesEnabled && boolFromEnv(...)`, so their own
 * variable cannot move them while places is off. They get the prerequisite on **both** ends of the
 * comparison, so the test measures the variable under test and not the coupling. `placesEnabled`
 * itself deliberately does not, or the prerequisite would move it and any name at all would pass.
 */
const PREREQ = { BEACON_PLACES: "true" } as const;
const CONTEXT: Record<string, NodeJS.ProcessEnv> = {
  placesContributionsEnabled: PREREQ,
  placesContribExportEnabled: PREREQ,
};
function probeFor(key: keyof ServerConfig, name: string): string | undefined {
  const context = CONTEXT[key] ?? {};
  const base = testConfig({ ...context } as NodeJS.ProcessEnv);
  for (const probe of PROBES) {
    try {
      const parsed = testConfig({ ...context, [name]: probe } as NodeJS.ProcessEnv);
      if (JSON.stringify(parsed[key]) !== JSON.stringify(base[key])) return probe;
    } catch {
      // loadConfig refuses this probe for this variable; try the next shape.
    }
  }
  return undefined;
}

/**
 * One probe per value shape a setting can take. The test only needs *some* value that moves a key
 * off its default, so it tries these in turn and takes the first that both parses and differs.
 */
const PROBES = [
  "7",
  "3", // a second number, so a knob whose default is already 7 still moves
  "true",
  "false",
  "request", // accessLevel is an enum whose default is "open"
  "s3", // mediaBackend is an enum whose default is "fs"
  "https://probe.example.com",
  "image/gif",
  "u4pruy",
  "probe",
];

/**
 * The schemas police *admin* writes, which happen at runtime with nobody watching, so the bar is not
 * "would `loadConfig` accept this" but "can the consumer survive it". These three are the cases
 * where those differ, and each was reachable before it was tested.
 */
describe("schemas are calibrated against the consumer, not just loadConfig", () => {
  it("refuses a geocode provider createGeocodeProvider cannot build", () => {
    // `createGeocodeProvider` throws on an unknown name, from an app.module factory, so this would
    // be accepted at write time and take the server down at the next restart — with the override
    // sticky, so fixing the env var would not help, and the server too dead to serve the reset.
    for (const provider of GEOCODE_PROVIDERS) {
      expect(SETTING_SPECS.geocodeProvider.schema.safeParse(provider).success).toBe(true);
    }
    expect(SETTING_SPECS.geocodeProvider.schema.safeParse("google").success).toBe(false);
    expect(SETTING_SPECS.geocodeProvider.schema.safeParse("").success).toBe(false);
  });

  it("caps the places cell budget at the shared query ceiling", () => {
    // `GET /places?cells=` is unauthenticated and this is its only cap: unlike /discovery, the places
    // read does not also clamp against MAX_QUERY_CELLS. A typo of one extra zero would turn the
    // cell-enumeration guard off, so the ceiling loadConfig already defaults to is enforced here.
    expect(SETTING_SPECS.placesQueryMaxCells.schema.safeParse(MAX_QUERY_CELLS).success).toBe(true);
    expect(SETTING_SPECS.placesQueryMaxCells.schema.safeParse(MAX_QUERY_CELLS + 1).success).toBe(
      false,
    );
    expect(SETTING_SPECS.placesQueryMaxCells.schema.safeParse(1_000_000).success).toBe(false);
  });

  it("caps the mailbox body limit at the wire cap", () => {
    const { schema } = SETTING_SPECS.mailboxMaxBody;
    expect(schema.safeParse(MAX_MAILBOX_BODY).success).toBe(true);
    expect(schema.safeParse(MAX_MAILBOX_BODY + 1).success).toBe(false);
    expect(testConfig({ BEACON_MAILBOX_MAX_BODY: String(MAX_MAILBOX_BODY) }).mailboxMaxBody).toBe(
      MAX_MAILBOX_BODY,
    );
    expect(() => testConfig({ BEACON_MAILBOX_MAX_BODY: String(MAX_MAILBOX_BODY + 1) })).toThrow(
      /BEACON_MAILBOX_MAX_BODY.*at most 4096/,
    );
  });

  it("refuses an empty coverage list, which loadConfig cannot produce", () => {
    // `[""]` means every cell; `[]` means no coverage at all, in a *signed* descriptor. loadConfig
    // floors the empty list to `[""]`, so `[]` is a state only the admin path could reach.
    expect(SETTING_SPECS.coverage.schema.safeParse([""]).success).toBe(true);
    expect(SETTING_SPECS.coverage.schema.safeParse(["9q8y"]).success).toBe(true);
    expect(SETTING_SPECS.coverage.schema.safeParse([]).success).toBe(false);
  });
});

describe("rules that hold between settings", () => {
  const runtime = runtimeSettingsFrom(testConfig());

  it("refuses contributions without the places capability", () => {
    expect(() =>
      validateRuntimeSettings({
        ...runtime,
        placesEnabled: false,
        placesContributionsEnabled: true,
      }),
    ).toThrow(/needs placesEnabled/);
  });

  it("refuses contribution export without the places capability", () => {
    expect(() =>
      validateRuntimeSettings({
        ...runtime,
        placesEnabled: false,
        placesContribExportEnabled: true,
      }),
    ).toThrow(/needs placesEnabled/);
  });

  it("accepts them once places is on", () => {
    expect(() =>
      validateRuntimeSettings({
        ...runtime,
        placesEnabled: true,
        placesContributionsEnabled: true,
        placesContribExportEnabled: true,
      }),
    ).not.toThrow();
  });

  it("forces a dependent off rather than refusing, where there is nobody to refuse to", () => {
    // The other half of the coupling: `validateRuntimeSettings` refuses a *write*, but a reset, a
    // restart against a changed env and two interleaved writes all produce the pair with no admin
    // present. Reconciling means the pair cannot be served however the rows got there.
    const forbidden = {
      ...runtime,
      placesEnabled: false,
      placesContributionsEnabled: true,
      placesContribExportEnabled: true,
    };

    expect(() => validateRuntimeSettings(forbidden)).toThrow();
    const { settings, adjusted } = reconcileRuntimeSettings(forbidden, runtime);
    expect(settings).toMatchObject({
      placesEnabled: false,
      placesContributionsEnabled: false,
      placesContribExportEnabled: false,
    });
    // It says *why*, because the two rules leave the same shape and want different remedies from an
    // operator: turn the prerequisite on, against raise the variable and restart.
    expect(adjusted).toEqual({
      placesContributionsEnabled: "prerequisite",
      placesContribExportEnabled: "prerequisite",
    });
  });

  it("leaves a settled configuration untouched, including its object identity", () => {
    const on = { ...runtime, placesEnabled: true, placesContributionsEnabled: true };

    expect(reconcileRuntimeSettings(on, runtime).settings).toBe(on);
    expect(reconcileRuntimeSettings(runtime, runtime).settings).toBe(runtime);
    expect(reconcileRuntimeSettings(runtime, runtime).adjusted).toEqual({});
  });

  it("accepts the shipped defaults", () => {
    expect(() => validateRuntimeSettings(runtime)).not.toThrow();
  });

  it("clamps mediaMaxBytes to its boot value, and leaves a lowered one alone", () => {
    // The body parser is sized from the boot value and body-parser resolves `limit` once, so raising
    // this cannot raise the ceiling a request meets. Lowering can, and does.
    const raised = { ...runtime, mediaMaxBytes: runtime.mediaMaxBytes * 10 };
    const lowered = { ...runtime, mediaMaxBytes: 1_000 };

    expect(reconcileRuntimeSettings(raised, runtime).settings.mediaMaxBytes).toBe(
      runtime.mediaMaxBytes,
    );
    expect(reconcileRuntimeSettings(raised, runtime).adjusted.mediaMaxBytes).toBe("ceiling");
    expect(reconcileRuntimeSettings(lowered, runtime).settings.mediaMaxBytes).toBe(1_000);
    expect(reconcileRuntimeSettings(lowered, runtime).adjusted).toEqual({});
  });
});
