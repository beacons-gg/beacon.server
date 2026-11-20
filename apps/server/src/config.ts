/**
 * Env-driven server configuration: the store-selection knobs the factory reads, the identity and
 * operational surface (host, public URL, coverage, name, signing mnemonic, CORS/WS origins), and
 * the defaults of every runtime setting.
 */
import { acceptedMarkers } from "@beaconsgg/policy-engine";
import {
  ACCESS_MARKER,
  gameSlugSchema,
  MAX_GAME_SLUG_LEN,
  MAX_MAILBOX_BODY,
  serverAccessLevelSchema,
  type ServerAccessLevel,
} from "@beaconsgg/protocol-types";
import { MAX_QUERY_CELLS } from "./common/query";
import { csv, isOn } from "./common/env";

/** The longest `about` text a server keeps: a few screens of Markdown. */
export const MAX_ABOUT_LENGTH = 8192;

export interface ServerConfig {
  /** Listen port (1..65535). */
  port: number;
  /** Host used in minted `unique@host` room ids. */
  host: string;
  /** HTTP origin clients use for REST + the socket.io live channel. */
  publicUrl: string;
  /** Geohash coverage prefixes advertised in the descriptor (`[""]` = covers all cells). */
  coverage: string[];
  /** Display name in the descriptor. */
  name: string;
  /** Server software version advertised in the descriptor (default "0.0.1"). */
  version: string;
  /** Who may write — `open` | `request` | `private`; at the last two, members only (`MemberList`). */
  accessLevel: ServerAccessLevel;
  /** Optional operator blurb advertised in the descriptor (what this server is for). */
  description?: string | undefined;
  /** Optional operator contact (email / URL) advertised in the descriptor. */
  contact?: string | undefined;
  /**
   * The operator's long description of the server, Markdown, served at `GET /server/about` (never
   * signed into the descriptor, which stays small). Up to {@link MAX_ABOUT_LENGTH} characters.
   */
  about?: string | undefined;
  /** Optional BIP39 phrase to stabilize the server identity across restarts (env provider). */
  mnemonic?: string | undefined;
  /**
   * Selects the signing-key provider: `"env"` (BEACON_MNEMONIC, dev) | `"file"` (BEACON_KEY_FILE,
   * plaintext, self-hosted prod) | `"encrypted-file"` (BEACON_KEY_FILE + BEACON_KEY_PASSPHRASE,
   * encrypted at rest). Absent -> inferred: `encrypted-file` if a key file and passphrase are set,
   * `file` if only a key file, else `env`.
   */
  keyProvider?: string | undefined;
  /** Path to the key file (`file` = plaintext BIP39 `chmod 600`; `encrypted-file` = AES-GCM envelope). */
  keyFile?: string | undefined;
  /** Passphrase unlocking an encrypted key file (`encrypted-file` provider). */
  keyPassphrase?: string | undefined;
  /**
   * Allowed REST + WS origins (`BEACON_CORS_ORIGINS`). Empty = no cross-origin access; `*` = any
   * origin. Both the Express CORS layer and the socket.io gateway reject a request/handshake whose
   * `Origin` is not in the list.
   */
  corsOrigins: string[];
  /**
   * Express `trust proxy` — how many proxy hops to trust when deriving the client IP (used to key the
   * write rate limiter). `false` (default) trusts none and uses the direct socket peer. Set it to the
   * number of proxies in front (e.g. `1` behind a single load balancer) so `req.ip` is the real,
   * **non-spoofable** client — `true` (trust-all) makes `req.ip` the client-controlled leftmost
   * `X-Forwarded-For` and defeats the limiter, so it's opt-in only.
   */
  trustProxy: boolean | number;
  /**
   * Operator DIDs allowed on the **admin** surface (`BEACON_ADMINS`, csv of account did:key) —
   * `/admin/*` plus the places admin routes (`doc/spec/admin-api.md` §2). Admin actions spend
   * outbound fair-use budget and moderate custodied content, so the surface is signed +
   * allowlisted, never public, and never advertised in the descriptor. Empty (the default) means no
   * admin surface at all: the routes 404 as if absent.
   */
  admins: string[];
  /**
   * Game slugs this server admits (`BEACON_GAMES`, csv). **Empty (the default) means open to every
   * game**; a list admits only the listed ones. Either way a game write without a slug is refused:
   * that is the gate's rule, not a setting (`doc/spec/room-operation.md` §5). Entries are validated
   * against `gameSlugSchema` at boot, so a typo fails loudly rather than quietly admitting nothing.
   *
   * Advertised as `game:<slug>` capability markers so a client can learn a server is not for it
   * before it invests a session in one. Enforcement is the game gate's job; this slice only
   * declares and advertises.
   */
  games: string[];

  /**
   * What this server advertises in the signed descriptor: operator-enabled **service capabilities**
   * (e.g. `["mailbox"]`) plus **protocol markers** stating what this build understands. See
   * `serverDescriptorSchema.capabilities` for why the markers ride this list rather than a field of
   * their own.
   */
  capabilities: string[];
  /**
   * Whether the server is locked read-only (`BEACON_WRITE_LOCK`, default off): writes are refused
   * with a `503`, and background writers pause until it lifts (doc/deploy.md, "Read-only lock").
   */
  writeLocked: boolean;
  /** Mailbox capability enabled (`BEACON_MAILBOX`); when off, the mailbox routes 404. */
  mailboxEnabled: boolean;
  /** Server-decided message TTL, seconds (`BEACON_MAILBOX_TTL`, default 7d) — senders can't set it. */
  mailboxTtlSeconds: number;
  /**
   * Max message body bytes (`BEACON_MAILBOX_MAX_BODY`, default 256, template-sized; `413` over). At
   * most the wire cap, `MAX_MAILBOX_BODY` (4096 bytes): a larger value fails boot.
   */
  mailboxMaxBody: number;
  /** Per-DID send budget: max sends per window (`BEACON_MAILBOX_RATE_LIMIT_MAX`, default 60). */
  mailboxSendMax: number;
  /** Per-DID send window, ms (`BEACON_MAILBOX_RATE_LIMIT_WINDOW_MS`, default 60000). */
  mailboxSendWindowMs: number;

  /** Media capability enabled (`BEACON_MEDIA`); when off, the media routes 404. */
  mediaEnabled: boolean;
  /** Blob backend: `fs` | `s3` (`BEACON_MEDIA_BACKEND`); any other value stops the server at boot. */
  mediaBackend: MediaBackend;
  /** fs-backend blob directory (`BEACON_MEDIA_DIR`, default "beacon-media"). */
  mediaDir: string;
  /** Per-object size cap, bytes (`BEACON_MEDIA_MAX_BYTES`, default 5 MiB; `413` over). */
  mediaMaxBytes: number;
  /**
   * Allowed MIME types (`BEACON_MEDIA_TYPES`, csv). NOTE: server-side metadata scrubbing covers
   * **images only** — a non-image type here (e.g. `audio/mpeg`) is stored as-is and relies on the
   * client to strip metadata before upload (`doc/spec/mailbox-and-media.md` §5.5, narrowed privacy
   * claim).
   */
  mediaTypes: string[];
  /** Per-DID total storage quota, bytes (`BEACON_MEDIA_QUOTA_BYTES`, default 50 MiB; `413` over). */
  mediaQuotaBytes: number;
  /**
   * The most media the server holds in total, bytes (`BEACON_MEDIA_LIMIT_BYTES`; unset is no limit).
   * Every uploader and every server-side import together, so it is what bounds the bucket, where the
   * per-DID quota only bounds one uploader. Set by whoever hosts the server and deploy-time: an
   * admin op cannot raise it. An upload over it is a `413`; an import stops and counts what it left out.
   */
  mediaLimitBytes?: number;
  /**
   * The most data a restore may load into the database, uncompressed bytes
   * (`BEACON_RESTORE_DATABASE_LIMIT_BYTES`; unset is no limit). Counted as it loads, since a backup
   * can claim anything. Set by whoever hosts the server, and deploy-time for the same reason.
   */
  restoreDatabaseLimitBytes?: number;
  /** Per-DID upload budget: max uploads per window (`BEACON_MEDIA_RATE_LIMIT_MAX`, default 60). */
  mediaRateMax: number;
  /** Per-DID upload window, ms (`BEACON_MEDIA_RATE_LIMIT_WINDOW_MS`, default 60000). */
  mediaRateWindowMs: number;
  /** S3-compatible endpoint for the `s3` backend — Cloudflare R2 / DigitalOcean Spaces / AWS (`BEACON_MEDIA_S3_ENDPOINT`). */
  mediaS3Endpoint?: string;
  /** S3 region (`BEACON_MEDIA_S3_REGION`, default "auto" — R2's value; DO uses e.g. "us-east-1"). */
  mediaS3Region: string;
  /** S3 bucket (`BEACON_MEDIA_S3_BUCKET`). */
  mediaS3Bucket?: string;
  /** S3 access key id (`BEACON_MEDIA_S3_ACCESS_KEY_ID`). */
  mediaS3AccessKeyId?: string;
  /** S3 secret access key (`BEACON_MEDIA_S3_SECRET_ACCESS_KEY`). */
  mediaS3SecretAccessKey?: string;
  /** Force path-style S3 addressing (`BEACON_MEDIA_S3_FORCE_PATH_STYLE`; some DO/MinIO setups need it). */
  mediaS3ForcePathStyle: boolean;
  /** Optional key prefix within the bucket (`BEACON_MEDIA_S3_PREFIX`). */
  mediaS3Prefix: string;
  /** Public CDN base URL (`BEACON_MEDIA_CDN_URL`); set ⇒ media fetches redirect here (bytes off the app). */
  mediaCdnUrl?: string;

  /**
   * Identifying `User-Agent` for the server's outbound geo calls (Nominatim fair-use requires one;
   * volume/media fetches identify too). `BEACON_GEOCODE_USER_AGENT`; default derives from the version +
   * operator contact/host.
   */
  geoUserAgent: string;

  /** Geocode capability enabled (`BEACON_GEOCODE`); when off, `/geocode` 404s. */
  geocodeEnabled: boolean;
  /** Reverse-geocode provider (`BEACON_GEOCODE_PROVIDER`, default "nominatim"). */
  geocodeProvider: string;
  /** Provider base URL (`BEACON_GEOCODE_ENDPOINT`, default the public Nominatim). */
  geocodeEndpoint: string;
  /** Geohash precision the geohash is coarsened to for the cache key (`BEACON_GEOCODE_PRECISION`, 7). */
  geocodePrecision: number;
  /** Positive-result cache TTL, seconds (`BEACON_GEOCODE_TTL`, default 30d — boundaries are stable). */
  geocodeTtlSeconds: number;
  /** Negative-result (no label) cache TTL, seconds (`BEACON_GEOCODE_NEGATIVE_TTL`, default 1d). */
  geocodeNegativeTtlSeconds: number;
  /** Minimum spacing between outbound geocode calls, ms (`BEACON_GEOCODE_MIN_INTERVAL_MS`, default 1000 — Nominatim ~1 req/s). */
  geocodeMinIntervalMs: number;
  /** Per-request timeout for a geocode call, ms (`BEACON_GEOCODE_TIMEOUT_MS`, default 8000). */
  geocodeTimeoutMs: number;

  /** Places capability enabled (`BEACON_PLACES`); when off, `/places` 404s. */
  placesEnabled: boolean;
  /**
   * Where uploaded Atlas archives are staged (`BEACON_ATLAS_STAGING_DIR`, default the OS temp dir),
   * always in a `beacon-atlas-staging/` subdirectory the server owns. Transient by design (the boot
   * sweep deletes that subdirectory and nothing else), but the *capacity* matters: a large archive
   * plus its extracted tree coexist briefly, and a hardened deploy with a small tmpfs `/tmp` would
   * turn an upload into an out-of-space failure. Point this at real disk in that shape.
   */
  atlasStagingDir?: string | undefined;
  /**
   * A host-mounted directory of Atlas volume trees (`BEACON_ATLAS_VOLUMES_DIR`). Set, it enables
   * `path` on `places.atlas.inspect`/`import`: the op names a directory under it (`.` for the dir
   * itself), read as the tree verbatim — the fast local alternative to fetching a hosted volume
   * tile by tile over HTTP. Unset ⇒ path ops are refused; the op can never name a path outside it.
   */
  atlasVolumesDir?: string | undefined;
  /**
   * Max + default places per read-query page (`BEACON_PLACES_PAGE_SIZE`, default 1000). The read
   * path is keyset-paginated: a full page returns a `cursor` to fetch the next.
   */
  placesQueryPageSize: number;
  /** Per-query `cells` cap (`BEACON_PLACES_QUERY_MAX_CELLS`; defaults to the shared MAX_QUERY_CELLS). */
  placesQueryMaxCells: number;
  /** Per-request timeout for an outbound volume fetch, ms (`BEACON_PLACES_TIMEOUT_MS`, default 25000). */
  placesTimeoutMs: number;
  /** Import-media download size cap, bytes (`BEACON_PLACES_IMAGE_MAX_BYTES`, default 10 MiB). */
  placesImageMaxBytes: number;
  /** Per-request timeout for an import-media fetch, ms (`BEACON_PLACES_IMAGE_TIMEOUT_MS`, default 15000). */
  placesImageTimeoutMs: number;
  /** Min spacing between paced import-media fetches, ms (`BEACON_PLACES_IMAGE_MIN_INTERVAL_MS`, default 250). */
  placesImageMinIntervalMs: number;
  /**
   * `place_cells` index precision (`BEACON_PLACES_CELL_PRECISION`, default 6).
   *
   * **Deploy-time, and deliberately not an operator knob** (`doc/spec/runtime-settings.md` §3.4).
   * It reads like a tuning preference and is actually a data-shape decision: `cellsForPlace()`
   * writes the `place_cells` rows at this precision on every commit, and reads coarsen incoming
   * cells to the same number. Changing it on a live dataset does not re-tune anything — it silently
   * returns fewer places, because the rows already written are indexed at the old precision. Moving
   * it is a reindex, not a setting, so it stays in `DEPLOY_TIME_KEYS` where nobody can edit it by
   * accident.
   */
  placesCellPrecision: number;
  /**
   * Accept **player-submitted** places (`BEACON_PLACES_PROPOSALS`, off by default): opt-in on top
   * of `BEACON_PLACES`, and advertised separately as the `places-proposals` capability so a game
   * can tell whether to show a "add this place" affordance. Nothing submitted is ever published
   * without an operator's approval; turning this off closes new submissions but leaves the existing
   * review queue reachable, so a backlog is never stranded (`doc/spec/place-proposals.md` §8).
   */
  placesContributionsEnabled: boolean;
  /**
   * Share approved player contributions with a dataset builder (`BEACON_PLACES_PROPOSALS_EXPORT`,
   * off by default) — the export half of the contribution round-trip
   * (`apps/atlas/doc/spec/beacon-integration.md` §9).
   *
   * Separate from {@link placesContributionsEnabled} and deliberately so: accepting submissions is
   * a decision about this server, and sending them onward is a decision about somebody else's
   * dataset. This is the one direction in the architecture where player-derived data flows toward a
   * central party, so it is never implied by anything else.
   */
  placesContribExportEnabled: boolean;
  /** Per-DID submission budget (`BEACON_PLACES_PROPOSAL_RATE_LIMIT_MAX`, default 20 per window). */
  placesProposalRateMax: number;
  /** The submission-budget window, ms (`BEACON_PLACES_PROPOSAL_RATE_LIMIT_WINDOW_MS`, default 24h). */
  placesProposalRateWindowMs: number;
  /** Per-DID cap on *unreviewed* submissions (`BEACON_PLACES_PROPOSAL_MAX_PENDING`, default 10) — bounds queue flooding independently of the rate. */
  placesProposalMaxPending: number;

  /** Serve the OpenAPI spec + Swagger UI (`BEACON_DOCS`); off by default (a public server may not want to advertise its surface). */
  docsEnabled: boolean;
  /** Docs mount path (`BEACON_DOCS_PATH`, default "docs" → GET /docs UI + GET /docs/openapi.json). */
  docsPath: string;

  /**
   * The home page at `GET /` for a browser (`BEACON_HOME`, on unless `off`): what this server is, its
   * address as text and a QR code, its coverage on a map. Read from the signed descriptor's facts, so
   * it says nothing a client cannot already learn.
   */
  homeEnabled: boolean;
  /**
   * The operator console the home page links to, with this server's address to add
   * (`BEACON_HOME_CONSOLE_URL`, default the hosted one; `off` for no link).
   */
  homeConsoleUrl: string | undefined;
  /**
   * The network's site (`BEACON_HOME_SITE_URL`, default beacons.gg; `off` for none): the home page's
   * footer says the server is part of the Beacon Server Network and links it, and its header links
   * the site's guide to Beacon servers, `<site>/docs`.
   */
  homeSiteUrl: string | undefined;
  /**
   * The raster tiles the home page's coverage map draws on, an `{z}/{x}/{y}` URL template
   * (`BEACON_HOME_MAP_TILES`, default OpenStreetMap's; `off` for no map). Loaded by the visitor's
   * browser, never by the server: the one thing the page fetches from elsewhere.
   */
  homeMapTiles: string | undefined;
  /**
   * The home page's room counts, how many the server holds and how many changed in the last 30 days
   * (`BEACON_HOME_STATS`): `auto`, the default, shows them on an open server and hides them on a
   * `request` or `private` one, whose activity is its operator's to share; `on` and `off` decide.
   */
  homeStats: "auto" | "on" | "off";
  /**
   * Where this server's source code is (`BEACON_SOURCE_URL`, an https URL; default
   * {@link DEFAULT_SOURCE_URL}, the public repository). The server is AGPLv3, and §13 asks a
   * modified server to offer its source to everyone who uses it over the network: the home page's
   * footer links here. An operator who runs a modified build must set it to that build's code.
   */
  sourceUrl: string | undefined;

  /** Postgres connection string (`BEACON_DATABASE_URL`). Required: there is no other backend. */
  databaseUrl: string;
  /** Postgres pool size (max connections). */
  pgPoolSize: number;
  /** FIFO cap on the nonce idempotency log. */
  maxNonces: number;
  /**
   * How long a booting server waits for another one on the same database to let go of the writer
   * lock before refusing to start (`BEACON_WRITER_LOCK_WAIT_MS`, default 30s): the window a redeploy
   * needs to stop the old process. 0 refuses at once.
   */
  writerLockWaitMs: number;
  /**
   * Whether a backup or restore may use an S3 endpoint on a private network. On by default for
   * self-hosters with MinIO on a LAN; a hoster turns it off so a server's admin cannot aim a job at
   * internal addresses. `BEACON_BACKUP_PRIVATE_ENDPOINTS`, deploy-time.
   */
  backupPrivateEndpoints: boolean;
}

const DEFAULT_PG_POOL_SIZE = 10;
const DEFAULT_MAX_NONCES = 50_000;
const DEFAULT_WRITER_LOCK_WAIT_MS = 30_000;
const DEFAULT_PORT = 3001;

// The host charset must match GlobalId's `@host` class, or minted room ids fail `globalIdSchema`
// when clients send them back (every op then 400s — hard to diagnose).
export const HOST_RE = /^[A-Za-z0-9.:-]+$/;

/**
 * Setting names 0.3 retired, each with the name that replaced it. There are no aliases: a server
 * that silently ignored an old name would run with a default the operator never chose, so
 * {@link loadConfig} refuses to start while one is set.
 */
export const RETIRED_SETTINGS: Readonly<Record<string, string>> = Object.freeze({
  BEACON_RATE_LIMIT_MAX: "BEACON_WRITE_RATE_LIMIT_MAX",
  BEACON_RATE_LIMIT_WINDOW_MS: "BEACON_WRITE_RATE_LIMIT_WINDOW_MS",
  BEACON_RATE_LIMIT_DEBUG: "BEACON_WRITE_RATE_LIMIT_DEBUG",
  BEACON_READ_RATE_LIMIT_MAX: "BEACON_PLACES_READ_RATE_LIMIT_MAX",
  BEACON_READ_RATE_LIMIT_WINDOW_MS: "BEACON_PLACES_READ_RATE_LIMIT_WINDOW_MS",
  BEACON_MAILBOX_RATE_MAX: "BEACON_MAILBOX_RATE_LIMIT_MAX",
  BEACON_MAILBOX_RATE_WINDOW_MS: "BEACON_MAILBOX_RATE_LIMIT_WINDOW_MS",
  BEACON_MEDIA_RATE_MAX: "BEACON_MEDIA_RATE_LIMIT_MAX",
  BEACON_MEDIA_RATE_WINDOW_MS: "BEACON_MEDIA_RATE_LIMIT_WINDOW_MS",
  BEACON_PLACES_PROPOSAL_RATE: "BEACON_PLACES_PROPOSAL_RATE_LIMIT_MAX",
  BEACON_PLACES_PROPOSAL_RATE_WINDOW_MS: "BEACON_PLACES_PROPOSAL_RATE_LIMIT_WINDOW_MS",
  BEACON_GEO_USER_AGENT: "BEACON_GEOCODE_USER_AGENT",
  BEACON_PLACES_CONTRIBUTIONS: "BEACON_PLACES_PROPOSALS",
  BEACON_PLACES_CONTRIB_EXPORT: "BEACON_PLACES_PROPOSALS_EXPORT",
  BEACON_BLACKLIST: "BEACON_BLOCKLIST",
});

/**
 * Throw, naming the replacement of each, when the environment sets a retired setting name
 * ({@link RETIRED_SETTINGS}). An empty value is not a setting: it changes nothing either way.
 */
export function refuseRetiredSettings(env: NodeJS.ProcessEnv): void {
  const set = Object.entries(RETIRED_SETTINGS).filter(([old]) => env[old]?.trim());
  if (set.length === 0) return;
  throw new Error(
    `Retired setting names are set: ${set.map(([old, now]) => `${old} is now ${now}`).join("; ")}. ` +
      "Rename them and start the server again.",
  );
}

/**
 * A comma-separated list for a setting that reads empty as every value (coverage, games), where `*`
 * says every value explicitly: `*` anywhere gives the empty list. CORS does not read empty that way.
 */
function csvOrAll(value: string | undefined): string[] {
  const list = csv(value);
  return list.includes("*") ? [] : list;
}

/**
 * The `cors` origin option for `BEACON_CORS_ORIGINS`, for REST and the socket.io handshake alike:
 * `*` admits any origin, an empty list admits no cross-origin request, and a list admits those.
 */
export function corsOriginOption(origins: readonly string[]): boolean | string[] {
  if (origins.includes("*")) return true;
  return origins.length === 0 ? false : [...origins];
}

/** A whole number from the env, at least `min` (1 unless a key says 0 is a real answer); else the fallback. */
function intFromEnv(env: NodeJS.ProcessEnv, key: string, fallback: number, min = 1): number {
  const raw = env[key];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= min ? Math.floor(n) : fallback;
}

/**
 * An optional byte limit: unset or empty is none; anything else must be a whole number of bytes, and
 * a malformed one fails boot. Falling back, as {@link intFromEnv} does, would turn a typo into a
 * server with no limit at all.
 */
function bytesLimitFromEnv(env: NodeJS.ProcessEnv, key: string): number | undefined {
  const raw = env[key]?.trim();
  if (raw === undefined || raw === "") return undefined;
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw))) {
    throw new Error(`Invalid ${key}: ${JSON.stringify(raw)} (a whole number of bytes, or unset)`);
  }
  return Number(raw);
}

/**
 * Parse `BEACON_TRUST_PROXY` into an Express `trust proxy` value. A positive integer = that many
 * trusted hops (the safe, non-spoofable choice behind N proxies); `"true"` = trust all (spoofable —
 * discouraged, explicit opt-in only); unset / anything else = `false` (trust none, use the socket peer).
 */
/** A switch that is on unless set off (`off`, `false`, `0`, `no`): for features a server has by default. */
function onUnlessOff(raw: string | undefined): boolean {
  const v = raw?.trim().toLowerCase();
  return !(v === "0" || v === "false" || v === "no" || v === "off");
}

/**
 * An http(s) URL the home page links to or loads, with a default, or none when set `off` (or empty).
 * A value that is not one stops the boot: a broken link on every server's front page is worse than a
 * refusal the operator sees at once.
 */
function homeUrlFromEnv(env: NodeJS.ProcessEnv, key: string, fallback: string): string | undefined {
  const raw = env[key];
  if (raw === undefined) return fallback;
  const v = raw.trim();
  if (v === "" || v.toLowerCase() === "off") return undefined;
  let url: URL;
  try {
    url = new URL(v.replaceAll("{z}", "0").replaceAll("{x}", "0").replaceAll("{y}", "0"));
  } catch {
    throw new Error(`Invalid ${key}: ${JSON.stringify(v)} (an http(s) URL, or off)`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(`Invalid ${key}: ${JSON.stringify(v)} (an http(s) URL, or off)`);
  }
  return v.replace(/\/+$/, "");
}

/** The repository a server links as its source unless `BEACON_SOURCE_URL` names another. */
export const DEFAULT_SOURCE_URL = "https://github.com/beacons-gg/beacon.server";

/** `BEACON_SOURCE_URL`: an https URL, or none when unset or empty. Anything else stops the boot. */
function sourceUrlFromEnv(raw: string | undefined): string | undefined {
  const v = raw?.trim();
  if (!v) return undefined;
  if (!URL.canParse(v) || new URL(v).protocol !== "https:") {
    throw new Error(`Invalid BEACON_SOURCE_URL: ${JSON.stringify(v)} (an https URL, or unset)`);
  }
  return v.replace(/\/+$/, "");
}

function homeStatsFromEnv(raw: string | undefined): "auto" | "on" | "off" {
  const v = raw?.trim().toLowerCase();
  if (v === undefined || v === "" || v === "auto") return "auto";
  return onUnlessOff(v) ? "on" : "off";
}

/** The tile template the home page's map uses unless told otherwise. */
export const DEFAULT_HOME_MAP_TILES = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";

function parseTrustProxy(raw: string | undefined): boolean | number {
  const v = raw?.trim().toLowerCase();
  if (v === undefined || v === "" || v === "false" || v === "0") return false;
  if (v === "true") return true;
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : false;
}

export type MediaBackend = "fs" | "s3";

/**
 * `BEACON_MEDIA_BACKEND`, or a refusal to start. A typo such as `S3` or `s3 ` used to fall through
 * to the disk backend, so a server meant to store media in a bucket filled its own disk instead.
 */
function mediaBackendFrom(raw: string | undefined): MediaBackend {
  const value = raw?.trim() || "fs";
  if (value === "fs" || value === "s3") return value;
  throw new Error(`Invalid BEACON_MEDIA_BACKEND: ${JSON.stringify(raw)} (must be fs | s3)`);
}

/**
 * Why the server will not start without `BEACON_DATABASE_URL`, and what to set. SQLite and the
 * in-memory store were removed, so an operator still following an old `.env` with `BEACON_DB_PATH`
 * is told that variable is no longer read, rather than left to guess.
 */
function missingDatabaseUrl(dbPath: string | undefined): string {
  const removed = dbPath
    ? `SQLite and the in-memory store were removed, so BEACON_DB_PATH (${JSON.stringify(dbPath)}) is no longer read.`
    : "SQLite and the in-memory store were removed.";
  return (
    "BEACON_DATABASE_URL is not set. The Beacon server requires Postgres: set " +
    "BEACON_DATABASE_URL=postgres://user:password@host:5432/db (see doc/deploy.md). " +
    removed
  );
}

/**
 * Read {@link ServerConfig} from the environment (defaults to `process.env`).
 *
 * - `PORT` (default 3001, must be an integer 1..65535).
 * - `BEACON_HOST` (default `localhost:$PORT`; must match the GlobalId host class).
 * - `BEACON_PUBLIC_URL` (default `http://localhost:$PORT`).
 * - `BEACON_COVERAGE` (comma-separated geohash prefixes; empty or `*` -> `[""]` = all cells).
 * - `BEACON_NAME` (default "Beacon Dev Server").
 * - `BEACON_VERSION` (default "0.0.1") — server software version in the descriptor. -
 *   `BEACON_ACCESS_LEVEL` (`open` | `request` | `private`, default "open"; who may write).
 * - `BEACON_DESCRIPTION` (optional operator blurb, ≤280 chars).
 * - `BEACON_CONTACT` (optional operator contact — email / URL, ≤200 chars).
 * - `BEACON_MNEMONIC` (optional BIP39 phrase to stabilize server identity; env provider).
 * - `BEACON_KEY_PROVIDER` (`env` | `file` | `encrypted-file`; absent -> inferred).
 * - `BEACON_KEY_FILE` (key-file path; plaintext `chmod 600` for `file`, AES-GCM envelope for
 *   `encrypted-file`).
 * - `BEACON_KEY_PASSPHRASE` (unlocks an `encrypted-file` key file).
 * - `BEACON_CORS_ORIGINS` (comma-separated origins; `*` -> any origin; empty -> no cross-origin
 *   access).
 * - `BEACON_ADMINS` (comma-separated operator did:keys; empty -> the admin surface 404s).
 * - `BEACON_GAMES` (comma-separated game slugs this server admits; empty or `*` -> open to all
 *   games).
 * - `BEACON_DATABASE_URL` (**required**: the Postgres every store runs on; absent or empty throws,
 *   see {@link missingDatabaseUrl}).
 * - `BEACON_PG_POOL_SIZE` (default 10), `BEACON_MAX_NONCES` (default 50k).
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  // First, and over the same environment the guards and gateways read directly: boot runs this
  // before any of them is built, so a retired name stops the server whichever code reads it.
  refuseRetiredSettings(env);
  const port = Number(env["PORT"] ?? DEFAULT_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid PORT: ${env["PORT"]} (must be an integer 1..65535)`);
  }
  const host = env["BEACON_HOST"] ?? `localhost:${port}`;
  if (!HOST_RE.test(host)) {
    throw new Error(`Invalid BEACON_HOST: ${JSON.stringify(host)} (must match ${HOST_RE})`);
  }
  const coverage = csvOrAll(env["BEACON_COVERAGE"]);

  const accessLevel = serverAccessLevelSchema.safeParse(env["BEACON_ACCESS_LEVEL"] ?? "open");
  if (!accessLevel.success) {
    throw new Error(
      `Invalid BEACON_ACCESS_LEVEL: ${JSON.stringify(env["BEACON_ACCESS_LEVEL"])} (must be open | request | private)`,
    );
  }

  const mailboxEnabled = isOn(env["BEACON_MAILBOX"]);
  const mediaEnabled = isOn(env["BEACON_MEDIA"]);
  const geocodeEnabled = isOn(env["BEACON_GEOCODE"]);
  const placesEnabled = isOn(env["BEACON_PLACES"]);
  // Accepting player submissions is opt-in on top of the places capability, and meaningless
  // without it — an operator who sets only this one gets no contribution surface.
  const contributionsEnabled = placesEnabled && isOn(env["BEACON_PLACES_PROPOSALS"]);
  // Sharing contributions onward needs the dataset to exist, but NOT open submissions: an operator
  // may close new submissions and still owe the builder the backlog they already approved.
  const contribExportEnabled = placesEnabled && isOn(env["BEACON_PLACES_PROPOSALS_EXPORT"]);
  const admins = csv(env["BEACON_ADMINS"]);
  const games = csvOrAll(env["BEACON_GAMES"]);
  for (const slug of games) {
    if (!gameSlugSchema.safeParse(slug).success) {
      throw new Error(
        `Invalid BEACON_GAMES entry: ${JSON.stringify(slug)} (lowercase, <=${MAX_GAME_SLUG_LEN} chars, starting alphanumeric, from [a-z0-9._/-])`,
      );
    }
  }
  const mediaTypes = csv(env["BEACON_MEDIA_TYPES"]);

  // Hoisted so the geo User-Agent default can reference them without re-parsing the same env vars.
  const version = env["BEACON_VERSION"]?.trim() || "0.0.1";
  const contact = env["BEACON_CONTACT"]?.trim();

  const databaseUrl = env["BEACON_DATABASE_URL"];
  if (databaseUrl === undefined || databaseUrl === "") {
    throw new Error(missingDatabaseUrl(env["BEACON_DB_PATH"]));
  }
  // A limit above the wire's own could never apply; the admin write is capped the same way.
  const mailboxMaxBody = intFromEnv(env, "BEACON_MAILBOX_MAX_BODY", 256);
  if (mailboxMaxBody > MAX_MAILBOX_BODY) {
    throw new Error(
      `Invalid BEACON_MAILBOX_MAX_BODY: ${mailboxMaxBody} (at most ${MAX_MAILBOX_BODY} bytes, the wire cap)`,
    );
  }
  const config: ServerConfig = {
    port,
    host,
    publicUrl: env["BEACON_PUBLIC_URL"] ?? `http://localhost:${port}`,
    coverage: coverage.length > 0 ? coverage : [""], // [""] covers all cells (dev)
    name: env["BEACON_NAME"] ?? "Beacon Dev Server",
    version,
    accessLevel: accessLevel.data,
    mnemonic: env["BEACON_MNEMONIC"],
    keyProvider: env["BEACON_KEY_PROVIDER"],
    keyFile: env["BEACON_KEY_FILE"],
    keyPassphrase: env["BEACON_KEY_PASSPHRASE"],
    corsOrigins: csv(env["BEACON_CORS_ORIGINS"]),
    trustProxy: parseTrustProxy(env["BEACON_TRUST_PROXY"]),
    admins,
    games,
    // Derived here from the same function the live view calls per read (settings/live-config.ts),
    // so boot and runtime cannot disagree about what this server advertises. Every input is a local
    // above, so it needs no placeholder and no second pass over a finished object.
    capabilities: deriveCapabilities({
      mailboxEnabled,
      mediaEnabled,
      geocodeEnabled,
      placesEnabled,
      placesContributionsEnabled: contributionsEnabled,
      games,
    }),
    writeLocked: isOn(env["BEACON_WRITE_LOCK"]),
    mailboxEnabled,
    mailboxTtlSeconds: intFromEnv(env, "BEACON_MAILBOX_TTL", 7 * 24 * 60 * 60),
    mailboxMaxBody,
    mailboxSendMax: intFromEnv(env, "BEACON_MAILBOX_RATE_LIMIT_MAX", 60),
    mailboxSendWindowMs: intFromEnv(env, "BEACON_MAILBOX_RATE_LIMIT_WINDOW_MS", 60_000),
    mediaEnabled,
    mediaBackend: mediaBackendFrom(env["BEACON_MEDIA_BACKEND"]),
    mediaDir: env["BEACON_MEDIA_DIR"]?.trim() || "beacon-media",
    mediaMaxBytes: intFromEnv(env, "BEACON_MEDIA_MAX_BYTES", 5 * 1024 * 1024),
    mediaTypes:
      mediaTypes.length > 0 ? mediaTypes : ["image/jpeg", "image/png", "image/webp", "audio/mpeg"],
    mediaQuotaBytes: intFromEnv(env, "BEACON_MEDIA_QUOTA_BYTES", 50 * 1024 * 1024),
    mediaRateMax: intFromEnv(env, "BEACON_MEDIA_RATE_LIMIT_MAX", 60),
    mediaRateWindowMs: intFromEnv(env, "BEACON_MEDIA_RATE_LIMIT_WINDOW_MS", 60_000),
    mediaS3Region: env["BEACON_MEDIA_S3_REGION"]?.trim() || "auto",
    mediaS3ForcePathStyle: isOn(env["BEACON_MEDIA_S3_FORCE_PATH_STYLE"]),
    mediaS3Prefix: env["BEACON_MEDIA_S3_PREFIX"]?.trim() || "",
    geoUserAgent:
      env["BEACON_GEOCODE_USER_AGENT"]?.trim() || `beacon-server/${version} (${contact || host})`,
    geocodeEnabled,
    geocodeProvider: env["BEACON_GEOCODE_PROVIDER"]?.trim() || "nominatim",
    geocodeEndpoint:
      env["BEACON_GEOCODE_ENDPOINT"]?.trim().replace(/\/+$/, "") ||
      "https://nominatim.openstreetmap.org",
    geocodePrecision: intFromEnv(env, "BEACON_GEOCODE_PRECISION", 7),
    geocodeTtlSeconds: intFromEnv(env, "BEACON_GEOCODE_TTL", 30 * 24 * 60 * 60),
    geocodeNegativeTtlSeconds: intFromEnv(env, "BEACON_GEOCODE_NEGATIVE_TTL", 24 * 60 * 60),
    geocodeMinIntervalMs: intFromEnv(env, "BEACON_GEOCODE_MIN_INTERVAL_MS", 1000),
    geocodeTimeoutMs: intFromEnv(env, "BEACON_GEOCODE_TIMEOUT_MS", 8000),
    placesEnabled,
    atlasStagingDir: env["BEACON_ATLAS_STAGING_DIR"] || undefined,
    atlasVolumesDir: env["BEACON_ATLAS_VOLUMES_DIR"] || undefined,
    placesQueryPageSize: intFromEnv(env, "BEACON_PLACES_PAGE_SIZE", 1000),
    placesQueryMaxCells: intFromEnv(env, "BEACON_PLACES_QUERY_MAX_CELLS", MAX_QUERY_CELLS),
    placesTimeoutMs: intFromEnv(env, "BEACON_PLACES_TIMEOUT_MS", 25000),
    placesImageMaxBytes: intFromEnv(env, "BEACON_PLACES_IMAGE_MAX_BYTES", 10 * 1024 * 1024),
    placesImageTimeoutMs: intFromEnv(env, "BEACON_PLACES_IMAGE_TIMEOUT_MS", 15000),
    placesImageMinIntervalMs: intFromEnv(env, "BEACON_PLACES_IMAGE_MIN_INTERVAL_MS", 250),
    placesCellPrecision: intFromEnv(env, "BEACON_PLACES_CELL_PRECISION", 6),
    placesContributionsEnabled: contributionsEnabled,
    placesContribExportEnabled: contribExportEnabled,
    placesProposalRateMax: intFromEnv(env, "BEACON_PLACES_PROPOSAL_RATE_LIMIT_MAX", 20),
    placesProposalRateWindowMs: intFromEnv(
      env,
      "BEACON_PLACES_PROPOSAL_RATE_LIMIT_WINDOW_MS",
      24 * 60 * 60_000,
    ),
    placesProposalMaxPending: intFromEnv(env, "BEACON_PLACES_PROPOSAL_MAX_PENDING", 10),
    docsEnabled: isOn(env["BEACON_DOCS"]),
    docsPath: env["BEACON_DOCS_PATH"]?.trim().replace(/^\/+|\/+$/g, "") || "docs",
    homeEnabled: onUnlessOff(env["BEACON_HOME"]),
    homeConsoleUrl: homeUrlFromEnv(env, "BEACON_HOME_CONSOLE_URL", "https://console.beacons.gg"),
    homeSiteUrl: homeUrlFromEnv(env, "BEACON_HOME_SITE_URL", "https://beacons.gg"),
    homeMapTiles: homeUrlFromEnv(env, "BEACON_HOME_MAP_TILES", DEFAULT_HOME_MAP_TILES),
    homeStats: homeStatsFromEnv(env["BEACON_HOME_STATS"]),
    sourceUrl: sourceUrlFromEnv(env["BEACON_SOURCE_URL"]) ?? DEFAULT_SOURCE_URL,
    databaseUrl,
    pgPoolSize: intFromEnv(env, "BEACON_PG_POOL_SIZE", DEFAULT_PG_POOL_SIZE),
    maxNonces: intFromEnv(env, "BEACON_MAX_NONCES", DEFAULT_MAX_NONCES),
    // 0 is a real answer here: refuse at once rather than wait.
    writerLockWaitMs: intFromEnv(env, "BEACON_WRITER_LOCK_WAIT_MS", DEFAULT_WRITER_LOCK_WAIT_MS, 0),
    backupPrivateEndpoints: onUnlessOff(env["BEACON_BACKUP_PRIVATE_ENDPOINTS"]),
  };
  // Only set the optional keys when actually present (exactOptionalPropertyTypes is on).
  const description = env["BEACON_DESCRIPTION"]?.trim();
  if (description) config.description = description;
  if (contact) config.contact = contact; // `contact` hoisted above (shared with geoUserAgent)
  // Kept as written, trailing newline aside: Markdown is whitespace-sensitive. Checked here because
  // the admin write checks it and an env value has nobody watching but the boot log.
  const about = env["BEACON_ABOUT"]?.replace(/\s+$/, "");
  if (about && about.length > MAX_ABOUT_LENGTH) {
    throw new Error(
      `Invalid BEACON_ABOUT: ${about.length} characters (at most ${MAX_ABOUT_LENGTH})`,
    );
  }
  if (about) config.about = about;
  const s3Endpoint = env["BEACON_MEDIA_S3_ENDPOINT"]?.trim();
  if (s3Endpoint) config.mediaS3Endpoint = s3Endpoint;
  const s3Bucket = env["BEACON_MEDIA_S3_BUCKET"]?.trim();
  if (s3Bucket) config.mediaS3Bucket = s3Bucket;
  const s3KeyId = env["BEACON_MEDIA_S3_ACCESS_KEY_ID"]?.trim();
  if (s3KeyId) config.mediaS3AccessKeyId = s3KeyId;
  const s3Secret = env["BEACON_MEDIA_S3_SECRET_ACCESS_KEY"]?.trim();
  if (s3Secret) config.mediaS3SecretAccessKey = s3Secret;
  const mediaLimitBytes = bytesLimitFromEnv(env, "BEACON_MEDIA_LIMIT_BYTES");
  if (mediaLimitBytes !== undefined) config.mediaLimitBytes = mediaLimitBytes;
  const restoreLimit = bytesLimitFromEnv(env, "BEACON_RESTORE_DATABASE_LIMIT_BYTES");
  if (restoreLimit !== undefined) config.restoreDatabaseLimitBytes = restoreLimit;
  const cdnUrl = env["BEACON_MEDIA_CDN_URL"]?.trim().replace(/\/+$/, ""); // strip trailing slash(es)
  if (cdnUrl) config.mediaCdnUrl = cdnUrl;
  return config;
}

/**
 * The JSON body-parser ceiling implied by a media size limit.
 *
 * Media uploads carry their bytes as base64 in the JSON body, so the parser has to fit ~1.4x the max
 * object size plus an envelope. Exported because **two** places depend on this relationship and they
 * must not each re-derive it: `main.ts` sizes the parser at boot, and `settings/live-config.ts`
 * clamps `mediaMaxBytes` to what that parser can actually accept.
 *
 * Applied unconditionally, which is a change from "1 MB when media is off". That conditional was a
 * boot-time decision about a runtime toggle: an operator who enables media without a redeploy would
 * have been left with a 1 MB parser refusing every upload from underneath the service, with the
 * wrong error. The cost is that a media-off deployment now accepts a larger request body before
 * rejecting it; the alternative is a capability that only half works when switched on.
 */
export function jsonBodyLimit(mediaMaxBytes: number): number {
  return Math.ceil(mediaMaxBytes * 1.4) + 65_536;
}

/**
 * What this server advertises, derived from the toggles rather than stored beside them.
 *
 * A pure function of the config it is handed, because it has **two** callers with the same claim to
 * be right: `loadConfig` at boot, and the live view on every read (settings/live-config.ts). Every
 * input is a runtime setting, so an admin turning the mailbox on has to reach the signed descriptor
 * the network reads, not just the routes. Deriving in one place is what makes those agree; a stored
 * copy would be a second truth that goes stale the moment a toggle moves.
 */
export type CapabilityInputs = Pick<
  ServerConfig,
  | "mailboxEnabled"
  | "mediaEnabled"
  | "geocodeEnabled"
  | "placesEnabled"
  | "placesContributionsEnabled"
  | "games"
>;

const ENGINE_MARKERS = acceptedMarkers();

export function deriveCapabilities(c: CapabilityInputs): string[] {
  // `places-proposals` is advertised separately from `places` because a game needs to know whether
  // this server takes submissions before it offers the player a way to make one.
  return [
    ...(c.mailboxEnabled ? ["mailbox"] : []),
    ...(c.mediaEnabled ? ["media"] : []),
    ...(c.geocodeEnabled ? ["geocode"] : []),
    ...(c.placesEnabled ? ["places"] : []),
    ...(c.placesContributionsEnabled ? ["places-proposals"] : []),
    // One entry per admitted slug, and none at all when the list is empty: open to every game.
    ...c.games.map((slug) => `game:${slug}`),
    // The engine's `op:` / `policy:` / `rule:` markers: what this build accepts beyond the
    // baseline. A property of the build, so unconditional, and derived once above.
    ...ENGINE_MARKERS,
    // This build enforces `accessLevel` and takes the `access.*` ops, at every level.
    ACCESS_MARKER,
  ];
}
