/**
 * `prune` — delete photo bytes nothing can ever publish again.
 *
 * The media pool is the largest thing this builder produces (3.5 GB against 163 MB of tiles on
 * us-west) and it only ever grows: every crawl adds, nothing removes. Three ways a blob stops
 * earning its place, and only the first is visible from the database alone:
 *
 * - **A reviewer refused it** — rejected outright, unlinked from its last place, or the place
 *   itself removed. The row stays `published` and keeps its hashes; it simply publishes nowhere.
 * - **A row lost its hashes.** `refusedRow` rebuilds a row *without* `thumb_hash`/`full_hash`, so a
 *   `published` → `rejected` transition (a `--refresh` where the licence changed) leaves the bytes
 *   on disk with **nothing in the database pointing at them**. They cannot be found by querying,
 *   only by diffing the disk against the claims. Same for a re-encode that produced a new hash.
 * - **Nothing references the file any more** — its place's reference set changed under it.
 *
 * So the sweep is a **disk-versus-claims diff**, not a query for rejected rows: enumerate what is on
 * disk, subtract everything anything still claims, delete the remainder. That catches strictly more
 * than the database can name, and it cannot delete something a row still points at.
 *
 * ## The two claims, and why a published version is one of them
 *
 * A blob is kept if **either** the database earns it ({@link mediaBlobClaims}) or a **published
 * version on disk references it**. The second is easy to forget and expensive to get wrong: a
 * version's manifest vouches for its photos by hash, so pruning one breaks `verify`, `pack` and
 * `upload` for that version permanently — the bytes are gone and the signature still demands them.
 * The reference set comes from {@link volumeTree}, the same signed enumeration `pack` and `upload`
 * ship, so this cannot disagree with what a consumer would ask for.
 *
 * ## What it will not do without being told
 *
 * A file with **no place link at all** is left alone unless `--unlinked` says otherwise, because
 * unlinked is also the state of a crawl page whose file rows have committed and whose links have
 * not — `media` writes rows every 50 files and links once per 500-entity page. Run an unguarded
 * prune beside a live crawl and it deletes the bytes of photos that are seconds from being linked.
 * Nothing is lost permanently (the next `media` relinks, `publish` demotes the missing blob, and
 * `media --retry` refetches) but it converts a free relink into a re-download, which is the whole
 * cost this stage exists to avoid paying twice.
 */
import { mediaBareHash } from "@beaconsgg/atlas-volume";
import { readdir, rm, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { mediaBlobClaims, type Querier } from "./store";
import { volumeMediaHashes } from "./tree";

export interface PruneReport {
  /** Blobs found under `<out>/media`. */
  onDisk: number;
  /** Kept because a published version on disk references them. */
  keptByVolume: number;
  /** Kept because a `media_files` row still earns them. */
  keptByDatabase: number;
  /** Deleted (or, under `--dry-run`, what would be). */
  removed: number;
  /** Bytes reclaimed. */
  bytes: number;
  /** Published versions whose references were read as claims. */
  versions: string[];
  /**
   * Files under `media/` that are not blobs at all.
   *
   * Counted and **never deleted**: this directory is the operator's, a stray file is not evidence
   * of anything, and a sweep that tidied up beyond its own contract is one nobody can run safely.
   */
  strays: number;
  dryRun: boolean;
  includeUnlinked: boolean;
}

export interface PruneOptions {
  outDir: string;
  /** Also prune blobs whose file has no place link — see the note above before setting it. */
  includeUnlinked: boolean;
  dryRun: boolean;
  log: (message: string) => void;
}

export async function prune(db: Querier, opts: PruneOptions): Promise<PruneReport> {
  // **Both claims are keyed on the bare hash, never on a path.** A blob has at least three path
  // spellings in this codebase — `blobPath` concatenates, `path.join` normalizes, the walker builds
  // a third — and they agree for `/out` while `./out` makes `blobPath` say `./out/media/…` against
  // the walker's `out/media/…`. Comparing those strings would have every membership test miss and
  // the sweep delete blobs the database claims. The hash is what both sides actually mean.
  const versions = await publishedVersions(opts.outDir);
  const protectedByVolume = new Set<string>();
  for (const version of versions) {
    // The tiles' references, not the blobs on disk: a reference whose bytes are missing is still a
    // reference, and `media --retry` will put them back. Asking `volumeTree` would additionally
    // `stat` all 53,719 of them — a third of this run's file operations, for an answer discarded.
    const hashes = await volumeMediaHashes(opts.outDir, version);
    for (const hash of hashes) protectedByVolume.add(mediaBareHash(hash));
    opts.log(`${version}: ${hashes.size} photo(s) referenced, kept`);
  }
  const keptByDatabase = new Set(await mediaBlobClaims(db, opts.includeUnlinked));

  const { blobs, strays } = await mediaOnDisk(join(opts.outDir, "media"));

  const report: PruneReport = {
    onDisk: 0,
    keptByVolume: 0,
    keptByDatabase: 0,
    removed: 0,
    bytes: 0,
    versions,
    strays,
    dryRun: opts.dryRun,
    includeUnlinked: opts.includeUnlinked,
  };

  for (const path of blobs) {
    const hash = basename(path, ".webp");
    report.onDisk += 1;
    if (protectedByVolume.has(hash)) {
      report.keptByVolume += 1;
      continue;
    }
    if (keptByDatabase.has(hash)) {
      report.keptByDatabase += 1;
      continue;
    }
    // Size before removal, and tolerated if it vanishes: a concurrent crawl writing this very blob
    // is exactly the race `--unlinked` warns about, and a prune must not die on it.
    try {
      report.bytes += (await stat(path)).size;
    } catch {
      continue;
    }
    if (!opts.dryRun) await rm(path, { force: true });
    report.removed += 1;
  }
  return report;
}

/**
 * Every version directory under `--out` that has a manifest.
 *
 * Directory listing rather than `latest.json`, deliberately: `latest` names one version and a prune
 * must protect **all** of them, because any version still on disk is one an operator can still be
 * asked to `verify`, `pack` or `upload`.
 */
async function publishedVersions(outDir: string): Promise<string[]> {
  const found: string[] = [];
  let entries;
  try {
    entries = await readdir(outDir, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === "media") continue;
    try {
      await stat(join(outDir, entry.name, "manifest.json"));
      found.push(entry.name);
    } catch {
      // Not a published version — a scratch directory, a half-deleted one. Not ours to judge.
    }
  }
  return found.sort();
}

/**
 * The pool as it is on disk: the blob paths, and how many files were not blobs.
 *
 * Returns rather than yields, and counts rather than mutating a report the caller is still
 * assembling — a directory walker that also files a report cannot be read or reused without one.
 * Laziness would buy nothing anyway: both claim sets are already fully resident before the walk.
 */
async function mediaOnDisk(mediaDir: string): Promise<{ blobs: string[]; strays: number }> {
  const blobs: string[] = [];
  let strays = 0;
  let shards;
  try {
    shards = await readdir(mediaDir, { withFileTypes: true });
  } catch {
    return { blobs, strays }; // No pool yet — nothing to prune, and not an error.
  }
  for (const shard of shards) {
    if (!shard.isDirectory()) {
      strays += 1;
      continue;
    }
    for (const entry of await readdir(join(mediaDir, shard.name), { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".webp")) strays += 1;
      else blobs.push(join(mediaDir, shard.name, entry.name));
    }
  }
  return { blobs, strays };
}
