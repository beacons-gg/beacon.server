/**
 * Extracting an uploaded volume archive — the one moment untrusted bytes become a directory tree.
 *
 * The zip's *contents* are verified downstream (`openVolume` checks the signature and hash chain),
 * but zip **structure** is attacker-shaped before any of that runs: entry names are just strings,
 * and "../../etc/cron.d/x" is a valid one. So extraction enforces containment and refuses links
 * outright, and everything else about the archive is left for the manifest chain to judge.
 */
import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { pipeline } from "node:stream/promises";
import yauzl from "yauzl";
import { containedPath } from "./reader";

/** Extract `zipPath` into `destDir`, refusing traversal, absolute paths, and symlinks. */
export async function extractVolumeArchive(zipPath: string, destDir: string): Promise<void> {
  const root = containedPath(destDir, destDir, ".");
  await mkdir(root, { recursive: true });

  const zip = await new Promise<yauzl.ZipFile>((res, rej) => {
    // lazyEntries so one bad entry stops the walk immediately instead of racing the rejection.
    yauzl.open(zipPath, { lazyEntries: true }, (err, file) => (err ? rej(err) : res(file)));
  });

  // A 67k-entry volume repeats a handful of parent dirs (cells/, 2-char media shards) tens of
  // thousands of times — one async mkdir round-trip per entry was ~5-10% of a measured extraction.
  const madeDirs = new Set<string>();
  const ensureDir = async (dir: string): Promise<void> => {
    if (madeDirs.has(dir)) return;
    await mkdir(dir, { recursive: true });
    madeDirs.add(dir);
  };

  const extractEntry = async (entry: yauzl.Entry): Promise<void> => {
    const name = entry.fileName;
    if (name.endsWith("/")) {
      await ensureDir(containedPath(root, root, name));
      return;
    }
    // A symlink extracted then followed reads outside the tree with contained() none the wiser.
    // Mode lives in the upper 16 bits of externalFileAttributes on unix-built zips.
    const mode = entry.externalFileAttributes >>> 16;
    if ((mode & 0o170000) === 0o120000) {
      throw new Error(`archive entry is a symlink, refused: ${name}`);
    }
    const target = containedPath(root, root, name);
    await ensureDir(dirname(target));
    const stream = await new Promise<NodeJS.ReadableStream>((sres, srej) =>
      zip.openReadStream(entry, (err, s) => (err ? srej(err) : sres(s))),
    );
    await pipeline(stream, createWriteStream(target));
  };

  try {
    await new Promise<void>((res, rej) => {
      zip.on("error", rej);
      zip.on("end", res);
      // One continuation point: an entry extracts, then the walk advances — or the whole promise
      // rejects and the lazyEntries walk stops with it.
      zip.on("entry", (entry: yauzl.Entry) => {
        extractEntry(entry).then(() => zip.readEntry(), rej);
      });
      zip.readEntry();
    });
  } finally {
    zip.close();
  }
}
