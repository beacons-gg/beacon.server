/**
 * The Atlas volume format — `volume-format.md` as types, constants and a layout.
 *
 * **This file exists because the format has two implementors and they must agree byte for byte.**
 * Cartographer writes a volume; a Beacon server's `AtlasConnector` reads one. Both are apps, an app
 * never imports an app, so without this package the reader would redeclare the whole format with
 * nothing enforcing that the two declarations match — and a published version's bytes are immutable
 * forever (`apps/atlas/doc/spec/volume-format.md` §10), so a disagreement discovered later cannot
 * be corrected in place.
 *
 * Deliberately holds **no builder logic**: no interning, no clamping, no bounds accumulation. Those are
 * one side's business. What lives here is what both sides read: the shapes, the paths, the hash spelling,
 * and the two rules below that only mean something if both sides apply them identically.
 */
import { LIVE_CELL_PRECISION } from "@beaconsgg/geo";
import type { MediaCredit, PlaceGeometry } from "@beaconsgg/protocol-types";

/** This specification's version — the breaking-change lever (`apps/atlas/doc/spec/volume-format.md` §10). */
export const VOLUME_FORMAT = 1;

/**
 * The tile grid.
 *
 * `LIVE_CELL_PRECISION` rather than a local 5, because a Beacon server calls `fetchChunk` with one
 * precision-5 cell's bounds by default. Sharing the constant is what makes "one chunk is one tile" true
 * by construction instead of a coincidence that survives until somebody retunes one side.
 */
export const CELL_PRECISION = LIVE_CELL_PRECISION;

/**
 * Coordinate precision, everywhere, points included — ~1 m.
 *
 * Here because it is a property of the *format*, not of whoever writes it: a place's cell must be derived
 * from the coordinate that was published, not from a fuller one. Measured on us-west, 31 of 225,084 places
 * sit close enough to a cell edge that the difference moves them across it.
 *
 * Only the writer reads it today. A reader that re-derived a place's cell to check it — which `verify` does
 * and a server does not — needs exactly this number.
 */
export const COORD_DECIMALS = 5;

/**
 * One published photo — `apps/atlas/doc/spec/volume-format.md` §4 and §6.
 *
 * Two rules here are positional/indirect rather than structural, and both only work if the writer and the
 * reader apply them identically, which is why they are stated on the type both sides use:
 *
 * - **`role` pairs are adjacent, thumb first.** A photo is two entries, not one with two sizes, because the
 *   server's own `Media[]` is shaped that way and `Media` has no group id — adjacency is the only thing
 *   joining a pair, at either end of the wire.
 * - **`author` and `sourceUrl` sit outside the interned `credit`.** The licence pair repeats across
 *   thousands of files and interning it pays; the author and the file's own page are per-file, so interning
 *   them would make `dict.credits` roughly as long as the media list.
 */
export interface TileMedia {
  /** `sha256:<base64url-nopad>` of the published bytes — see {@link mediaBareHash} for the server's spelling. */
  hash: string;
  role: "thumb" | "full";
  /** A `dict.credits` index, or the credit inline. Carries the licence pair only. */
  credit?: number | MediaCredit;
  author?: string;
  sourceUrl?: string;
  /**
   * A `dict.sources` index — which corpus this file came from
   * (`apps/atlas/doc/spec/volume-format.md` §7).
   *
   * Not derivable from the place's own `sources`: a place described by OSM can carry a photo from Commons.
   * Two things need it — withdrawing one source's media in a later version, and a Beacon server deciding
   * whether its own street-level shot outranks an imported one.
   */
  source: number;
}

/** One place in a cell tile — `apps/atlas/doc/spec/volume-format.md` §4, with the dictionary indices unresolved. */
export interface TileRecord {
  id: string;
  upstream: string[];
  aliases?: string[];
  category: number;
  subcategory?: number;
  name?: string;
  altNames?: string[];
  description?: string;
  descriptionCredit?: number | MediaCredit;
  website?: string;
  wikipedia?: string;
  point: [number, number];
  sources: number[];
  /** Absent, never `[]`, for a place with no photos — see the note on {@link TileMedia}. */
  media?: TileMedia[];
}

/** One corpus's redistribution terms, as `dict.sources` publishes them (`apps/atlas/doc/spec/volume-format.md` §7). */
export interface SourceTerms {
  name: string;
  attribution: string;
  license: string;
  /** Absent for public domain — there is no licence to link to. */
  licenseUrl?: string;
}

/** `dict.json` as published. Indices are **per version** and mean nothing across two (§10). */
export interface Dictionary {
  categories: string[];
  subcategories: string[];
  credits: MediaCredit[];
  sources: (SourceTerms & { id: string })[];
}

/** One cell's tile. */
export interface CellTile {
  cell: string;
  revision: number;
  places: TileRecord[];
}

/** One cell's polygons, keyed by place id so a consumer joins them onto the tile it already has. */
export interface GeometryTile {
  cell: string;
  revision: number;
  geometry: Record<string, PlaceGeometry>;
}

/** What `index.json` records about one cell. */
export interface CellSummary {
  cell: string;
  places: number;
  hash: string;
  bytes: number;
  geomHash?: string;
  geomBytes?: number;
}

/** `index.json` — the cell list, which is what makes partial import possible (§3). */
export interface VolumeIndex {
  cellPrecision: number;
  cells: CellSummary[];
}

/** A hashed, sized reference to a file the manifest covers. */
export interface FileRef {
  path: string;
  hash: string;
  bytes: number;
}

/** The accumulated bounds of everything a volume holds. */
export interface Bounds {
  minLat: number;
  minLng: number;
  maxLat: number;
  maxLng: number;
}

/** The manifest, minus its signature — exactly the bytes the signature is taken over. */
export interface ManifestBody {
  format: number;
  volume: string;
  version: string;
  revision: number;
  createdAt: string;
  publisher: string;
  bounds: Bounds;
  coverage: string[];
  cellPrecision: number;
  places: number;
  index: FileRef;
  dict: FileRef;
  media: { base: string; count: number; bytes: number };
  /**
   * Place ids this version **deliberately stopped publishing** — a curator's removal, not a bug.
   *
   * The channel exists because the two readers that must tell those apart cannot ask the builder.
   * `verify --previous` is defined as a foreign consumer (it takes no database on purpose), so
   * without this an intentional removal is indistinguishable from a place that silently vanished —
   * which that check is required to fail the build over. And a server's scope-aware retirement
   * sweeps the cells it imported: a removed place that was the ONLY place in its p5 cell leaves no
   * tile, so its cell is not in the index, so nothing sweeps it and it stays live forever.
   *
   * Signed with the rest of the manifest, and absent when nothing was removed.
   */
  retired?: string[];
  taxonomy: number;
  mediaProfile: { thumbPx: number; fullPx: number; format: string };
  inputs: { source: string; artifact: string; hash: string }[];
  licenses: { id: string; name: string; license: string; licenseUrl?: string }[];
}

/** The manifest as published — the signed root of the whole tree. */
export type Manifest = ManifestBody & { signature: string };

/** `latest.json` — the one mutable file in a volume, holding nothing but a pointer (§1). */
export interface Latest {
  version: string;
  manifest: string;
}

/** Where a cell's tile lives inside a version directory. */
export function tilePath(cell: string): string {
  return `cells/${cell}.json`;
}

/** Where a cell's geometry sibling lives. Absent when the cell has no polygons. */
export function geomTilePath(cell: string): string {
  return `cells/${cell}.geom.json`;
}

/**
 * A media file's path, relative to `manifest.media.base` — which resolves **outside** a version
 * directory, because one photo is shared by every version that still references it
 * (`apps/atlas/doc/spec/volume-format.md` §1).
 *
 * The two-character shard mirrors the server's own `blobKey` rather than inventing a second scheme, and
 * carries the same accepted caveat: base64url is case-sensitive, so on a case-insensitive filesystem two
 * distinct hashes could share a directory. That is already true of the server's media store.
 *
 * **The `.webp` extension is functional.** A volume served by a plain static host needs it to answer with a
 * correct `Content-Type`; without one a consumer gets `application/octet-stream`, which the media
 * capability's type allowlist refuses.
 */
export function mediaPath(hash: string): string {
  const bare = mediaBareHash(hash);
  return `${bare.slice(0, 2)}/${bare}.webp`;
}

/**
 * Where a consumer fetches a media file, given the version URL it was configured with.
 *
 * **This exists because one field has two correct resolutions and only one of them is a URL.** A builder
 * joins paths, where `join(versionDir, "../media/", …)` is right whatever the directory looks like. A reader
 * resolves against a URL, where the same `../` is only right if the base ends in a slash:
 *
 * ```
 * new URL("../media/x", "https://h/us-west/2026-08")   → https://h/media/x          ✗ wrong
 * new URL("../media/x", "https://h/us-west/2026-08/")  → https://h/us-west/media/x  ✓
 * ```
 *
 * The version URL is operator input (`BEACON_PLACES_ATLAS`) and both forms look equally reasonable to type,
 * so the slash is normalized here rather than being a rule every caller has to know. Failing to would fetch
 * a wrong path that 404s, which a caller could easily read as "this volume has no photos".
 */
export function mediaUrl(versionUrl: string, base: string, hash: string): string {
  const root = versionUrl.endsWith("/") ? versionUrl : `${versionUrl}/`;
  return new URL(`${base}${mediaPath(hash)}`, root).toString();
}

/**
 * A media file's absolute path under an output directory — `<out>/media/<shard>/<hash>.webp`.
 *
 * Here rather than in the builder because both the writer and the verifier need it, and putting it in the
 * crawl meant every other Cartographer stage imported a module that loads a native image codec to compute a
 * path join.
 */
export function blobPath(outDir: string, hash: string): string {
  return `${outDir.replace(/\/+$/, "")}/media/${mediaPath(hash)}`;
}

/**
 * A media hash as the server spells it — bare base64url, no algorithm prefix.
 *
 * A volume names the algorithm in every hash it writes (`trust.ts`), but `Media.hash` does not, and
 * `ingestTrusted` re-hashes the bytes and compares against exactly that bare form. So the two spellings
 * meet here, once, rather than in a reader that strips the prefix by hand and a writer that hopes it did.
 */
export function mediaBareHash(hash: string): string {
  const colon = hash.indexOf(":");
  return colon === -1 ? hash : hash.slice(colon + 1);
}

/** The pointer a publisher writes last, once everything it names exists. */
export function latestJson(version: string): Latest {
  return { version, manifest: `${version}/manifest.json` };
}

/**
 * Which version `latest.json` points at.
 *
 * Returns nothing for a file that does not name one, leaving "missing" and "malformed" for the caller to
 * phrase — a server and the builder word that differently.
 */
export function versionFromLatest(text: string): string | undefined {
  const version = (JSON.parse(text) as { version?: unknown }).version;
  return typeof version === "string" && version !== "" ? version : undefined;
}
