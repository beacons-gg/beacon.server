/**
 * The volume tree as a file list — the one enumeration `pack` zips and `upload` ships.
 *
 * Enumerated from the SIGNED index, never from a directory listing: a stray file in `cells/` must
 * not travel, and a tile the index names but disk lost must fail loudly before anyone publishes a
 * tree a consumer would refuse. Only the media **this version references** rides along, not the
 * whole shared `media/` pool: blobs are shared across versions on disk, and shipping another
 * version's photos would silently bloat the artifact with bytes the manifest never vouches for. The
 * reference list comes from the tiles — the same derivation `publish` uses for `manifest.media` —
 * so this walk cannot disagree with what was signed.
 *
 * `latest.json` is **generated pointing at this version** rather than copied: the pool's latest may
 * be a different version, and a self-describing artifact must describe itself. Through the shared
 * builder, so no sink can spell the one mutable file differently from `publish`.
 */
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  blobPath,
  geomTilePath,
  latestJson,
  mediaPath,
  tilePath,
  type CellTile,
  type ManifestBody,
  type VolumeIndex,
} from "@beaconsgg/atlas-volume";

/**
 * One file of the tree. `path` is tree-relative (the zip path, the bucket key). A union on `kind`,
 * so "generated content XOR on-disk source" is checked where a sink branches, never hoped.
 */
export type VolumeFile =
  | { path: string; kind: "latest"; content: Buffer }
  | {
      path: string;
      kind: "version" | "media";
      disk: string;
      /** On-disk size, media only — an uploader's ContentLength and the report's bytes. */
      bytes?: number;
    };

export interface VolumeTree {
  files: VolumeFile[];
  /** The media blobs' MIME type, from the signed manifest's own profile — never a guess. */
  mediaFormat: string;
  /** Distinct photos included. */
  media: number;
  /** Photos the tiles reference whose blob is not on disk — counted, never listed. */
  missing: number;
}

/**
 * Tiles read at once.
 *
 * These are ~1.3 KB files and there are 50,989 of them in a us-west version, so the walk is bound by
 * round trips rather than by bytes — measured, 32-way takes it from 3.6 s to 1.6 s warm, and the
 * gap widens cold and over a bind mount. (Measured and rejected: scanning the raw bytes for hashes
 * instead of parsing saved 0.3 s of the 3.6 — the parse was never the cost.)
 */
const CONCURRENT_TILES = 32;

/**
 * Every photo hash a version's tiles reference — index and tiles, and nothing else.
 *
 * Separate from {@link volumeTree} because `prune` needs *only* this, and the rest of that walk is
 * expensive: it `stat`s all 53,719 referenced blobs to attach sizes and count the missing, which is
 * a third of the run's file operations spent on an answer a prune throws away.
 *
 * There is no cheaper source. The manifest records `{base, count, bytes}` and no hashes, the index
 * carries none, and asking the database would answer a **different question** — today's opinion
 * rather than what that version actually shipped, which is the one thing a prune must not confuse.
 */
export async function volumeMediaHashes(outDir: string, version: string): Promise<Set<string>> {
  const versionDir = join(outDir, version);
  const index = JSON.parse(await readFile(join(versionDir, "index.json"), "utf8")) as VolumeIndex;
  return hashesFromTiles(versionDir, index.cells);
}

/** The tile walk itself, bounded — shared so the two callers cannot read the tiles differently. */
async function hashesFromTiles(
  versionDir: string,
  cells: readonly VolumeIndex["cells"][number][],
): Promise<Set<string>> {
  const hashes = new Set<string>();
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENT_TILES, cells.length) }, async () => {
      for (let at = next++; at < cells.length; at = next++) {
        const cell = cells[at]!;
        const text = await readFile(join(versionDir, tilePath(cell.cell)), "utf8");
        for (const record of (JSON.parse(text) as CellTile).places) {
          for (const entry of record.media ?? []) hashes.add(entry.hash);
        }
      }
    }),
  );
  // The caller sorts, so the arrival order this introduces never reaches a file list.
  return hashes;
}

export async function volumeTree(outDir: string, version: string): Promise<VolumeTree> {
  const versionDir = join(outDir, version);
  const files: VolumeFile[] = [
    {
      path: "latest.json",
      content: Buffer.from(JSON.stringify(latestJson(version))),
      kind: "latest",
    },
  ];

  const index = JSON.parse(await readFile(join(versionDir, "index.json"), "utf8")) as VolumeIndex;
  const manifest = JSON.parse(
    await readFile(join(versionDir, "manifest.json"), "utf8"),
  ) as ManifestBody;
  for (const name of ["manifest.json", "index.json", "dict.json"]) {
    files.push({ path: `${version}/${name}`, disk: join(versionDir, name), kind: "version" });
  }
  for (const cell of index.cells) {
    files.push({
      path: `${version}/${tilePath(cell.cell)}`,
      disk: join(versionDir, tilePath(cell.cell)),
      kind: "version",
    });
    if (cell.geomHash !== undefined) {
      files.push({
        path: `${version}/${geomTilePath(cell.cell)}`,
        disk: join(versionDir, geomTilePath(cell.cell)),
        kind: "version",
      });
    }
  }
  const hashes = await hashesFromTiles(versionDir, index.cells);

  let media = 0;
  let missing = 0;
  for (const hash of [...hashes].sort()) {
    const disk = blobPath(outDir, hash);
    try {
      const size = await stat(disk);
      files.push({ path: `media/${mediaPath(hash)}`, disk, kind: "media", bytes: size.size });
      media += 1;
    } catch {
      missing += 1; // publish already reported and demoted these; the sink just states the number
    }
  }
  return { files, mediaFormat: manifest.mediaProfile.format, media, missing };
}
