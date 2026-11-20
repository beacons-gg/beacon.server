/**
 * Reading a volume from wherever it happens to be — the transport seam under every consumer.
 *
 * A volume is a signed static artifact, so *where it came from* is deliberately not a trust input:
 * `openVolume` runs the same verification chain (`apps/atlas/doc/spec/volume-format.md` §8 —
 * signature, then what the manifest says about itself, then the files it hashes) over an
 * operator-supplied URL and an uploaded archive alike. The reader answers "give me these bytes";
 * this module answers "may they be believed".
 *
 * Lives here, not in a server app: the golden rule puts design logic in packages, and
 * `apps/atlas/doc/spec/beacon-integration.md` keeps connectors "pure mappers": a connector consumes
 * a *verified root*, it never establishes one.
 */
import { readFile } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { TAXONOMY_VERSION } from "@beaconsgg/place-taxonomy";
import { PLACE_FULL_PX, PLACE_THUMB_PX } from "@beaconsgg/protocol-types";
import {
  CELL_PRECISION,
  VOLUME_FORMAT,
  mediaPath,
  mediaUrl,
  versionFromLatest,
  type CellSummary,
  type Dictionary,
  type Manifest,
  type VolumeIndex,
} from "./format";
import { checkManifest, hashText } from "./trust";

/**
 * One volume's bytes, wherever they live. `text` paths are relative to the **version directory**
 * (the one holding `manifest.json`), because that is the only address space the format defines —
 * every path a consumer asks for comes out of a verified manifest or is `manifest.json` itself.
 *
 * Exactly one of the media members is present: a hosted volume yields URLs for a fetcher to get,
 * a staged one yields the bytes themselves. Consumers branch on which exists rather than on a kind
 * string, so a third transport must say what it *provides*, not what it is called.
 */
export interface VolumeReader {
  text(path: string): Promise<string>;
  /** Where a media hash's bytes can be fetched — hosted volumes. `base` is `manifest.media.base`. */
  mediaUrl?(base: string, hashWithAlgorithm: string): string;
  /** The media hash's bytes themselves — staged archives. */
  mediaLoad?(base: string, hashWithAlgorithm: string): Promise<Buffer | undefined>;
  /** For error messages: where this volume came from, in the operator's own terms. */
  readonly describe: string;
}

/**
 * A hosted volume. `getText` is injected rather than fetched here because outbound HTTP policy
 * (pacing, timeouts, byte caps) is the server's, and this package must not grow its own.
 */
export function httpVolumeReader(
  versionUrl: string,
  getText: (url: string) => Promise<string>,
): VolumeReader {
  const base = versionUrl.replace(/\/+$/, "");
  return {
    text: (path) => getText(`${base}/${path}`),
    mediaUrl: (mediaBase, hash) => mediaUrl(base, mediaBase, hash),
    describe: base,
  };
}

/**
 * A staged archive, extracted to `rootDir` as the volume tree verbatim: `latest.json`, one or more
 * `<version>/` directories, `media/`. The version comes from the archive's own `latest.json` — the
 * artifact is self-describing, which is what lets an operator import a file with no side channel.
 *
 * **Every resolved path must stay under `rootDir`.** The paths come from a manifest that will be
 * signature-checked — but they are read *before* that check completes its chain, and an archive is
 * exactly the input an operator was handed by someone else. Containment is cheap; a traversal that
 * reads `/etc` because a zip said so is not.
 */
export async function dirVolumeReader(
  rootDir: string,
  label = "staged archive",
): Promise<VolumeReader> {
  const root = resolve(rootDir);
  const version = versionFromLatest(await readFile(resolve(root, "latest.json"), "utf8"));
  if (!version) throw new Error(`volume tree at ${rootDir} has no readable latest.json`);
  const versionDir = containedPath(root, root, version);

  return {
    text: async (path) => readFile(containedPath(root, versionDir, path), "utf8"),
    mediaLoad: async (mediaBase, hash) => {
      try {
        return await readFile(containedPath(root, versionDir, mediaBase + mediaPath(hash)));
      } catch {
        return undefined; // a photo the tree doesn't carry — dropped per entry, like a 404
      }
    },
    describe: `${label} (${version})`,
  };
}

/**
 * Resolve `path` against `from` and refuse anything that escapes `root` — the one traversal gate
 * both the reader and the archive extractor stand behind, so a hardening lands once.
 */
export function containedPath(root: string, from: string, path: string): string {
  const resolved = resolve(from, path);
  if (resolved !== root && !resolved.startsWith(root + sep)) {
    throw new Error(`archive path escapes the volume tree: ${path}`);
  }
  return resolved;
}

/** A volume's verified root — everything below the manifest is hash-chained to it. */
export interface VolumeRoot {
  manifest: Manifest;
  dict: Dictionary;
  index: Map<string, CellSummary>;
}

/**
 * Fetch and verify a volume's root, in `apps/atlas/doc/spec/volume-format.md` §8's order:
 * signature, then what the manifest says about itself, then the two files it hashes directly.
 * Everything below is hash-chained, so a signature over a few hundred bytes covers the whole tree —
 * a compromised host can deny content, never substitute it.
 *
 * `expectedPublisher` absent is **inspect mode**: the signature is verified against the did the
 * manifest itself names, so the caller can show an operator *who signed this* before anything is
 * trusted with a decision. An import must always pass the did the operator confirmed.
 */
export async function openVolume(
  reader: VolumeReader,
  opts: { expectedPublisher?: string; label: string; warn: (message: string) => void },
): Promise<VolumeRoot> {
  const manifestText = await reader.text("manifest.json");
  const checked = checkManifest(manifestText, opts.expectedPublisher);
  if (!checked.ok) {
    throw new Error(
      `${opts.label}: refusing volume at ${reader.describe} — ${checked.reason}: ${checked.detail}`,
    );
  }
  const manifest = checked.manifest;

  if (manifest.format !== VOLUME_FORMAT) {
    throw new Error(
      `${opts.label}: volume format ${manifest.format} is not one this server reads ` +
        `(this build understands ${VOLUME_FORMAT})`,
    );
  }
  // A mismatch is a documented behaviour rather than a coercion (§7): a *newer* taxonomy may carry
  // categories this reader has no case for; those places drop per-place downstream, not the run.
  if (manifest.taxonomy > TAXONOMY_VERSION) {
    opts.warn(
      `${opts.label}: volume built against taxonomy ${manifest.taxonomy}, this server understands ` +
        `${TAXONOMY_VERSION} — places whose category cannot be parsed will be dropped`,
    );
  }
  if (manifest.cellPrecision !== CELL_PRECISION) {
    throw new Error(
      `${opts.label}: volume tiles at precision ${manifest.cellPrecision}, this server chunks at ` +
        `${CELL_PRECISION} — one chunk would not be one tile`,
    );
  }
  // A profile mismatch is a warning, not a refusal (`apps/atlas/doc/spec/beacon-integration.md`
  // §5): bytes are ingested as published, never re-encoded — re-encoding would change the hash and
  // lose the verification.
  if (
    manifest.mediaProfile.thumbPx !== PLACE_THUMB_PX ||
    manifest.mediaProfile.fullPx !== PLACE_FULL_PX
  ) {
    opts.warn(
      `${opts.label}: volume publishes media at ${manifest.mediaProfile.thumbPx}/` +
        `${manifest.mediaProfile.fullPx}px, this server's profile is ${PLACE_THUMB_PX}/${PLACE_FULL_PX} — ` +
        "imported photos keep the volume's sizes",
    );
  }

  const [index, dict] = await Promise.all([
    fetchHashed<VolumeIndex>(reader, manifest.index.path, manifest.index.hash, opts.label),
    fetchHashed<Dictionary>(reader, manifest.dict.path, manifest.dict.hash, opts.label),
  ]);
  return { manifest, dict, index: new Map(index.cells.map((cell) => [cell.cell, cell])) };
}

/**
 * Read a path and refuse it unless its bytes hash to what the level above advertised.
 *
 * **Throws.** A tile the volume says exists but which arrives corrupt is not "no places here" — a
 * caller that treated it as empty would then retire every place in that cell. Failing loudly is the
 * safe outcome, and every consumer of this module inherits that property.
 */
export async function fetchHashed<T>(
  reader: VolumeReader,
  path: string,
  expected: string,
  label: string,
): Promise<T> {
  const text = await reader.text(path);
  const actual = hashText(text);
  if (actual !== expected) {
    throw new Error(
      `${label}: ${path} does not match the hash the volume advertised ` +
        `(expected ${expected}, got ${actual})`,
    );
  }
  return JSON.parse(text) as T;
}
