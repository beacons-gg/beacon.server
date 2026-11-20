/**
 * Stage 5 — write the volume.
 *
 * The thin half: `volume.ts` decides what the artifact *says*, this decides where the bytes go, hashes
 * them, and signs the root. Same split as `identity.ts`/`resolve.ts`, for the same reason — the format's
 * correctness has to be checkable without a filesystem.
 *
 * **Streamed cell at a time.** The places are read in cell-major order and one tile is written before the
 * next is opened, so peak memory is one cell rather than 225,000 places carrying descriptions. What is
 * held for the whole run is the interning dictionary, the per-cell index entries, and the entity id map —
 * all small, all ids and counts.
 *
 * **Atomic from the consumer's point of view.** Tiles, then geometry, then `index.json`, then `dict.json`,
 * then the signed manifest, and `latest.json` **last** — the one mutable file in a volume (§1). A reader
 * that arrives mid-publish either sees the previous version or a version it has not been pointed at yet;
 * it never sees a manifest naming a tile that is not there.
 */
import {
  blobPath,
  geomTilePath,
  hashText,
  latestJson,
  manifestSigningInput,
  tilePath,
  withAlgorithm,
  type CellSummary,
  type CellTile,
  type FileRef,
  type GeometryTile,
} from "@beaconsgg/atlas-volume";
import { PLACE_FULL_PX, PLACE_THUMB_PX } from "@beaconsgg/protocol-types";
import {
  accountFromMnemonic,
  createRecoveryPhrase,
  signUtf8,
  type Account,
} from "@beaconsgg/identity";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  dictJson,
  geometryFor,
  indexJson,
  manifestBody,
  newBuildState,
  tileRecord,
  type Clamps,
  type EntityRefs,
} from "./volume";
import { SOURCE_TERMS } from "./fields";
import type { Querier } from "./store";
import {
  claimRevision,
  completePublish,
  demoteMissingBlobs,
  fetchMergedPlaces,
  mergeCoverage,
  readEntityRefs,
  readInputs,
  removedPlaces,
  sourcesInUse,
  withheldByReview,
} from "./store";

/** Places per read. Cell-major, so a page spans a handful of tiles. */
const PAGE = 2_000;

/** Where media lives relative to a version directory — outside it, and shared across versions (§1). */
const MEDIA_BASE = "../media/";

/** Refuse a key file anyone but its owner can read — the server's `FileKeyProvider` rule. */
const OWNER_ONLY_MASK = 0o077;

export interface PublishOptions {
  volume: string;
  version: string;
  outDir: string;
  dryRun: boolean;
  account: Account;
  now: () => string;
  log: (message: string) => void;
}

export interface PublishReport {
  volume: string;
  version: string;
  revision: number;
  publisher: string;
  places: number;
  cells: number;
  geometryCells: number;
  bytes: number;
  manifestHash: string;
  /** Distinct photos referenced, and their bytes — derived from the tiles, so `verify` can disagree. */
  media: number;
  mediaBytes: number;
  /**
   * Photos a tile referenced whose blob was not on disk, dropped rather than published as a broken hash.
   *
   * Should be zero. Non-zero means `media_files` and `media/` have diverged — the database is in a container
   * volume and the blobs are on a host bind mount, so a `rm -rf published/media` or a DB restore parts them.
   */
  missingBlobs: number;
  /**
   * `media_files` rows put back on the retry ledger because their blob was gone — the fix, not the finding.
   *
   * Counted apart from `missingBlobs` because they measure different things: that one counts *references*
   * across places, this one counts *files*, and one file on 200 places is 400 references. Zero while
   * `missingBlobs` is not means nothing was demoted, which is what makes `--retry` the wrong advice — see
   * `publishLines`.
   */
  demotedFiles: number;
  clamps: Clamps;
  dictionary: { categories: number; subcategories: number; credits: number; sources: number };
  /**
   * What the review console withheld from this volume.
   *
   * Reported because a suppression makes the published count differ from what `merge` produced, and a
   * volume quietly smaller than the database is exactly the silent divergence this pipeline refuses.
   */
  withheld: { places: number; files: number; pairs: number };
}

/**
 * Load the publisher's identity from `CARTOGRAPHER_KEY_FILE`.
 *
 * A file rather than an environment variable because this key is **long-lived in a way the rest of the
 * pipeline is not**: operators pin its `did:key` in their own configuration, so losing or rotating it
 * means every consumer must reconfigure before it will accept a new volume. An env var is visible to
 * `docker inspect` and anything that dumps the environment.
 *
 * Fail-closed, and no unsigned mode: a volume nobody can verify is one a server is specified never
 * to read (`apps/atlas/doc/spec/beacon-integration.md` §2), so producing one would only create a
 * file that looks publishable.
 */
export function loadAccount(env: Record<string, string | undefined>): Account {
  const path = env["CARTOGRAPHER_KEY_FILE"];
  if (!path) {
    throw new Error(
      "CARTOGRAPHER_KEY_FILE is not set — publishing needs the volume signing key, and there is no " +
        "unsigned mode (a volume from an unconfigured publisher is never read). Create one with a " +
        "BIP39 recovery phrase and `chmod 600` it.",
    );
  }
  assertOwnerOnly(path);
  return accountFromMnemonicFile(path);
}

function assertOwnerOnly(path: string): void {
  const mode = statSync(path).mode & 0o777;
  // A platform with no POSIX permission bits has nothing to enforce; skipping beats a false alarm.
  if (mode === 0) return;
  if ((mode & OWNER_ONLY_MASK) !== 0) {
    throw new Error(
      `refusing key file with insecure permissions ${mode.toString(8).padStart(3, "0")} (${path}); ` +
        `a signing key must not be group/world-readable — run \`chmod 600 ${path}\``,
    );
  }
}

function accountFromMnemonicFile(path: string): Account {
  // Synchronous: this happens once, before any work, and the permission check above already had to stat
  // synchronously to be a gate rather than a race.
  const phrase = readFileSync(path, "utf8").trim();
  if (phrase === "") throw new Error(`key file is empty: ${path}`);
  // `accountFromMnemonic` validates the BIP39 checksum and throws on a malformed phrase.
  return accountFromMnemonic(phrase);
}

export interface KeygenReport {
  path: string;
  /** The public identity importers pin — confirmed on the console preview at first import. */
  did: string;
  /** False when the file already existed: nothing was written, and `did` is the existing key's. */
  created: boolean;
}

/**
 * Create the volume signing key `loadAccount` reads — the operator command that replaces generating a
 * BIP39 phrase by hand and remembering the permission rules.
 *
 * **Refuses an existing file, and reports its `did` instead.** This key is the one artifact here whose
 * replacement is worse than its absence: consumers pin the did, so silently overwriting it would strand
 * every volume the old key signed while everything on this side kept looking fine. Rotation is therefore a
 * deliberate act — delete the file yourself — and the refusal doubles as "what is my did again?", which is
 * otherwise only printed at publish time.
 *
 * Written with mode 0600 in the open call, not chmod'd after: `loadAccount` refuses a group/world-readable
 * key, and a create-then-chmod has a window where the file exists in the shape it will later refuse.
 */
export function keygen(
  env: Record<string, string | undefined>,
  flags: { file?: string },
): KeygenReport {
  const path = flags.file ?? env["CARTOGRAPHER_KEY_FILE"];
  if (!path) {
    throw new Error(
      "keygen needs --file <path> (or CARTOGRAPHER_KEY_FILE set) — the file the publish stage will read.",
    );
  }
  if (existsSync(path)) {
    // Reading it back validates the phrase too: an existing file that is not a valid key gets
    // `accountFromMnemonic`'s error rather than a misleading "already exists, here is its did".
    return { path, did: accountFromMnemonicFile(path).did, created: false };
  }
  const phrase = createRecoveryPhrase();
  // No `mkdir -p`: for the one file whose output says "back it up; it cannot be regenerated", a typo'd
  // parent should be ENOENT, not a silently materialized directory tree the backup then misses.
  writeFileSync(path, `${phrase}\n`, { mode: 0o600, flag: "wx" });
  return { path, did: accountFromMnemonic(phrase).did, created: true };
}

/** An entity the id map has no row for — impossible via the schema's FK, and harmless if it happened. */
const EMPTY_REFS: EntityRefs = { upstream: [], aliases: [] };

/**
 * Build and write one volume.
 *
 * Refuses to run on an incomplete merge, and that refusal is the point rather than caution: a volume
 * missing places is not a smaller volume, it is one whose next `verify --previous` reads those places as
 * **vanished** — the assertion that exists to stop a publish from retiring places on every server that
 * imported the last one.
 */
export async function publish(db: Querier, opts: PublishOptions): Promise<PublishReport> {
  // The completeness gate below counts `merged_places`, which a review suppression deliberately does
  // NOT touch — the gate asks "did merge run over everything", not "what ships". The withheld counts
  // are read alongside so the report can explain the difference the volume will show.
  const withheld = await withheldByReview(db);
  // Named in the manifest, not just counted: `verify --previous` and a server's retirement sweep both
  // have to tell "a curator removed this" from "a place vanished", and neither can ask this database.
  const removedPlaceIds = await removedPlaces(db);
  const coverage = await mergeCoverage(db);
  if (coverage.merged < coverage.expected) {
    throw new Error(
      `merge is incomplete: ${coverage.merged} merged places for ${coverage.expected} entities ` +
        `(${coverage.expected - coverage.merged} missing). Run \`cartographer merge\` to completion — ` +
        "publishing a partial merge emits a volume missing places, which the next verify reads as places " +
        "that vanished.",
    );
  }
  if (coverage.expected === 0) {
    throw new Error("nothing to publish — no entities hold members. Run resolve, then merge.");
  }

  // Every source in the data must have declared terms, checked **before** a revision is claimed or a byte
  // is written. `volume.ts` throws on an undeclared source too, but it discovers that in the innermost
  // loop of the write path — at place 40,000, with 30,000 tiles already on disk and a revision burnt. One
  // query names all of them up front instead of the first one hit.
  const undeclared = await undeclaredSources(db);
  if (undeclared.length > 0) {
    throw new Error(
      `${undeclared.length} source(s) in merged_places have no redistribution terms: ` +
        `${undeclared.join(", ")}. Add them to SOURCE_TERMS in fields.ts — a published field whose ` +
        "licence nobody declared cannot be corrected, because a version's bytes never change.",
    );
  }

  // Ids and nothing else, for every entity, read once. Joining these onto the paged place read would
  // re-run two aggregations per page — the mistake `readPriorEntities` itself documents.
  const refs = await readEntityRefs(db);
  opts.log(`publishing ${coverage.merged} places, ${refs.size} entities in the id map`);

  const revision = opts.dryRun ? 0 : await claimRevision(db, opts.volume, opts.version);
  const versionDir = join(opts.outDir, opts.version);
  const cellsDir = join(versionDir, "cells");
  if (!opts.dryRun) await mkdir(cellsDir, { recursive: true });

  const state = newBuildState();
  const summaries: CellSummary[] = [];
  let bytes = 0;
  let geometryCells = 0;

  const write = async (path: string, value: unknown): Promise<FileRef> => {
    // `JSON.stringify`, not `canonicalJson`: the tile bytes are what the hash covers, and the reader
    // hashes the file it fetched. Key order here is our own insertion order, which is deterministic.
    const text = JSON.stringify(value);
    const ref: FileRef = {
      path,
      hash: hashText(text),
      bytes: Buffer.byteLength(text, "utf8"),
    };
    if (!opts.dryRun) await writeFile(join(versionDir, path), text, "utf8");
    bytes += ref.bytes;
    return ref;
  };

  // Every media hash the tiles actually reference, and the bytes on disk behind them.
  //
  // **Derived from the tree, not counted as files are written.** A re-publish of a version writes
  // no new blobs — they are already there, content-addressed — so a running total would make the
  // manifest body, and therefore its signature, differ between two publishes of the same version.
  // `apps/atlas/doc/spec/volume-format.md` §10 says a version's bytes never change, and §5 measured
  // that property holding. Deriving it also keeps `verify`'s check a real one rather than a second
  // reading of one counter, exactly as `places` already works. Keyed by hash so a logo on 200
  // places is stat'd once — and the *missing* case is cached too, or a genuinely absent blob is
  // re-stat'd per referencing place.
  const mediaSizes = new Map<string, number | undefined>();
  let mediaBytes = 0;
  let missingBlobs = 0;

  for await (const group of cellGroups(db)) {
    const tile: CellTile = { cell: group.cell, revision, places: [] };
    const geometry: GeometryTile["geometry"] = {};
    for (const place of group.places) {
      const record = tileRecord(state, place, refs.get(place.entityId) ?? EMPTY_REFS);
      // Stat before referencing. `media/` is a host bind mount while `media_files` lives in a container
      // volume, so "the database says published, the file is gone" is one `rm -rf` away — and unchecked, a
      // signed manifest would name files that do not exist, with `verify` only finding out after a revision
      // was claimed and 51,000 tiles were written. Dropped and counted, like a geometry that exceeds a cap.
      if (record.media) {
        let complete = true;
        for (const entry of record.media) {
          if (!mediaSizes.has(entry.hash)) {
            const size = await blobSize(opts.outDir, entry.hash);
            mediaSizes.set(entry.hash, size);
            if (size !== undefined) mediaBytes += size;
          }
          if (mediaSizes.get(entry.hash) === undefined) {
            missingBlobs += 1;
            complete = false;
          }
        }
        // Whole pairs only: a surviving `full` whose `thumb` vanished would break the positional contract.
        if (!complete) delete record.media;
      }
      tile.places.push(record);
      const shape = geometryFor(state, place);
      if (shape) geometry[place.entityId] = shape;
    }

    const tileRef = await write(tilePath(group.cell), tile);
    const summary: CellSummary = {
      cell: group.cell,
      places: tile.places.length,
      hash: tileRef.hash,
      bytes: tileRef.bytes,
    };
    if (Object.keys(geometry).length > 0) {
      const geomRef = await write(geomTilePath(group.cell), {
        cell: group.cell,
        revision,
        geometry,
      } satisfies GeometryTile);
      summary.geomHash = geomRef.hash;
      summary.geomBytes = geomRef.bytes;
      geometryCells += 1;
    }
    summaries.push(summary);
    if (summaries.length % 500 === 0) opts.log(`wrote ${summaries.length} cells`);
  }

  // One walk of `mediaSizes`, answering both questions it is asked. They were two complementary filters in
  // two idioms — a `[...map].filter().map()` here and a hand-rolled counting loop at the bottom of the file,
  // called twice — so three passes produced three numbers that nothing made add up.
  const missingHashes: string[] = [];
  let publishedMedia = 0;
  for (const [hash, size] of mediaSizes) {
    if (size === undefined) missingHashes.push(hash);
    else publishedMedia += 1;
  }

  const index = await write("index.json", indexJson(summaries));
  const dict = await write("dict.json", dictJson(state.dict));

  const body = manifestBody(state, summaries, {
    volume: opts.volume,
    version: opts.version,
    revision,
    createdAt: opts.now(),
    publisher: opts.account.did,
    index,
    dict,
    mediaBase: MEDIA_BASE,
    inputs: (await readInputs(db)).map((input) => ({
      source: input.source,
      artifact: input.artifact,
      // Prefixed here, because `build_inputs` stores the bare digest: `hashFile` streams a multi-GB
      // extract and returns base64url the way every digest the platform *prints* is written, while
      // `apps/atlas/doc/spec/volume-format.md` §2 requires every hash a volume *publishes* to name
      // its algorithm. Unprefixed, a real manifest carried `index.hash: "sha256:…"` beside
      // `inputs[0].hash: "wrKM_9qb…"` — the one field an auditor uses to tie a volume back to its
      // source extract, in bytes that never change.
      hash: withAlgorithm(input.hash),
    })),
    // From `@beaconsgg/protocol-types`, which is what stage 4's re-encoder spends too — the coupling this file
    // used to warn about, discharged. Still not read from `ServerConfig`: those are operator-overridable, and
    // `mediaProfile` exists precisely so a server on other sizes can see the mismatch and decide.
    thumbPx: PLACE_THUMB_PX,
    fullPx: PLACE_FULL_PX,
    mediaCount: publishedMedia,
    mediaBytes,
    retired: removedPlaceIds,
  });

  // Signed over the JCS canonicalization of the manifest **minus** the signature — the shape every other
  // signed document in the repo uses (`signDescriptor`), so a consumer verifies with code it already has.
  const signature = signUtf8(manifestSigningInput(body), opts.account.root.privateKey);
  const manifestText = JSON.stringify({ ...body, signature });
  const manifestHash = hashText(manifestText);

  if (!opts.dryRun) {
    await writeFile(join(versionDir, "manifest.json"), manifestText, "utf8");
    // Last, and only now: everything it points at exists and hashes correctly.
    await writeFile(
      join(opts.outDir, "latest.json"),
      JSON.stringify(latestJson(opts.version)),
      "utf8",
    );
    await completePublish(
      db,
      revision,
      {
        volume: opts.volume,
        version: opts.version,
        manifestHash,
        places: body.places,
        cells: summaries.length,
      },
      opts.now(),
    );
  }

  // After the volume is written, not before: this publish is valid — it simply carries fewer photos — and
  // the database should be corrected whether or not anything downstream acts on it. A dry run demotes
  // nothing, which `publishLines` has to say rather than printing advice that would then do nothing.
  const demotedFiles = opts.dryRun ? 0 : await demoteMissingBlobs(db, missingHashes, opts.now());

  return {
    volume: opts.volume,
    version: opts.version,
    revision,
    publisher: opts.account.did,
    places: body.places,
    cells: summaries.length,
    geometryCells,
    bytes: bytes + Buffer.byteLength(manifestText, "utf8"),
    manifestHash,
    media: publishedMedia,
    mediaBytes,
    missingBlobs,
    demotedFiles,
    clamps: state.clamps,
    dictionary: {
      categories: state.dict.categories.values.length,
      subcategories: state.dict.subcategories.values.length,
      credits: state.dict.credits.values.length,
      sources: state.dict.sources.values.length,
    },
    withheld,
  };
}

/** Sources present in the data that {@link SOURCE_TERMS} has no entry for. */
async function undeclaredSources(db: Querier): Promise<string[]> {
  return (await sourcesInUse(db)).filter((id) => !(id in SOURCE_TERMS));
}

/**
 * The merged places, grouped into whole cells.
 *
 * A generator so the caller can write each tile and let it go. The regrouping across a page boundary is
 * the fiddly part: a page ends mid-cell, so the trailing partial group is carried into the next page
 * rather than emitted — emitting it would write the same cell twice, each time with some of its places.
 */
async function* cellGroups(
  db: Querier,
): AsyncGenerator<{ cell: string; places: Awaited<ReturnType<typeof fetchMergedPlaces>> }> {
  let after: { cell: string; entityId: string } | undefined;
  let pending: { cell: string; places: Awaited<ReturnType<typeof fetchMergedPlaces>> } | undefined;

  for (;;) {
    const page = await fetchMergedPlaces(db, { limit: PAGE, ...(after ? { after } : {}) });
    if (page.length === 0) break;
    for (const place of page) {
      if (pending && pending.cell !== place.cell) {
        yield pending;
        pending = undefined;
      }
      pending ??= { cell: place.cell, places: [] };
      pending.places.push(place);
    }
    // Non-empty by the check above, so this cannot be undefined.
    const last = page[page.length - 1]!;
    after = { cell: last.cell, entityId: last.entityId };
    if (page.length < PAGE) break;
  }
  if (pending) yield pending;
}

/**
 * The size of a media blob on disk, or nothing when it is not there.
 *
 * A `stat` per referenced entry — ~17k of them for a full volume, milliseconds — and it is what makes
 * `manifest.media.bytes` a measurement rather than a claim the database made.
 */
async function blobSize(outDir: string, hash: string): Promise<number | undefined> {
  try {
    return (await stat(blobPath(outDir, hash))).size;
  } catch {
    return undefined;
  }
}
