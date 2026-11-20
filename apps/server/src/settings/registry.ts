/**
 * The classification every `ServerConfig` field falls into (`doc/spec/runtime-settings.md` §3).
 *
 * Config has three kinds of field and they behave differently, so the split is declared here once
 * rather than inferred at each use:
 *
 * - **runtime** — operator policy. Lives in the `settings` table, editable by a signed admin op,
 *   seeded from the environment (§4).
 * - **deploy-time** — deploy shape, secrets, and the settings that protect other controls. Read from
 *   the environment and nowhere else, so there is no row that could disagree with them.
 * - **derived** — computed from the others and stored nowhere, because a stored copy is a second
 *   truth that goes stale.
 *
 * The three lists are **exhaustive over `keyof ServerConfig`, enforced at compile time**:
 * {@link _EveryFieldIsClassified} catches a field nobody classified, and the `satisfies` clause on
 * each list catches a listed key that is not a config field at all (a typo, or one left behind by a
 * rename). Adding a field to `ServerConfig` without deciding which
 * kind it is fails `typecheck`, which is the point: the alternative is a field that silently
 * defaults to deploy-time and quietly cannot be changed.
 */
import {
  gameSlugSchema,
  geohashCellSchema,
  httpUrlSchema,
  MAX_MAILBOX_BODY,
  serverAccessLevelSchema,
  serverDescriptorSchema,
} from "@beaconsgg/protocol-types";
import { z } from "zod";
import { MAX_QUERY_CELLS } from "../common/query";
import { MAX_ABOUT_LENGTH, type ServerConfig } from "../config";
import { GEOCODE_PROVIDERS } from "../geocode/geocode-provider";

/** Operator policy: stored, seeded from env, editable at runtime (§3.2). */
export const RUNTIME_SETTING_KEYS = [
  // Descriptor — what this server says it is.
  "name",
  "description",
  "contact",
  // The long description at GET /server/about. Not in the descriptor, but the same kind of text.
  "about",
  "coverage",
  "accessLevel",
  "publicUrl",
  // Admission policy — which games may write here.
  "games",
  // Read-only mode: refuses writes and pauses background writers, live.
  "writeLocked",
  // Capability toggles — which surfaces answer at all.
  "mailboxEnabled",
  "mediaEnabled",
  "geocodeEnabled",
  "placesEnabled",
  "placesContributionsEnabled",
  "placesContribExportEnabled",
  // Mailbox budgets.
  "mailboxTtlSeconds",
  "mailboxMaxBody",
  "mailboxSendMax",
  "mailboxSendWindowMs",
  // Media budgets.
  "mediaMaxBytes",
  "mediaTypes",
  "mediaQuotaBytes",
  "mediaRateMax",
  "mediaRateWindowMs",
  "mediaCdnUrl",
  // Geocode: the provider, and the fair-use pacing its terms require.
  "geoUserAgent",
  "geocodeProvider",
  "geocodeEndpoint",
  "geocodePrecision",
  "geocodeTtlSeconds",
  "geocodeNegativeTtlSeconds",
  "geocodeMinIntervalMs",
  "geocodeTimeoutMs",
  // Places budgets.
  "placesQueryPageSize",
  "placesQueryMaxCells",
  "placesTimeoutMs",
  "placesImageMaxBytes",
  "placesImageTimeoutMs",
  "placesImageMinIntervalMs",
  "placesProposalRateMax",
  "placesProposalRateWindowMs",
  "placesProposalMaxPending",
] as const satisfies readonly (keyof ServerConfig)[];

/**
 * Read from the environment and nowhere else (§3.1). Four groups, and the reasons differ:
 *
 * - **Bootstrap** (`databaseUrl`, `pgPoolSize`, `maxNonces`) — you need the database
 *   before you can read settings out of it.
 * - **Listen** (`port`, `host`) — `port` binds the socket at boot, and `host` is baked into every
 *   minted room id, so changing it orphans ids clients already hold.
 * - **Secrets and deploy shape** — key material, S3 credentials, filesystem paths, the Swagger mount.
 * - **Access control** (`admins`, `corsOrigins`, `trustProxy`) — see §3.3. Each is the control that
 *   protects the others, and the rule is that *a setting which can disable a control does not itself
 *   become admin-editable*. An admin who could edit `admins` could empty the allowlist and lock the
 *   operator out; one who could widen `corsOrigins` could hand the server to every browser; one who
 *   could set `trustProxy` true would make `req.ip` the client-controlled `X-Forwarded-For` and
 *   silently defeat the IP rate limiter.
 *
 * Plus `placesCellPrecision`, which is data shape rather than preference: it decides the
 * `place_cells` rows written on every commit *and* the precision reads coarsen to, so changing it on
 * a live server leaves new places indexed against old queries and makes them silently return fewer
 * results. Changing it is a reindex, not an edit (§3.4).
 */
export const DEPLOY_TIME_KEYS = [
  "port",
  "host",
  "version",
  "databaseUrl",
  "pgPoolSize",
  "maxNonces",
  "writerLockWaitMs",
  "mnemonic",
  "keyProvider",
  "keyFile",
  "keyPassphrase",
  "corsOrigins",
  "trustProxy",
  "admins",
  "mediaBackend",
  "mediaDir",
  "mediaS3Endpoint",
  "mediaS3Region",
  "mediaS3Bucket",
  "mediaS3AccessKeyId",
  "mediaS3SecretAccessKey",
  "mediaS3ForcePathStyle",
  "mediaS3Prefix",
  // The hoster's ceiling: an admin op raising it would defeat it.
  "mediaLimitBytes",
  "restoreDatabaseLimitBytes",
  // The hoster's fence around a backup's destination: an admin op opening it would defeat it.
  "backupPrivateEndpoints",
  "atlasStagingDir",
  "atlasVolumesDir",
  "placesCellPrecision",
  "docsEnabled",
  "docsPath",
  // The home page: what a browser at `/` is shown, and what it links to and loads.
  "homeEnabled",
  "homeConsoleUrl",
  "homeSiteUrl",
  "homeMapTiles",
  "homeStats",
  "sourceUrl",
] as const satisfies readonly (keyof ServerConfig)[];

/**
 * Computed from the others, stored nowhere: `capabilities` is derived from the toggles plus
 * `games`. Persisting it would create a second truth that goes stale the moment a toggle moves,
 * which is what happened when it was derived once at boot and read from a snapshot: an admin
 * turning the mailbox on changed the routes and not the signed descriptor. `live-config.ts` names
 * the derivation for each of these and recomputes per read.
 *
 * `signedSurfaceEnabled` used to live here and is gone. It gated only the nonce log's **sweep**, and
 * deriving "is any signed surface on" at boot from toggles that are now runtime meant enabling one
 * later left its nonces accumulating unswept. The sweep runs unconditionally instead, which costs an
 * interval over an empty table and removes the stale-derivation problem rather than tracking it.
 */
export const DERIVED_KEYS = ["capabilities"] as const satisfies readonly (keyof ServerConfig)[];

export type RuntimeSettingKey = (typeof RUNTIME_SETTING_KEYS)[number];
export type DeployTimeKey = (typeof DEPLOY_TIME_KEYS)[number];
export type DerivedKey = (typeof DERIVED_KEYS)[number];

/**
 * One row per deploy-time field: the environment variable behind it, and whether it may be reported
 * **by value**.
 *
 * The env name is here so the admin read can tell an operator *what to edit* rather than only that a
 * field is read-only. It is the second copy of these names (`loadConfig` has the first), for the same
 * reason `SETTING_SPECS` carries the runtime ones, and it is policed the same way: a test requires
 * each named variable to move its field, to be needed to move it, and to belong to no other field.
 * `port` is why that test earns its weight, being the one field whose variable is not
 * `BEACON_`-prefixed at all.
 *
 * **`secret` is required rather than optional, and that is the whole design of this table.** It
 * began as a separate list of the five keys somebody had thought of, and `databaseUrl` was not among
 * them: a Postgres DSN carries its own password, so an admin read published the database credential.
 * A list nobody is forced to consult catches only the secrets its author remembered. A required
 * field per key means adding `BEACON_REDIS_URL` cannot compile until somebody has answered "may this
 * be echoed to an admin?", which is the only version of this that stays true as the table grows.
 *
 * A mapped type over {@link DeployTimeKey}, so a new deploy-time field cannot be added without both
 * answers, exactly as `SETTING_SPECS` does for the runtime half. Seventy-four restated names is
 * also the strongest form of the argument for inverting this: `config.ts` should export the name
 * table and this should import it.
 */
export const DEPLOY_TIME_FIELDS: {
  readonly [K in DeployTimeKey]: { readonly env: string; readonly secret: boolean };
} = {
  port: { env: "PORT", secret: false },
  host: { env: "BEACON_HOST", secret: false },
  version: { env: "BEACON_VERSION", secret: false },
  databaseUrl: { env: "BEACON_DATABASE_URL", secret: true },
  pgPoolSize: { env: "BEACON_PG_POOL_SIZE", secret: false },
  maxNonces: { env: "BEACON_MAX_NONCES", secret: false },
  writerLockWaitMs: { env: "BEACON_WRITER_LOCK_WAIT_MS", secret: false },
  mnemonic: { env: "BEACON_MNEMONIC", secret: true },
  keyProvider: { env: "BEACON_KEY_PROVIDER", secret: false },
  keyFile: { env: "BEACON_KEY_FILE", secret: true },
  keyPassphrase: { env: "BEACON_KEY_PASSPHRASE", secret: true },
  corsOrigins: { env: "BEACON_CORS_ORIGINS", secret: false },
  trustProxy: { env: "BEACON_TRUST_PROXY", secret: false },
  admins: { env: "BEACON_ADMINS", secret: false },
  mediaBackend: { env: "BEACON_MEDIA_BACKEND", secret: false },
  mediaDir: { env: "BEACON_MEDIA_DIR", secret: false },
  mediaS3Endpoint: { env: "BEACON_MEDIA_S3_ENDPOINT", secret: false },
  mediaS3Region: { env: "BEACON_MEDIA_S3_REGION", secret: false },
  mediaS3Bucket: { env: "BEACON_MEDIA_S3_BUCKET", secret: false },
  mediaS3AccessKeyId: { env: "BEACON_MEDIA_S3_ACCESS_KEY_ID", secret: true },
  mediaS3SecretAccessKey: { env: "BEACON_MEDIA_S3_SECRET_ACCESS_KEY", secret: true },
  mediaS3ForcePathStyle: { env: "BEACON_MEDIA_S3_FORCE_PATH_STYLE", secret: false },
  mediaS3Prefix: { env: "BEACON_MEDIA_S3_PREFIX", secret: false },
  mediaLimitBytes: { env: "BEACON_MEDIA_LIMIT_BYTES", secret: false },
  restoreDatabaseLimitBytes: { env: "BEACON_RESTORE_DATABASE_LIMIT_BYTES", secret: false },
  backupPrivateEndpoints: { env: "BEACON_BACKUP_PRIVATE_ENDPOINTS", secret: false },
  atlasStagingDir: { env: "BEACON_ATLAS_STAGING_DIR", secret: false },
  atlasVolumesDir: { env: "BEACON_ATLAS_VOLUMES_DIR", secret: false },
  placesCellPrecision: { env: "BEACON_PLACES_CELL_PRECISION", secret: false },
  docsEnabled: { env: "BEACON_DOCS", secret: false },
  docsPath: { env: "BEACON_DOCS_PATH", secret: false },
  homeEnabled: { env: "BEACON_HOME", secret: false },
  homeConsoleUrl: { env: "BEACON_HOME_CONSOLE_URL", secret: false },
  homeSiteUrl: { env: "BEACON_HOME_SITE_URL", secret: false },
  homeMapTiles: { env: "BEACON_HOME_MAP_TILES", secret: false },
  homeStats: { env: "BEACON_HOME_STATS", secret: false },
  sourceUrl: { env: "BEACON_SOURCE_URL", secret: false },
};

/**
 * The deploy-time fields that must never be reported by value, only as set or unset.
 *
 * Derived from {@link DEPLOY_TIME_FIELDS} rather than restated, so the two cannot disagree. Key
 * material unlocks the server's identity, the S3 pair is a live credential and `databaseUrl` embeds
 * the database password; an admin op that echoed any of them would turn read access to the console
 * into read access to the secret. Secrecy is declarable **only** on a deploy-time key, because that
 * is the only half this table has rows for, which is what makes "no runtime setting is a secret" a
 * fact about the types rather than a claim.
 */
export const SECRET_KEYS: readonly DeployTimeKey[] = DEPLOY_TIME_KEYS.filter(
  (key) => DEPLOY_TIME_FIELDS[key].secret,
);

/** The runtime slice of {@link ServerConfig}: exactly the fields the settings table owns. */
export type RuntimeSettings = Pick<ServerConfig, RuntimeSettingKey>;

/**
 * Which rule held a stored value back from taking effect. The remedies are different sentences, so a
 * console that could only say "not in force" would be telling an operator nothing actionable:
 * `prerequisite` wants a capability turned on, `ceiling` wants an environment variable raised and a
 * restart.
 */
export type SettingAdjustment = "prerequisite" | "ceiling";

/** What {@link reconcileRuntimeSettings} produced, and which keys it had to change to produce it. */
export interface ReconciledSettings {
  settings: RuntimeSettings;
  adjusted: Partial<Record<RuntimeSettingKey, SettingAdjustment>>;
}

/**
 * Compile-time exhaustiveness. If a new `ServerConfig` field is not in one of the three lists,
 * `Exclude<...>` is that field's name rather than `never` and this alias fails to typecheck with a
 * message naming it. Deleting a field that is still listed fails the same way from the other side,
 * because the `as const` arrays are checked against `keyof ServerConfig` below.
 */
type AssertNever<T extends never> = T;
export type _EveryFieldIsClassified = AssertNever<
  Exclude<keyof ServerConfig, RuntimeSettingKey | DeployTimeKey | DerivedKey>
>;

export interface SettingSpec<T> {
  /**
   * Validates an admin write. **At least as strict as `loadConfig`**, which matters more than it
   * looks: a bad env var fails at boot with a human watching the logs, and a bad admin write fails
   * at runtime with nobody watching at all. Where `loadConfig` already validates (`games` against
   * `gameSlugSchema`, `accessLevel` against `serverAccessLevelSchema`), the same schema is reused
   * rather than restated, so the two cannot drift.
   */
  readonly schema: z.ZodType<T>;
  /** The environment variable that supplies this setting's default. */
  readonly env: string;
}

/** A positive integer, matching what `intFromEnv` accepts (finite, > 0, floored). */
const positiveInt = z.number().int().positive();
/** A non-empty, trimmed string: `loadConfig` treats `""` as unset and falls back to a default. */
const nonEmpty = z.string().trim().min(1);
/**
 * A URL the server publishes or redirects to. `z.string().url()` alone accepts anything `new URL()`
 * parses, `javascript:` and `data:` included, which matters most for `mediaCdnUrl`: it is the target
 * media fetches are redirected to. The allowlist is protocol-types' own, so this path cannot drift
 * from the one the places contributions path already uses.
 */
const httpUrl = httpUrlSchema(2048);

export const SETTING_SPECS: { readonly [K in RuntimeSettingKey]: SettingSpec<RuntimeSettings[K]> } =
  {
    name: {
      schema: nonEmpty.max(120),
      env: "BEACON_NAME",
    },
    description: {
      // The cap belongs to the wire: these two go straight into the signed descriptor, and a value
      // over serverDescriptorSchema's limit would fail at signing time rather than at the admin write.
      schema: serverDescriptorSchema.shape.description,
      env: "BEACON_DESCRIPTION",
    },
    contact: {
      schema: serverDescriptorSchema.shape.contact,
      env: "BEACON_CONTACT",
    },
    about: {
      // Markdown, so it is kept as written; the cap is the one loadConfig applies at boot.
      schema: z.string().max(MAX_ABOUT_LENGTH).optional(),
      env: "BEACON_ABOUT",
    },
    coverage: {
      // The alphabet and the 12-char cap are declared once, in protocol-types' GEOHASH_RE, whose
      // docblock says outright that anything wanting a second opinion takes it from there. `""` is
      // legal coverage (it means every cell) and geohashCellSchema requires at least one character,
      // so it is admitted alongside rather than by loosening the matcher.
      //
      // Non-empty, because `loadConfig` floors an empty list to `[""]` and never produces `[]`. The
      // two are not the same: `[""]` advertises every cell, `[]` advertises no coverage at all, in a
      // *signed* descriptor. An admin who wants to serve nowhere has `accessLevel`, which says so on
      // purpose rather than by omission.
      schema: z.array(z.union([z.literal(""), geohashCellSchema])).min(1),
      env: "BEACON_COVERAGE",
    },
    accessLevel: {
      schema: serverAccessLevelSchema,
      env: "BEACON_ACCESS_LEVEL",
    },
    publicUrl: {
      schema: httpUrl,
      env: "BEACON_PUBLIC_URL",
    },
    games: {
      schema: z.array(gameSlugSchema),
      env: "BEACON_GAMES",
    },
    writeLocked: {
      schema: z.boolean(),
      env: "BEACON_WRITE_LOCK",
    },
    mailboxEnabled: {
      schema: z.boolean(),
      env: "BEACON_MAILBOX",
    },
    mediaEnabled: {
      // Runtime all the way through: the two `app.module` factories that hold media
      // (`SnapshotService`'s media transfer and `ContributionsService`'s media handle) read this
      // per use, through a getter and a thunk, so turning it on at runtime reaches snapshots and
      // contributions as well as the route gate.
      schema: z.boolean(),
      env: "BEACON_MEDIA",
    },
    geocodeEnabled: {
      schema: z.boolean(),
      env: "BEACON_GEOCODE",
    },
    placesEnabled: {
      schema: z.boolean(),
      env: "BEACON_PLACES",
    },
    placesContributionsEnabled: {
      schema: z.boolean(),
      env: "BEACON_PLACES_PROPOSALS",
    },
    placesContribExportEnabled: {
      schema: z.boolean(),
      env: "BEACON_PLACES_PROPOSALS_EXPORT",
    },
    mailboxTtlSeconds: {
      schema: positiveInt,
      env: "BEACON_MAILBOX_TTL",
    },
    mailboxMaxBody: {
      // Capped at the wire's own limit, as `loadConfig` caps the variable (see `ServerConfig`).
      schema: positiveInt.max(MAX_MAILBOX_BODY),
      env: "BEACON_MAILBOX_MAX_BODY",
    },
    mailboxSendMax: {
      schema: positiveInt,
      env: "BEACON_MAILBOX_RATE_LIMIT_MAX",
    },
    mailboxSendWindowMs: {
      schema: positiveInt,
      env: "BEACON_MAILBOX_RATE_LIMIT_WINDOW_MS",
    },
    mediaMaxBytes: {
      // Asymmetric: `main.ts` sizes the JSON body parser from this at boot (`mediaMaxBytes * 1.4 +
      // 65_536`). Lowering it at runtime is honest — `MediaService` refuses first, with its 413.
      // Raising it above the boot value is not: the body parser rejects the upload before the
      // service ever sees it, so the effective limit stays where it was and an admin console would
      // report a number that is not in force. A ceiling cannot be written here because it is the
      // *env* value, which a static schema cannot see.
      schema: positiveInt,
      env: "BEACON_MEDIA_MAX_BYTES",
    },
    mediaTypes: {
      schema: z.array(nonEmpty.regex(/^[\w.+-]+\/[\w.+-]+$/, "not a MIME type")).min(1),
      env: "BEACON_MEDIA_TYPES",
    },
    mediaQuotaBytes: {
      schema: positiveInt,
      env: "BEACON_MEDIA_QUOTA_BYTES",
    },
    mediaRateMax: {
      schema: positiveInt,
      env: "BEACON_MEDIA_RATE_LIMIT_MAX",
    },
    mediaRateWindowMs: {
      schema: positiveInt,
      env: "BEACON_MEDIA_RATE_LIMIT_WINDOW_MS",
    },
    mediaCdnUrl: {
      schema: httpUrl.optional(),
      env: "BEACON_MEDIA_CDN_URL",
    },
    geoUserAgent: {
      schema: nonEmpty.max(200),
      env: "BEACON_GEOCODE_USER_AGENT",
    },
    geocodeProvider: {
      // Not `nonEmpty`: `createGeocodeProvider` throws on anything it does not have a case for, and
      // it runs from an `app.module` factory, so an unknown value costs nothing at write time and
      // takes the server down at the *next* restart, possibly weeks later. Overrides are sticky, so
      // fixing the env var would not undo it either, and a server that will not boot cannot serve
      // the reset. The list lives beside the switch so the two cannot drift.
      schema: nonEmpty.refine((v) => (GEOCODE_PROVIDERS as readonly string[]).includes(v), {
        message: `unknown provider (expected ${GEOCODE_PROVIDERS.map((p) => `"${p}"`).join(" | ")})`,
      }),
      env: "BEACON_GEOCODE_PROVIDER",
    },
    geocodeEndpoint: {
      schema: httpUrl,
      env: "BEACON_GEOCODE_ENDPOINT",
    },
    geocodePrecision: {
      schema: z.number().int().min(1).max(12),
      env: "BEACON_GEOCODE_PRECISION",
    },
    geocodeTtlSeconds: {
      schema: positiveInt,
      env: "BEACON_GEOCODE_TTL",
    },
    geocodeNegativeTtlSeconds: {
      schema: positiveInt,
      env: "BEACON_GEOCODE_NEGATIVE_TTL",
    },
    geocodeMinIntervalMs: {
      schema: positiveInt,
      env: "BEACON_GEOCODE_MIN_INTERVAL_MS",
    },
    geocodeTimeoutMs: {
      schema: positiveInt,
      env: "BEACON_GEOCODE_TIMEOUT_MS",
    },
    placesQueryPageSize: {
      schema: positiveInt,
      env: "BEACON_PLACES_PAGE_SIZE",
    },
    placesQueryMaxCells: {
      // Capped, unlike the other budgets, because this one *is* the guard. `GET /places?cells=` is
      // an unauthenticated read and this is the only cap on it: unlike `/discovery`, the places read
      // does not also clamp against the shared MAX_QUERY_CELLS (places.controller.ts hands this
      // straight to `validatedCsvParam` as `max`). `loadConfig` defaults it *to* MAX_QUERY_CELLS, so
      // that is a ceiling the code already means, not a number invented here — and a typo of one
      // extra zero would otherwise turn the cell-enumeration guard off entirely.
      schema: positiveInt.max(MAX_QUERY_CELLS),
      env: "BEACON_PLACES_QUERY_MAX_CELLS",
    },
    placesTimeoutMs: {
      schema: positiveInt,
      env: "BEACON_PLACES_TIMEOUT_MS",
    },
    placesImageMaxBytes: {
      schema: positiveInt,
      env: "BEACON_PLACES_IMAGE_MAX_BYTES",
    },
    placesImageTimeoutMs: {
      schema: positiveInt,
      env: "BEACON_PLACES_IMAGE_TIMEOUT_MS",
    },
    placesImageMinIntervalMs: {
      schema: positiveInt,
      env: "BEACON_PLACES_IMAGE_MIN_INTERVAL_MS",
    },
    placesProposalRateMax: {
      schema: positiveInt,
      env: "BEACON_PLACES_PROPOSAL_RATE_LIMIT_MAX",
    },
    placesProposalRateWindowMs: {
      schema: positiveInt,
      env: "BEACON_PLACES_PROPOSAL_RATE_LIMIT_WINDOW_MS",
    },
    placesProposalMaxPending: {
      schema: positiveInt,
      env: "BEACON_PLACES_PROPOSAL_MAX_PENDING",
    },
  };

/**
 * The runtime slice of a parsed {@link ServerConfig}: the env-supplied defaults {@link
 * RuntimeSettings} starts from. Built by picking the registry's keys rather than by listing them a
 * second time, so it cannot drift from {@link RUNTIME_SETTING_KEYS}.
 */
export function runtimeSettingsFrom(config: ServerConfig): RuntimeSettings {
  const out: Partial<Record<RuntimeSettingKey, unknown>> = {};
  for (const key of RUNTIME_SETTING_KEYS) out[key] = config[key];
  return out as RuntimeSettings;
}

/**
 * The prerequisite couplings, declared once because two different mechanisms enforce them and a
 * second copy is how they would come apart.
 *
 * `loadConfig` enforces these *structurally*, not by checking: `placesEnabled && boolFromEnv(...)`
 * means an operator who sets only `BEACON_PLACES_PROPOSALS` simply gets `false`, and the
 * forbidden combination is unreachable by construction. Everything downstream was written knowing
 * that — `contributionsConfigFrom` fills the contributions gate from `placesContributionsEnabled`
 * alone, because nothing else was possible.
 *
 * An override store makes it possible again, because an admin writes one field at a time and a
 * restart re-reads an environment that may have moved underneath the rows. So the coupling is
 * enforced twice here, on purpose:
 *
 * - {@link validateRuntimeSettings} **refuses** the write. Used where an admin is present and can be
 *   told *why*, which is worth more than a value silently doing nothing.
 * - {@link reconcileRuntimeSettings} **coerces** the assembled view, exactly as `loadConfig` does.
 *   Used everywhere else, because a reset, a redeploy with a changed env var, a hand-edited table
 *   and two interleaved writes all have nobody to refuse to, and the value has to land *somewhere*
 *   defined. Coercing rather than deleting also keeps the operator's intent: the dependent goes
 *   dormant while its prerequisite is off and comes back as they set it, which is what the
 *   environment does with a variable that is still exported but not yet in effect.
 */
const CAPABILITY_PREREQUISITES = [
  {
    key: "placesContributionsEnabled",
    requires: "placesEnabled",
    what: "accepting player-submitted places",
  },
  {
    key: "placesContribExportEnabled",
    requires: "placesEnabled",
    what: "sharing approved contributions with a dataset builder",
  },
] as const satisfies readonly {
  key: RuntimeSettingKey;
  requires: RuntimeSettingKey;
  what: string;
}[];

/**
 * Refuse a combination `loadConfig` could not have produced, naming the field that is wrong.
 *
 * Throws a {@link z.ZodError} so a caller renders it the same way it renders a field-level refusal.
 * This is the courteous half; {@link reconcileRuntimeSettings} is the half that actually holds.
 */
export function validateRuntimeSettings(settings: RuntimeSettings): void {
  const issues: z.ZodIssue[] = [];

  for (const { key, requires, what } of CAPABILITY_PREREQUISITES) {
    if (settings[key] && !settings[requires]) {
      issues.push({
        code: z.ZodIssueCode.custom,
        path: [key],
        message: `${what} needs ${requires}; turn that capability on first`,
      });
    }
  }

  if (issues.length > 0) throw new z.ZodError(issues);
}

/**
 * The assembled view: the two rules a per-field schema cannot see, applied to the whole.
 *
 * **Prerequisites**, applied the way `loadConfig` applies them. This is the invariant rather than a
 * check: no sequence of admin writes, resets, restarts or hand-edits can make the server *serve* a
 * combination the environment path cannot reach, because the dependent is forced off at read time
 * rather than policed at write time. The override row is left alone — it is the admin's stated
 * intent, and it takes effect again the moment its prerequisite comes back on.
 *
 * **Boot-bounded ceilings**, for the one setting an admin can lower but not raise. Same shape and
 * the same reason: the row stands, the value in force is clamped, and `storedValue` reports the
 * difference, so `value` means "in force" everywhere rather than meaning it only sometimes.
 *
 * It returns **what it changed as well as the result**, because the two rules leave identical wire
 * shapes (`value` and `storedValue` differ) and completely different remedies: "turn the prerequisite
 * on" against "raise the environment variable and restart". Deriving the reason a second time at the
 * point of display would be a second copy of the rule, free to drift from this one, so the function
 * that applies a rule is the one that reports having applied it.
 */
export function reconcileRuntimeSettings(
  settings: RuntimeSettings,
  envDefaults: RuntimeSettings,
): ReconciledSettings {
  let out = settings;
  const adjusted: Partial<Record<RuntimeSettingKey, SettingAdjustment>> = {};

  for (const { key, requires } of CAPABILITY_PREREQUISITES) {
    if (out[key] && !out[requires]) {
      out = { ...out, [key]: false };
      adjusted[key] = "prerequisite";
    }
  }

  // `mediaMaxBytes` is bounded above by its own boot value. `main.ts` sizes the JSON body parser
  // from it via `jsonBodyLimit`, and body-parser resolves `limit` once at construction, so raising
  // the setting cannot raise the ceiling a request actually meets: the parser would refuse the
  // upload before `MediaService` could answer, from the wrong layer and with the wrong status.
  // Lowering works, and is honest. Applied here rather than in the view so that everything
  // downstream — including `SettingState.value` and therefore the admin console — agrees on one
  // number, the one in force. Removing this needs the body limit itself to become live
  // (`doc/spec/runtime-settings.md` §7).
  if (out.mediaMaxBytes > envDefaults.mediaMaxBytes) {
    out = { ...out, mediaMaxBytes: envDefaults.mediaMaxBytes };
    adjusted.mediaMaxBytes = "ceiling";
  }

  return { settings: out, adjusted };
}

/** True if `key` is a runtime setting (a narrowing guard for admin-op input, which is `string`). */
export function isRuntimeSettingKey(key: string): key is RuntimeSettingKey {
  return Object.hasOwn(SETTING_SPECS, key);
}

/** True if `key` is a deploy-time field, so a refusal can say *why* rather than "unknown setting". */
export function isDeployTimeKey(key: string): key is DeployTimeKey {
  return Object.hasOwn(DEPLOY_TIME_FIELDS, key);
}

/** True if `key` is computed from the others, so a refusal can point at the inputs instead. */
export function isDerivedKey(key: string): key is DerivedKey {
  return (DERIVED_KEYS as readonly string[]).includes(key);
}

/** True if `key` is a secret this build must never report by value ({@link SECRET_KEYS}). */
export function isSecretKey(key: string): boolean {
  return isDeployTimeKey(key) && DEPLOY_TIME_FIELDS[key].secret;
}

/**
 * Why each of these keys cannot be written, as issues an admin write can report beside its others.
 *
 * {@link z.ZodIssue} rather than a sentence, so a refusal has **one encoding**: a caller should not
 * have to test whether `message` parses as JSON to find out whether it got a per-field error list or
 * a prose paragraph, and a key refusal keeps the same `path: [key]` association a bad *value* gets.
 * That also lets one round trip report both kinds at once, which is the flow the multi-key op exists
 * to give an operator in the first place.
 *
 * Three different sentences on purpose: "you cannot change this here", "this is a consequence, not a
 * control" and "there is no such setting" send an operator to three different places.
 */
export function settingKeyIssues(keys: readonly string[]): z.ZodIssue[] {
  const issues: z.ZodIssue[] = [];
  for (const key of keys) {
    if (isRuntimeSettingKey(key)) continue;
    const message = isDeployTimeKey(key)
      ? `deploy-time: set ${DEPLOY_TIME_FIELDS[key].env} in the environment and restart`
      : isDerivedKey(key)
        ? "derived from the capability toggles; change those instead"
        : "not a setting";
    issues.push({ code: z.ZodIssueCode.custom, path: [key], message });
  }
  return issues;
}
