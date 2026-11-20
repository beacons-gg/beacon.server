/**
 * `cartographer` — the CLI entry point. Reads config from env + argv, opens the build database, runs
 * **one stage**, prints its report, exits.
 *
 * **A subcommand per stage**, rather than `osm-enrich`'s flags-only shape.
 * `apps/atlas/doc/spec/cartographer.md` §1 makes each stage independently re-runnable, and requires
 * that re-running a later stage never mean re-running an earlier one. A stage per subcommand makes
 * that the interface instead of a convention the operator has to remember.
 */
import { clientFromEnv, userAgentFromEnv } from "@beaconsgg/wikimedia";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Pool } from "pg";
import { ulid } from "ulid";
import { stageCommonsGeo } from "./commons-geo";
import { stageContrib } from "./contrib";
import { buildConcordance } from "./concordance";
import { stageKartaview } from "./kartaview";
import { adoptAcquired, recordInput, type InputResult } from "./inputs";
import { crawlMedia } from "./media";
import { merge } from "./merge";
import { normalize } from "./normalize";
import { stageNps } from "./nps";
import { stageRidb } from "./ridb";
import { pack } from "./pack";
import { prune } from "./prune";
import { keygen, loadAccount, publish } from "./publish";
import { normalizePrefix, required, s3StoreFromEnv, uploadVolume, volumeImportUrl } from "./upload";
import {
  commonsGeoLines,
  concordanceLines,
  contribLines,
  inputLines,
  kartaviewLines,
  keygenLines,
  mediaLines,
  mergeLines,
  normalizeLines,
  publishLines,
  pruneLines,
  resolveLines,
  verifyLines,
  npsLines,
  ridbLines,
  wikipediaLines,
} from "./report";
import { resolve } from "./resolve";
import { serveReview } from "./review";
import { stageWikipedia } from "./wikipedia";
import { ensureSchema, transactor, type Querier } from "./store";
import { verify } from "./verify";
import { versionFromLatest } from "@beaconsgg/atlas-volume";

/** No row budget by default — a stage runs until its input is exhausted (the `osm-enrich` lesson). */
const DEFAULT_LIMIT = Number.POSITIVE_INFINITY;

/** Where acquisition steps leave their records. The compose set mounts `osm-import/state` here. */
const DEFAULT_STATE_DIR = "/state";

/** Where a published volume is written. The compose set mounts `apps/atlas/published` here. */
const DEFAULT_OUT_DIR = "/out";

/** The review console's port — one above the admin console's 3100, and published by the compose set. */
const DEFAULT_REVIEW_PORT = 3200;

/**
 * Largest source image the media crawl will pull, before re-encoding.
 *
 * 12 MiB rather than the server's 10: this side fetches the *original* whenever it is no wider than the
 * published `full` size, and Commons originals in this dataset reach 8.7 MB. A cap that refused those would
 * silently drop exactly the photos a curated dataset most wants.
 */
function mediaMaxBytes(env: Record<string, string | undefined>): number {
  const raw = env["CARTOGRAPHER_MEDIA_MAX_BYTES"];
  if (raw === undefined || raw.trim() === "") return 12 * 1024 * 1024;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error("CARTOGRAPHER_MEDIA_MAX_BYTES must be a positive integer number of bytes");
  }
  return parsed;
}

/** A stage's required env var, or an error that says what to set and why — never a silent default. */
function requiredEnv(name: string, what: string): string {
  return required(process.env, name, what);
}

export type Stage =
  | "inputs"
  | "normalize"
  | "concordance"
  | "wikipedia"
  | "nps"
  | "ridb"
  | "commons-geo"
  | "kartaview"
  | "contrib"
  | "resolve"
  | "review"
  | "merge"
  | "media"
  | "publish"
  | "verify"
  | "keygen"
  | "pack"
  | "upload"
  | "prune";

/** Stage 0's arguments: which artifacts to record, and whether to rehash an unchanged one. */
export interface InputsFlags {
  stage: "inputs";
  /** `--input source=path`, repeatable. */
  inputs: { source: string; path: string }[];
  force: boolean;
}

/** Stage 1's arguments. */
export interface NormalizeFlags {
  stage: "normalize";
  limit: number;
  dryRun: boolean;
}

/** Stage 2a's arguments. `--refresh` re-asks about QIDs already answered for. */
export interface ConcordanceFlags {
  stage: "concordance";
  limit: number;
  refresh: boolean;
  dryRun: boolean;
}

/**
 * The Wikipedia source's arguments.
 *
 * `--limit` budgets **titles asked about**, not candidate records walked: the cost is paced requests, and a
 * page of 500 places may name no article at all or twenty places may name one.
 */
export interface WikipediaFlags {
  stage: "wikipedia";
  limit: number;
  /**
   * Re-ask about titles already answered for, including the ones recorded as having no article.
   *
   * The negative cache is otherwise **terminal**, which is right while the question is stable and wrong the
   * moment it is not: a title recorded absent because we asked it in the wrong form stays absent forever,
   * and fixing how titles are derived does not re-ask any of them. The concordance carries the same flag
   * for the same reason.
   */
  refresh: boolean;
  dryRun: boolean;
}

/**
 * The NPS source's arguments — **no `--limit` and no `--refresh`**, deliberately: the corpus is ~474
 * units fetched whole in one listing request every run, so there is no per-key budget to spend and no
 * per-key negative cache to bust. The two knobs the sibling source needs are exactly the two this one
 * has no question for.
 */
export interface NpsFlags {
  stage: "nps";
  dryRun: boolean;
}

/** The RIDB source's — the same two absences for a different reason: the fetch set is the ~150-candidate
 *  join population, re-fetched whole each run, not a corpus or a per-key ledger. */
export interface RidbFlags {
  stage: "ridb";
  dryRun: boolean;
}

/**
 * The Commons geo source's arguments. `--dump` names the `geo_tags` dump to (re)load — the table is
 * replaced whole, so it is passed when the dump changed and omitted to re-join against what is loaded.
 * `--refresh` re-asks about categories and page ids already answered for, the same negative-cache door
 * the wikipedia stage documents. No `--limit`: the network cost is the *matched* population (~hundreds
 * of batched requests), not the corpus.
 */
export interface CommonsGeoFlags {
  stage: "commons-geo";
  dump?: string;
  refresh: boolean;
  dryRun: boolean;
}

/**
 * The KartaView source's arguments. `--sweep` runs the API acquisition (a cheap sequence listing,
 * then the slow per-sequence photo pass) before the join; omitted, the stage re-joins what the
 * catalog already holds. `--limit` bounds the slow pass in **sequences fetched** — the sweep's
 * resumable unit — because the API answers in seconds per request and has no bulk product.
 */
export interface KartaviewFlags {
  stage: "kartaview";
  sweep: boolean;
  limit: number;
  dryRun: boolean;
}

/**
 * The contribution source's arguments.
 *
 * `--file` and nothing else. No `--limit`, because the unit of work is one operator's export rather
 * than a corpus or a paced API — a partial pass would stage half a file for no budget it was
 * saving. No `--refresh`, because there is no negative cache to bust: the file IS the answer, and
 * re-running over the same one re-upserts the same records by `(source, source_id)`.
 */
export interface ContribFlags {
  stage: "contrib";
  file: string;
  dryRun: boolean;
}

/**
 * Stage 2b's arguments — **no `--limit`**, and that is the interesting part.
 *
 * Identity is global: a component is only correct when every record sharing an identifier is in view, so
 * a bounded pass would produce *wrong* entities rather than fewer of them — and it would mint ids for
 * them, which is the one mistake here that cannot be taken back. `STAGE_FLAGS` makes `--limit` an error
 * rather than something an operator can pass and be quietly obeyed about.
 */
export interface ResolveFlags {
  stage: "resolve";
  dryRun: boolean;
}

/**
 * The review console's arguments (`apps/atlas/doc/spec/cartographer.md` §5 — not a pipeline stage;
 * it serves until ctrl-c).
 *
 * `--reviewer` is **required**: a verdict is permanent, applies to every future volume, and `decided_by`
 * is its audit trail — the console refuses to run anonymously rather than invent a name, the same rule
 * `CARTOGRAPHER_USER_AGENT` follows.
 */
export interface ReviewFlags {
  stage: "review";
  port: number;
  reviewer: string;
  /** Where the media crawl wrote its blobs — the Media tab serves thumbs from here. */
  out: string;
}

/**
 * Stage 3's arguments. `--limit` is permitted here and refused by `resolve` for a real reason: merging
 * one entity needs only that entity's records, so a bounded pass produces fewer places rather than wrong
 * ones. It does produce an **unpublishable** database, which `publish` detects rather than trusting.
 */
export interface MergeFlags {
  stage: "merge";
  limit: number;
  dryRun: boolean;
}

/**
 * Stage 4's arguments.
 *
 * `--limit` budgets **files attempted**, not entities walked, because the cost here is paced network calls
 * and a page of 500 places may reference none. Attempted rather than *fetched*: a budget spent only on
 * successes is no budget at all when files are failing — measured, it walked the whole dataset. `--retry` reads the retry ledger instead of walking entities: a
 * throttled run leaves its files scheduled, and picking 300 of them up again should cost one indexed read
 * rather than a pass over 225k places. `--out` because the crawl writes bytes, which is what makes it the
 * only stage besides publish that touches the output tree.
 *
 * `--retry` and `--refresh` answer different questions, and the asymmetry in **cost** is the part to keep
 * straight. `--retry` recovers what the ledger already says is outstanding, and it *drains* — every file it
 * takes leaves the ledger. `--refresh` re-asks about files an earlier run **settled**, which here means the
 * whole dataset: ~8,363 metadata lookups *and* 8,363 original-size byte downloads, the full multi-hour crawl.
 * It also does not drain, so `--refresh --limit 300` re-does the same first 300 files every time — chunking a
 * refresh is repeated work, unlike chunking a retry.
 *
 * It is kept because the other two network stages have it and the hole is real (a licence that changed, a
 * re-encode at new dimensions), but it is **not** the door for recovering lost blobs, even though it would
 * work: `publish` demotes those rows and `--retry` collects them for the cost of the files actually missing.
 */
export interface MediaFlags {
  stage: "media";
  limit: number;
  retry: boolean;
  /** Ignored under `--retry`, whose ledger read is already state-scoped. */
  refresh: boolean;
  out: string;
  dryRun: boolean;
}

/**
 * Stage 5's arguments. `--volume` and `--version` are **required**, not defaulted from the clock:
 * they are the published identity, a version's bytes never change once anyone has fetched them
 * (`apps/atlas/doc/spec/volume-format.md` §10), and an identity nobody typed is one nobody checked.
 */
export interface PublishFlags {
  stage: "publish";
  volume: string;
  version: string;
  out: string;
  dryRun: boolean;
}

/** Stage 6's arguments. With no `--version` it reads `latest.json`, exactly as a fresh consumer would. */
export interface VerifyFlags {
  stage: "verify";
  out: string;
  version?: string;
  previous?: string;
}

/**
 * `keygen`'s arguments. `--file` overrides `CARTOGRAPHER_KEY_FILE`, and one of the two must name a
 * path — on an operator's host the env is usually unset, which is exactly when this command runs.
 */
export interface KeygenFlags {
  stage: "keygen";
  file?: string;
}

/**
 * `prune`'s arguments — the destructive one, so both knobs are opt-in.
 *
 * `--unlinked` is separate from `--dry-run` and not implied by anything: a file with no place link
 * is *also* what a half-finished crawl page looks like, so sweeping those is a statement that no
 * crawl is running, which only the operator can make.
 */
export interface PruneFlags {
  stage: "prune";
  out: string;
  unlinked: boolean;
  dryRun: boolean;
}

/** `pack`'s arguments — one published version as a single shareable zip. */
export interface PackFlags {
  stage: "pack";
  out: string;
  version?: string;
}

/**
 * `upload`'s arguments — one published version pushed to S3-compatible storage (R2, Spaces, S3).
 * `--prefix` is the key prefix the tree lands under (the `<volume>/` a host serves the volume
 * under); absent, `CARTOGRAPHER_S3_PREFIX` is the standing default, and absent both the tree lands
 * at the bucket root. With no `--version` it uploads what `latest.json` points at, like `pack` and
 * `verify`.
 */
export interface UploadFlags {
  stage: "upload";
  out: string;
  version?: string;
  prefix?: string;
  dryRun: boolean;
}

/**
 * A union, not one bag with every field — the stages share few flags, so a flat shape would leave every
 * reader guessing which fields mean anything, and `main`'s dispatch narrows on the tag for free.
 */
export type Flags =
  | InputsFlags
  | NormalizeFlags
  | ConcordanceFlags
  | WikipediaFlags
  | NpsFlags
  | RidbFlags
  | CommonsGeoFlags
  | KartaviewFlags
  | ContribFlags
  | ResolveFlags
  | ReviewFlags
  | MergeFlags
  | MediaFlags
  | PublishFlags
  | VerifyFlags
  | KeygenFlags
  | PackFlags
  | UploadFlags
  | PruneFlags;

/**
 * Stages that need no build database. `verify` reads the published tree and nothing else — that is the
 * property stage 6 exists to demonstrate, so demanding a DSN would make a mirrored volume unverifiable
 * anywhere but the builder's own machine.
 *
 * A type rather than a `needsDb` flag: {@link runStage} takes {@link DbFlags}, so a DB-free stage left in
 * its switch is a **compile error** instead of an unreachable arm kept alive to satisfy exhaustiveness.
 *
 * `keygen` is here too: it runs on the operator's host, before any container or database exists —
 * that is the point of it.
 */
export type DbFreeFlags = VerifyFlags | KeygenFlags | PackFlags | UploadFlags;

/** Everything else — the stages {@link runStage} dispatches, all of which hold a pool. */
export type DbFlags = Exclude<Flags, DbFreeFlags>;

/** Which flags each stage accepts. Anything else is an error, including a flag another stage owns. */
const STAGE_FLAGS: Record<Stage, readonly string[]> = {
  inputs: ["--input", "--force"],
  normalize: ["--limit", "--dry-run"],
  concordance: ["--limit", "--refresh", "--dry-run"],
  wikipedia: ["--limit", "--refresh", "--dry-run"],
  nps: ["--dry-run"],
  ridb: ["--dry-run"],
  "commons-geo": ["--dump", "--refresh", "--dry-run"],
  kartaview: ["--sweep", "--limit", "--dry-run"],
  contrib: ["--file", "--dry-run"],
  resolve: ["--dry-run"],
  review: ["--reviewer", "--port", "--out"],
  merge: ["--limit", "--dry-run"],
  media: ["--limit", "--retry", "--refresh", "--out", "--dry-run"],
  publish: ["--volume", "--version", "--out", "--dry-run"],
  verify: ["--out", "--version", "--previous"],
  keygen: ["--file"],
  pack: ["--out", "--version"],
  upload: ["--out", "--version", "--prefix", "--dry-run"],
  prune: ["--out", "--unlinked", "--dry-run"],
};

const USAGE = `usage:
  cartographer inputs      [--input <source>=<path> …] [--force]
  cartographer normalize   [--limit N] [--dry-run]
  cartographer concordance [--limit N] [--refresh] [--dry-run]
  cartographer wikipedia   [--limit N] [--refresh] [--dry-run]
  cartographer nps         [--dry-run]
  cartographer ridb        [--dry-run]
  cartographer commons-geo [--dump PATH] [--refresh] [--dry-run]
  cartographer kartaview   [--sweep] [--limit N] [--dry-run]
  cartographer contrib     --file PATH [--dry-run]
  cartographer resolve     [--dry-run]
  cartographer review      --reviewer <name> [--port N] [--out DIR]
  cartographer merge       [--limit N] [--dry-run]
  cartographer media       [--limit N] [--retry] [--refresh] [--out DIR] [--dry-run]
  cartographer publish     --volume <name> --version <name> [--out DIR] [--dry-run]
  cartographer verify      [--out DIR] [--version <name>] [--previous <name>]
  cartographer keygen      [--file PATH]
  cartographer pack        [--out DIR] [--version <name>]
  cartographer upload      [--out DIR] [--version <name>] [--prefix <key>] [--dry-run]
  cartographer prune       [--out DIR] [--unlinked] [--dry-run]

  inputs adopts whatever the acquisition steps recorded in CARTOGRAPHER_STATE_DIR —
  the OSM extract is named to osm-import, never here. Use --input only for an
  artifact cartographer reads itself (e.g. contrib=/data/contrib.json).

  concordance asks Wikidata about the QIDs staging references — upstream ids,
  plus the brand QIDs whose P154 logos the media crawl resolves; wikipedia then resolves
  the articles staging names — from a record's own tag, or from a QID's enwiki
  sitelink the concordance already stored — and stages what they say as its own
  source, so per-field merge decides what Wikipedia wins. It replaces the old
  osm-enrich job. nps does the same for US National Park Service units: it fetches
  the whole ~474-unit corpus in one keyed request, matches staged places through
  their QID's Park Alpha Code (a concordance claim — run concordance first, and
  once with --refresh if it predates this stage), and stages the Park Service's
  own description, page and public-domain photo. ridb does the same for federal
  recreation facilities (campgrounds, trailheads): candidates join through an OSM
  website= tag naming a recreation.gov campground page, or a QID's P6747 claim
  (run concordance --refresh once if it predates this stage); text stages only
  for federally-managed facilities and photos only under federal credits, because
  RIDB states no licence of its own.

  commons-geo stages photos proven to be INSIDE a place: it joins Commons'
  geo_tags dump (--dump the .sql.gz from
  https://dumps.wikimedia.org/commonswiki/latest/commonswiki-latest-geo_tags.sql.gz,
  ~0.7 GB, loaded whole; omit --dump to re-join what is already loaded) against
  every staged polygon under 2 km² by ST_Contains, and resolves only the matched
  page ids to titles. It also fetches the category listings that
  wikimedia_commons=Category:… tags name, which un-defers those references in
  media. Proximity without containment is deliberately not used — measured, it
  finds photos of the town, not the place.

  kartaview stages street-level photos AIMED at a place (camera heading within
  50° of the camera→place bearing, within 35 m) — the floor of the photo
  ranking, for the places nothing else covers. --sweep acquires the catalog:
  one cheap sequence listing over the staging extent, then one photo listing
  per sequence against a slow API — bound it with --limit N (sequences) and
  re-run; it resumes. Without --sweep the stage re-joins what is held. The
  imagery is corpus-wide CC BY-SA 4.0 (KartaView's own grant); the API is
  anonymous, so no platform terms attach. resolve turns staged records
  into entities and is local, deterministic, and re-runnable; it takes no
  --limit, because a partial pass produces wrong entities rather than fewer.

  contrib stages approved player contributions a Beacon operator exported
  from their server (places.contrib.export, a beacon-contrib/1 file). Record
  it with "inputs --input contrib=<path>" first, so the manifest names the
  exact bytes. An IMPROVEMENT joins the place it improves by naming one of
  its records and asserting no ids of its own — so a round-tripped
  contribution is never counted as an independent source agreeing with this
  dataset's own output. A NEW place asserts contrib:<host>/<unique> and
  becomes its own place; that id is also how the originating server
  recognises its contribution coming home instead of duplicating it. Photos
  ride along only with a stated licence. Cartographer never calls a Beacon
  server: the operator hands the file over.

  review serves the review console (cartographer.md §5) on --port (default
  3200) until ctrl-c, in two halves. IDENTITY: every identifier the merge gate
  refused, with the asserting records' fields and both pins on a map — "not
  this id" severs one record's claim (distinct), "same place" forces records
  together, outranking the gate; either applies at the NEXT resolve. IMAGERY: a
  contact sheet of every published photo (served from --out's blob tree),
  newest first, filtered by source — approve a whole page at a click, or open
  one to reject the photo everywhere, unlink it from a place that is not its
  own, or remove the place entirely; those apply at the next PUBLISH. Every
  verdict is durable, attributed to --reviewer, and withdrawable. Under docker
  the port needs publishing:
    docker compose --profile cartograph run --rm --service-ports \\
      cartographer review --reviewer <you>

  media fetches the photos each place claims, re-encodes them and stores them
  content-addressed under <out>/media. --limit budgets FILES ATTEMPTED, not
  places walked. A file Wikimedia never answered for is left scheduled, never recorded as
  "no photo" — run "media --retry" to pick those up. If <out>/media is lost, publish
  puts those files back on the ledger, so "media --retry" refetches those too.
  --refresh re-asks about files already SETTLED, which is the whole dataset (~8,363
  downloads, hours) and does not drain, so chunking it repeats work. Prefer --retry.

  merge takes the fields each place publishes; publish writes and signs the volume;
  verify reads it back as a foreign consumer. publish refuses an incomplete merge.
  Pass --previous <version> to verify to check that no place id was lost — the one
  assertion that protects an operator's edits, and it is skipped without it.

  keygen creates the volume signing key publish reads (--file, or
  CARTOGRAPHER_KEY_FILE): a BIP39 phrase written mode 600. It refuses an existing
  file and prints its did:key instead. Runs on the host; no database, no docker.

  prune deletes photo bytes nothing can publish again — a disk-versus-claims
  diff, not a query: a published->rejected row loses its hashes, so those
  bytes are unreachable from the database and only a sweep finds them. A blob
  is KEPT if any media_files row still earns it (the same publishability rule
  publish applies) or if any published version on disk references it — pruning
  one of those would break verify/pack/upload for that version permanently.
  Photos with no place link are kept unless --unlinked, because unlinked is
  also what a half-finished crawl page looks like (media commits rows every 50
  files and links once per 500-entity page), so sweeping them is a statement
  that no crawl is running. Start with --dry-run.

  upload pushes a published version to S3-compatible storage (R2, Spaces, S3) —
  the same file list pack zips. Version files and media are immutable so a re-run
  uploads only what is absent (resume for free); latest.json goes LAST, always,
  so a consumer never sees it name a half-arrived version. --prefix is the key
  prefix the tree lands under (usually the volume name). Configure the bucket
  with CARTOGRAPHER_S3_*; reads stay public and untrusted (the importer verifies
  every byte against the signed manifest) — these credentials only WRITE.

env:
  CARTOGRAPHER_DATABASE_URL   the build database (the osm2pgsql import DB)
  CARTOGRAPHER_STATE_DIR      where acquisition steps record what they consumed
  CARTOGRAPHER_OUT_DIR        where publish writes the volume (default /out)
  CARTOGRAPHER_KEY_FILE       BIP39 phrase for the volume signing key; chmod 600.
                              Required by publish — there is no unsigned mode.
  CARTOGRAPHER_USER_AGENT     descriptive UA with contact info — required by
                              Wikimedia policy, and required by concordance
  CARTOGRAPHER_INTERVAL_MS    ms between Wikimedia API requests (default 200) —
                              concordance, and media's metadata pass
  CARTOGRAPHER_BYTES_INTERVAL_MS
                              ms between media BYTE fetches (default 200). Its own
                              budget because upload.wikimedia.org throttles
                              separately from the API host, and one shared gate
                              would make the slower of the two bind on both.
  CARTOGRAPHER_MEDIA_MAX_BYTES
                              largest source image to fetch (default 12 MiB)
  CARTOGRAPHER_NPS_API_KEY    api.data.gov key for the nps stage — free and
                              instant (https://www.nps.gov/subjects/developer/
                              get-started.htm); DEMO_KEY works at 30 req/hour
  CARTOGRAPHER_RIDB_API_KEY   RIDB key for the ridb stage — free and instant
                              from a recreation.gov profile
                              (https://ridb.recreation.gov)
  CARTOGRAPHER_S3_BUCKET      the bucket upload pushes volumes into
  CARTOGRAPHER_S3_PREFIX      standing default for --prefix — where in the
                              bucket the tree lands (e.g. atlas); the flag wins
  CARTOGRAPHER_S3_ENDPOINT    S3 API endpoint — absent = AWS itself; for R2,
                              https://<account-id>.r2.cloudflarestorage.com
  CARTOGRAPHER_S3_REGION      default auto (right for R2; AWS wants a real one)
  CARTOGRAPHER_S3_ACCESS_KEY_ID / CARTOGRAPHER_S3_SECRET_ACCESS_KEY
                              a key that may WRITE the bucket — keep them in the
                              secrets directory and export, never in a file that
                              gets committed. Reads stay public and keyless.
  CARTOGRAPHER_S3_FORCE_PATH_STYLE
                              set to 1 for hosts that want path-style URLs
  CARTOGRAPHER_S3_PUBLIC_URL  the bucket's public origin (e.g. a CDN), so upload
                              prints the full import URL`;

const STAGES = Object.keys(STAGE_FLAGS) as Stage[];

/**
 * Parse the stage plus its flags.
 *
 * An argument the stage does not accept is an **error, never ignored** — including one another stage
 * owns. `cartographer inputs --dry-run` used to parse fine and then write anyway, which is exactly the
 * failure this rule exists to prevent: a silently dropped `--dry-run` writes to a database the operator
 * believed they were only inspecting. Unknown and misplaced deserve the same treatment, because to the
 * operator they are the same mistake.
 */
export function parseArgs(argv: readonly string[], defaultOutDir = DEFAULT_OUT_DIR): Flags {
  const stage = argv[0] as Stage | undefined;
  if (!stage || !STAGES.includes(stage)) {
    throw new Error(
      `expected a stage (${STAGES.join(" | ")}), got ${argv[0] ?? "nothing"}\n\n${USAGE}`,
    );
  }

  const inputs: InputsFlags["inputs"] = [];
  let force = false;
  let refresh = false;
  let retry = false;
  let limit = DEFAULT_LIMIT;
  let dryRun = false;
  let volume: string | undefined;
  let version: string | undefined;
  let previous: string | undefined;
  let file: string | undefined;
  let dump: string | undefined;
  let sweep = false;
  let unlinked = false;
  let out = defaultOutDir;
  let reviewer: string | undefined;
  let port = DEFAULT_REVIEW_PORT;
  let prefix: string | undefined;

  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i] ?? "";
    if (!STAGE_FLAGS[stage].includes(arg)) {
      const owner = STAGES.find((s) => STAGE_FLAGS[s].includes(arg));
      throw new Error(
        owner
          ? `${arg} belongs to the ${owner} stage, not ${stage}\n\n${USAGE}`
          : `unknown argument: ${arg}\n\n${USAGE}`,
      );
    }
    /** The next argument, required — a flag silently taking the *following flag* as its value is worse. */
    const value = (): string => {
      const next = argv[++i];
      if (next === undefined || next.startsWith("--")) {
        throw new Error(`${arg} needs a value\n\n${USAGE}`);
      }
      return next;
    };
    if (arg === "--dry-run") dryRun = true;
    else if (arg === "--force") force = true;
    else if (arg === "--refresh") refresh = true;
    else if (arg === "--retry") retry = true;
    else if (arg === "--sweep") sweep = true;
    else if (arg === "--unlinked") unlinked = true;
    else if (arg === "--volume") volume = value();
    else if (arg === "--version") version = value();
    else if (arg === "--previous") previous = value();
    else if (arg === "--file") file = value();
    else if (arg === "--dump") dump = value();
    else if (arg === "--out") out = value();
    else if (arg === "--reviewer") reviewer = value();
    else if (arg === "--prefix") prefix = normalizePrefix(value());
    else if (arg === "--port") {
      const parsed = Number(value());
      if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65535)
        throw new Error("--port needs a port number");
      port = parsed;
    } else if (arg === "--input") {
      const raw = value();
      const split = raw.indexOf("=");
      // Split on the FIRST `=` only: a path may contain one, a source id may not.
      if (split <= 0 || split === raw.length - 1) {
        throw new Error(`--input needs <source>=<path>, got ${raw}`);
      }
      inputs.push({ source: raw.slice(0, split), path: raw.slice(split + 1) });
    } else if (arg === "--limit") {
      const parsed = Number(value());
      if (!Number.isInteger(parsed) || parsed <= 0)
        throw new Error("--limit needs a positive integer");
      limit = parsed;
    }
  }

  if (stage === "normalize") return { stage, limit, dryRun };
  if (stage === "concordance") return { stage, limit, refresh, dryRun };
  if (stage === "wikipedia") return { stage, limit, refresh, dryRun };
  if (stage === "nps") return { stage, dryRun };
  if (stage === "ridb") return { stage, dryRun };
  if (stage === "commons-geo") return { stage, ...(dump ? { dump } : {}), refresh, dryRun };
  if (stage === "kartaview") return { stage, sweep, limit, dryRun };
  if (stage === "contrib") {
    if (!file) {
      throw new Error(
        "contrib needs --file <path> — the beacon-contrib/1 export a Beacon operator handed over " +
          `(record it with \`inputs --input contrib=<path>\` so the manifest names it)\n\n${USAGE}`,
      );
    }
    return { stage, file, dryRun };
  }
  if (stage === "resolve") return { stage, dryRun };
  if (stage === "review") {
    if (!reviewer) {
      throw new Error(
        "review needs --reviewer <name> — a verdict is permanent and decided_by is its audit " +
          `trail, so the console refuses to run anonymously\n\n${USAGE}`,
      );
    }
    return { stage, port, reviewer, out };
  }
  if (stage === "merge") return { stage, limit, dryRun };
  if (stage === "media") return { stage, limit, retry, refresh, out, dryRun };
  if (stage === "publish") {
    if (!volume || !version) {
      throw new Error(
        `publish needs --volume and --version (e.g. --volume us-west --version 2026-08); ` +
          `a published version is immutable, so its identity is stated rather than guessed\n\n${USAGE}`,
      );
    }
    return { stage, volume, version, out, dryRun };
  }
  if (stage === "verify") {
    return { stage, out, ...(version ? { version } : {}), ...(previous ? { previous } : {}) };
  }
  if (stage === "keygen") return { stage, ...(file ? { file } : {}) };
  if (stage === "pack") return { stage, out, ...(version ? { version } : {}) };
  if (stage === "prune") return { stage, out, unlinked, dryRun };
  if (stage === "upload") {
    return {
      stage,
      out,
      ...(version ? { version } : {}),
      ...(prefix !== undefined ? { prefix } : {}),
      dryRun,
    };
  }
  // No `--input` is the normal case now: the OSM extract is recorded by the step that read it.
  return { stage, inputs, force };
}

async function main(): Promise<void> {
  // Env resolved at the call site, like `stateDir` below — `parseArgs` stays a pure function of its argv.
  const flags = parseArgs(
    process.argv.slice(2),
    process.env["CARTOGRAPHER_OUT_DIR"] ?? DEFAULT_OUT_DIR,
  );
  const log = (message: string): void => console.log(message);
  const now = (): string => new Date().toISOString();

  // `verify` reads the published tree and nothing else — that is the point of it, so that what gets
  // checked is what a foreign consumer would see rather than what the builder believes. Demanding a
  // database it never opens would make a mirrored volume unverifiable on any machine but this one, which
  // is the opposite of the property stage 6 exists to demonstrate.
  if (flags.stage === "verify") {
    for (const line of await runVerify(flags, { log })) console.log(line);
    return;
  }
  if (flags.stage === "keygen") {
    for (const line of keygenLines(keygen(process.env, flags))) console.log(line);
    return;
  }
  if (flags.stage === "pack") {
    const version = flags.version ?? (await latestVersion(flags.out));
    const report = await pack({ outDir: flags.out, version, log });
    console.log(
      `done — ${report.version} packed: ${report.archive} ` +
        `(${report.files} files, ${report.media} photos, ${(report.bytes / 1e6).toFixed(1)} MB)` +
        (report.missing > 0
          ? `\n  ${report.missing} referenced photo(s) had no blob on disk and are NOT in the archive —` +
            "\n  run `media --retry` and re-pack if they should be."
          : ""),
    );
    return;
  }
  if (flags.stage === "upload") {
    const version = flags.version ?? (await latestVersion(flags.out));
    // Credentials checked before the tree walk, so a misconfigured env fails in one second.
    const { store, bucket, defaultPrefix, publicUrl } = s3StoreFromEnv(process.env);
    const report = await uploadVolume(store, {
      outDir: flags.out,
      version,
      // The flag wins; the env is the standing default for an operator always shipping to one place.
      prefix: flags.prefix ?? defaultPrefix,
      dryRun: flags.dryRun,
      log,
    });
    const where = `s3://${bucket}/${report.prefix ? `${report.prefix}/` : ""}`;
    console.log(
      `${report.dryRun ? "dry-run" : "done"} — ${report.version} → ${where}: ` +
        `${report.uploaded} uploaded, ${report.skipped} already present` +
        (report.dryRun ? "" : ` (${(report.bytes / 1e6).toFixed(1)} MB sent)`) +
        (report.missing > 0
          ? `\n  ${report.missing} referenced photo(s) had no blob on disk and were NOT uploaded —` +
            "\n  run `media --retry` and re-upload if they should be."
          : "") +
        `\n  import URL: ${volumeImportUrl(publicUrl, report.prefix)} (follows latest.json to ${report.version})`,
    );
    return;
  }

  const dsn = process.env["CARTOGRAPHER_DATABASE_URL"];
  if (!dsn) throw new Error("CARTOGRAPHER_DATABASE_URL is not set (the build database)");
  // `max: 6` because `resolve` issues five reads concurrently and then holds one connection for its
  // transaction; stages 0-1 never need more than one at a time.
  const pool = new Pool({ connectionString: dsn, max: 6, allowExitOnIdle: true });
  try {
    await ensureSchema(pool);
    for (const line of await runStage(pool, flags, { log, now })) console.log(line);
  } finally {
    await pool.end();
  }
}

/** Stage 6, which needs no database — see the note in {@link main}. */
async function runVerify(
  flags: VerifyFlags,
  opts: { log: (message: string) => void },
): Promise<string[]> {
  const version = flags.version ?? (await latestVersion(flags.out));
  const report = await verify({
    dir: join(flags.out, version),
    ...(flags.previous ? { previousDir: join(flags.out, flags.previous) } : {}),
    log: opts.log,
  });
  // A failing verify must fail the *build*, not print a red line and exit 0 — the continuity check is the
  // one protecting downstream operators from losing their edits.
  if (report.failures.length > 0) process.exitCode = 1;
  return verifyLines(report);
}

/** Dispatch one stage and return its report lines. */
async function runStage(
  pool: Pool,
  flags: DbFlags,
  opts: { log: (message: string) => void; now: () => string },
): Promise<string[]> {
  switch (flags.stage) {
    case "inputs":
      return inputLines(
        await runInputs(pool, flags, {
          now: opts.now(),
          stateDir: process.env["CARTOGRAPHER_STATE_DIR"] ?? DEFAULT_STATE_DIR,
        }),
      );
    case "normalize":
      return normalizeLines(
        await normalize(pool, {
          limit: flags.limit,
          dryRun: flags.dryRun,
          now: opts.now,
          log: opts.log,
        }),
      );
    case "concordance":
      return concordanceLines(
        await buildConcordance(pool, clientFromEnv(process.env, "CARTOGRAPHER"), {
          limit: flags.limit,
          refresh: flags.refresh,
          dryRun: flags.dryRun,
          now: opts.now,
          log: opts.log,
        }),
      );
    case "wikipedia":
      return wikipediaLines(
        await stageWikipedia(pool, {
          limit: flags.limit,
          refresh: flags.refresh,
          dryRun: flags.dryRun,
          // The API client, not a second one: articles come from en.wikipedia.org and share the
          // concordance's budget, which is one host's worth of politeness either way.
          client: clientFromEnv(process.env, "CARTOGRAPHER"),
          now: opts.now,
          log: opts.log,
        }),
      );
    case "ridb":
      return ridbLines(
        await stageRidb(pool, {
          dryRun: flags.dryRun,
          apiKey: requiredEnv(
            "CARTOGRAPHER_RIDB_API_KEY",
            "an RIDB key — free and instant from a recreation.gov profile " +
              "(https://ridb.recreation.gov, sign in \u2192 profile \u2192 API key)",
          ),
          userAgent: userAgentFromEnv(process.env, "CARTOGRAPHER"),
          now: opts.now,
          log: opts.log,
        }),
      );
    case "nps":
      return npsLines(
        await stageNps(pool, {
          dryRun: flags.dryRun,
          apiKey: requiredEnv(
            "CARTOGRAPHER_NPS_API_KEY",
            "an api.data.gov key — free and instant at " +
              "https://www.nps.gov/subjects/developer/get-started.htm (DEMO_KEY works, 30 req/hour)",
          ),
          // The one validator of the one UA variable — a different host, the same operator identity.
          userAgent: userAgentFromEnv(process.env, "CARTOGRAPHER"),
          now: opts.now,
          log: opts.log,
        }),
      );
    case "commons-geo":
      return commonsGeoLines(
        await stageCommonsGeo(pool, {
          ...(flags.dump ? { dump: flags.dump } : {}),
          refresh: flags.refresh,
          dryRun: flags.dryRun,
          // The API client, not a second one: the category listings and page-id lookups go to
          // commons.wikimedia.org, the same host the media crawl's metadata pass paces against.
          client: clientFromEnv(process.env, "CARTOGRAPHER"),
          now: opts.now,
          log: opts.log,
        }),
      );
    case "kartaview":
      return kartaviewLines(
        await stageKartaview(pool, {
          sweep: flags.sweep,
          limit: flags.limit,
          dryRun: flags.dryRun,
          userAgent: userAgentFromEnv(process.env, "CARTOGRAPHER"),
          now: opts.now,
          log: opts.log,
        }),
      );
    case "contrib":
      return contribLines(
        await stageContrib(pool, {
          file: flags.file,
          dryRun: flags.dryRun,
          now: opts.now,
          log: opts.log,
        }),
      );
    case "prune":
      return pruneLines(
        await prune(pool, {
          outDir: flags.out,
          includeUnlinked: flags.unlinked,
          dryRun: flags.dryRun,
          log: opts.log,
        }),
      );
    case "resolve": {
      const outcome = await resolve(pool, transactor(pool), {
        dryRun: flags.dryRun,
        // The one permitted non-determinism (`apps/atlas/doc/spec/cartographer.md` §4: "never into
        // matching or id assignment beyond the initial ULID"), and it lives here rather than in the
        // resolver so that every *decision* stays reproducible from the inputs.
        mintId: () => ulid(),
        now: opts.now,
        log: opts.log,
      });
      return resolveLines(outcome.report, outcome.gated);
    }
    case "review":
      await serveReview(
        { db: pool, reviewer: flags.reviewer, outDir: flags.out, now: opts.now, log: opts.log },
        flags.port,
      );
      return [];
    case "merge":
      return mergeLines(
        await merge(pool, {
          limit: flags.limit,
          dryRun: flags.dryRun,
          now: opts.now,
          log: opts.log,
        }),
      );
    case "media":
      return mediaLines(
        await crawlMedia(pool, {
          limit: flags.limit,
          retry: flags.retry,
          refresh: flags.refresh,
          dryRun: flags.dryRun,
          outDir: flags.out,
          // TWO clients, deliberately. `nextAllowedAt` is per-instance, so this is how the metadata
          // host and the byte host get budgets that do not queue behind each other
          // (`apps/atlas/doc/spec/cartographer.md` §4).
          api: clientFromEnv(process.env, "CARTOGRAPHER"),
          bytes: clientFromEnv(process.env, "CARTOGRAPHER", "_BYTES_INTERVAL_MS"),
          maxBytes: mediaMaxBytes(process.env),
          now: opts.now,
          log: opts.log,
        }),
      );
    case "publish":
      return publishLines(
        await publish(pool, {
          volume: flags.volume,
          version: flags.version,
          outDir: flags.out,
          dryRun: flags.dryRun,
          // Read before any work, so a missing or group-readable key fails before a revision is claimed.
          account: loadAccount(process.env),
          now: opts.now,
          log: opts.log,
        }),
      );
  }
}

/** Which version `latest.json` points at — what a consumer with no pinned version reads first. */
async function latestVersion(outDir: string): Promise<string> {
  const path = join(outDir, "latest.json");
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    throw new Error(
      `no ${path} — nothing has been published to ${outDir}, or pass --version to check one directly`,
    );
  }
  const version = versionFromLatest(text);
  if (!version) throw new Error(`${path} does not name a version`);
  return version;
}

/**
 * Stage 0: adopt what the acquisition steps recorded, then hash anything named explicitly.
 *
 * Exported to be tested: the "an explicit input must agree with what was acquired" rule is the whole
 * mechanism, and a rule with no test is a convention.
 *
 * Adoption first, and unconditional — an operator running `inputs` after an import expects the import
 * to be accounted for without having to name it. `--input` is additive on top, for the artifacts
 * Cartographer opens itself. Serial: each hash is disk-bound on its own.
 */
export async function runInputs(
  db: Querier,
  flags: InputsFlags,
  opts: { now: string; stateDir: string; log?: (m: string) => void },
): Promise<InputResult[]> {
  const now = opts.now;
  const results = await adoptAcquired(db, {
    dir: opts.stateDir,
    now,
    warn: (message) => (opts.log ?? console.warn)(`warning: ${message}`),
  });
  for (const input of flags.inputs) {
    const hashed = await recordInput(db, {
      ...input,
      now,
      force: flags.force,
      onHash: (path) =>
        (opts.log ?? console.log)(`hashing ${path} … (multi-GB inputs take a minute)`),
    });
    // The acquiring step's record is authoritative. An explicit `--input` for an artifact already
    // adopted would otherwise overwrite it through `ON CONFLICT DO UPDATE`, last writer wins — which is
    // the original hole, still reachable by anyone who names the extract here out of habit. Agreement is
    // fine and idempotent; disagreement means the file on disk is not the one that was consumed, and
    // that is the exact condition a manifest must never be built on.
    const adopted = results.find(
      (r) => r.source === hashed.source && r.artifact === hashed.artifact,
    );
    if (adopted && adopted.hash !== hashed.hash) {
      throw new Error(
        `${input.source}=${input.path} does not match what was acquired: ` +
          `${hashed.hash} on disk, ${adopted.hash} recorded by the step that consumed it. ` +
          `Re-run that step, or drop the --input and let stage 0 adopt its record.`,
      );
    }
    if (!adopted) results.push(hashed);
  }
  return results;
}

// Only when run as the entry point — `parseArgs` is exported to be tested, which makes this module
// importable, and importing it must not open a database. (CommonJS output, hence `require.main`.)
if (require.main === module) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
