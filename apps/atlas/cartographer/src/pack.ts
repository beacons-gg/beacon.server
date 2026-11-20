/**
 * `pack` — one published version as a single shareable file.
 *
 * The artifact Atlas exists to produce is one nobody has to host: a signed volume moves as a zip,
 * gets handed around, and a Beacon server imports it through the admin console's upload. The zip is
 * the volume tree **verbatim** — `latest.json`, the version directory, `media/` — so the importer's
 * reader walks it exactly as it would a hosted tree, and `verify` on an extracted copy still passes.
 * What goes in is `tree.ts`'s enumeration, shared with `upload`, so the two artifacts cannot drift.
 */
import { createWriteStream } from "node:fs";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { ZipFile } from "yazl";
import { volumeTree } from "./tree";

export interface PackReport {
  version: string;
  /** The archive written. */
  archive: string;
  files: number;
  /** Distinct photos included. */
  media: number;
  /** Photos the tiles reference whose blob was not on disk — packed anyway is not an option. */
  missing: number;
  bytes: number;
}

export interface PackOptions {
  outDir: string;
  version: string;
  /** Where the zip lands; defaults beside the version dir as `<volume-dir>/<version>.zip`. */
  archive?: string;
  log: (message: string) => void;
}

export async function pack(opts: PackOptions): Promise<PackReport> {
  const archive = opts.archive ?? join(opts.outDir, `${opts.version}.zip`);
  const tree = await volumeTree(opts.outDir, opts.version);

  const zip = new ZipFile();
  for (const file of tree.files) {
    if (file.kind === "latest") zip.addBuffer(file.content, file.path);
    // No compression for blobs: they are already WebP.
    else zip.addFile(file.disk, file.path, { compress: file.kind !== "media" });
  }

  zip.end();
  await new Promise<void>((resolve, reject) => {
    zip.outputStream
      .pipe(createWriteStream(archive))
      .on("close", () => resolve())
      .on("error", reject);
  });
  const bytes = (await stat(archive)).size;
  opts.log(`packed ${tree.files.length} files into ${archive}`);
  return {
    version: opts.version,
    archive,
    files: tree.files.length,
    media: tree.media,
    missing: tree.missing,
    bytes,
  };
}
