/**
 * Stage 6 — read a published volume back **as a foreign consumer would** and prove it is consumable.
 *
 * Deliberately ignorant of the build database. Everything it needs is in the tree, reached the way
 * `apps/atlas/doc/spec/volume-format.md` §8 says a reader reaches it: manifest → signature → index
 * → tiles, each hash checked against the level above. A verifier that peeked at `merged_places`
 * would be checking that publish agreed with itself, which is the one thing that was never in
 * doubt.
 *
 * **Every failure is collected, not thrown on.** An operator fixing a bad volume wants the list, and a
 * verifier that stops at the first problem turns one run into five.
 */
import { cellBounds, type BBox } from "@beaconsgg/geo";
import { TAXONOMY_VERSION } from "@beaconsgg/place-taxonomy";
import {
  MAX_PLACE_MEDIA,
  placeGeometrySchema,
  type PlaceGeometry,
} from "@beaconsgg/protocol-types";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import {
  CELL_PRECISION,
  checkManifest,
  geomTilePath,
  hashBytes,
  hashText,
  mediaPath,
  tilePath,
  VOLUME_FORMAT,
  type CellSummary,
  type CellTile,
  type Dictionary,
  type GeometryTile,
  type Manifest,
  type TileRecord,
  type VolumeIndex,
} from "@beaconsgg/atlas-volume";

/** One assertion that did not hold. `check` groups them; `detail` names the offender. */
export interface Failure {
  check: string;
  detail: string;
}

/** How every check reports. Named once rather than spelled out at each of the four that take it. */
type Fail = (check: string, detail: string) => void;

export type VerifyReport = VerifyCounts & Continuity;

interface VerifyCounts {
  volume: string;
  version: string;
  revision: number;
  publisher: string;
  /** Places the manifest claims. */
  claimed: number;
  /** Places actually found across the tiles. */
  found: number;
  cells: number;
  geometryTiles: number;
  aliases: number;
  /** Media files re-hashed against the names they are filed under, and their bytes. */
  mediaChecked: number;
  mediaBytes: number;
  /** True when `media.base` is remote, so nothing was checked — reported rather than read as a pass. */
  mediaSkipped: boolean;
  failures: Failure[];
}

/**
 * Whether id continuity was checked, and against how many ids.
 *
 * A union rather than a flag beside an optional count, so "checked, but we don't know against what" is not
 * a representable state — and so the report cannot paper over it with a `?? 0`.
 */
export type Continuity =
  { continuity: "checked"; previousIds: number } | { continuity: "no-previous" };

/**
 * Verify the volume under `dir`, optionally against the previous version's directory.
 *
 * `previousDir` points at a **version directory** (the one holding `manifest.json`), not a volume root:
 * continuity is a statement about two versions, and making the caller name them both means it can never
 * silently compare a version with itself.
 */
export async function verify(opts: {
  dir: string;
  previousDir?: string;
  log: (message: string) => void;
}): Promise<VerifyReport> {
  const failures: Failure[] = [];
  const fail = (check: string, detail: string): void => {
    failures.push({ check, detail });
  };

  const manifestText = await readFile(join(opts.dir, "manifest.json"), "utf8");

  // 1. The signature, over the manifest minus the signature — the root of everything below.
  //
  // Through `checkManifest`, the same function the server's connector uses. A verifier with its own copy
  // would be proving that the publisher agrees with itself; this proves the volume satisfies the check a
  // consumer will actually apply. No `expectedPublisher`: a build verifies its own output, and which key
  // an operator trusts is their configuration, not ours.
  const checked = checkManifest(manifestText);
  if (!checked.ok) fail("signature", `${checked.reason}: ${checked.detail}`);
  // The parsed manifest from the check on the ok path; a second parse only where the check refused it, so
  // the assertions below still run and report everything else wrong with the tree rather than stopping here.
  const manifest = checked.ok ? checked.manifest : (JSON.parse(manifestText) as Manifest);

  // 2. What we are being handed at all.
  if (manifest.format !== VOLUME_FORMAT) {
    fail("format", `manifest format ${manifest.format}, this reader understands ${VOLUME_FORMAT}`);
  }
  if (manifest.taxonomy !== TAXONOMY_VERSION) {
    // A warning in a consumer (`apps/atlas/doc/spec/beacon-integration.md` §7); a failure here,
    // because the publisher and the verifier are the same build and disagreeing with itself is a
    // bug rather than a version skew.
    fail("taxonomy", `manifest taxonomy ${manifest.taxonomy}, this build has ${TAXONOMY_VERSION}`);
  }
  if (manifest.cellPrecision !== CELL_PRECISION) {
    fail(
      "cellPrecision",
      `manifest says ${manifest.cellPrecision}, this build tiles at ${CELL_PRECISION}`,
    );
  }

  // 3. The two files the manifest hashes directly.
  const index = await hashedJson<VolumeIndex>(
    opts.dir,
    manifest.index.path,
    manifest.index.hash,
    fail,
  );
  const dict = await hashedJson<Dictionary>(opts.dir, manifest.dict.path, manifest.dict.hash, fail);
  const cells = index?.cells ?? [];

  // 4-8. Every tile, and everything inside it.
  const ids = new Set<string>();
  const aliasTargets = new Map<string, string>();
  let found = 0;
  let geometryTiles = 0;
  /** Every media hash a tile referenced → the place that referenced it, for a legible failure. */
  const mediaWanted = new Map<string, string>();

  for (const summary of cells) {
    const tile = await hashedJson<CellTile>(opts.dir, tilePath(summary.cell), summary.hash, fail);
    if (!tile) continue;
    if (tile.cell !== summary.cell) {
      fail("tile", `${tilePath(summary.cell)} says it is cell ${tile.cell}`);
    }
    // A tile carries the revision it was written for, and nothing checked it — so a tile copied in from
    // another version of this volume verified clean, hash and all, because its hash is only ever compared
    // against the index that named it.
    if (tile.revision !== manifest.revision) {
      fail(
        "tile",
        `${tilePath(summary.cell)} is revision ${tile.revision}, manifest is ${manifest.revision}`,
      );
    }
    if (tile.places.length !== summary.places) {
      fail(
        "index",
        `${summary.cell}: index says ${summary.places} places, tile has ${tile.places.length}`,
      );
    }
    found += tile.places.length;

    const bounds = cellBounds(summary.cell);
    for (const place of tile.places) {
      if (ids.has(place.id)) fail("id", `${place.id} appears in more than one tile`);
      ids.add(place.id);
      for (const alias of place.aliases ?? []) aliasTargets.set(alias, place.id);
      checkPlace(place, summary.cell, bounds, dict, fail);
      for (const entry of place.media ?? []) mediaWanted.set(entry.hash, place.id);
    }

    if (summary.geomHash) {
      geometryTiles += 1;
      const geom = await hashedJson<GeometryTile>(
        opts.dir,
        geomTilePath(summary.cell),
        summary.geomHash,
        fail,
      );
      if (geom) {
        for (const [id, shape] of Object.entries(geom.geometry)) {
          if (!tile.places.some((p) => p.id === id)) {
            fail("geometry", `${summary.cell}: geometry for ${id}, which is not in the tile`);
          }
          if (!withinCaps(shape)) fail("geometry", `${id}: exceeds the wire's geometry caps`);
        }
      }
    }
  }

  if (found !== manifest.places) {
    fail("places", `manifest claims ${manifest.places} places, tiles hold ${found}`);
  }

  const media = await checkMediaFiles(opts.dir, manifest, mediaWanted, fail, opts.log);

  // An alias must resolve to a place that exists, and must never itself be one — either would leave a
  // consumer with two live places for one thing, which is what aliases exist to prevent.
  for (const [alias, target] of aliasTargets) {
    if (ids.has(alias))
      fail("alias", `${alias} is listed as an alias of ${target} and is also a live id`);
  }

  opts.log(`checked ${cells.length} cells, ${found} places, ${aliasTargets.size} aliases`);

  const retired = new Set(manifest.retired ?? []);
  // A removal that keeps publishing is a curator's verdict the build ignored — cheap to catch here,
  // where both lists are already in hand.
  for (const id of retired) {
    if (ids.has(id)) fail("retired", `${id} is listed as retired and is also a live id`);
  }
  const continuity = await checkContinuity(opts.previousDir, ids, aliasTargets, retired, fail);

  return {
    volume: manifest.volume,
    version: manifest.version,
    revision: manifest.revision,
    publisher: manifest.publisher,
    claimed: manifest.places,
    found,
    cells: cells.length,
    geometryTiles,
    aliases: aliasTargets.size,
    mediaChecked: media.checked,
    mediaBytes: media.bytes,
    mediaSkipped: media.skipped,
    ...continuity,
    failures,
  };
}

/**
 * Place-id continuity — the assertion that protects downstream operators from losing their work.
 *
 * Every id the previous version published must still be live, a listed alias, or **named in this
 * version's `retired` list**. A place that simply stopped appearing is a **bug, not a publish**
 * (`apps/atlas/doc/spec/cartographer.md` §1): a consumer's scope-aware retirement would retire it,
 * taking that operator's edits and its players' contributions with it.
 *
 * `retired` is the third outcome because this check is deliberately database-blind — it reads what a
 * foreign consumer reads — so a curator's removal can only reach it through the signed artifact. Without
 * that channel the first publish after any review removal fails a build that did exactly what was asked.
 *
 * With no previous version this reports `no-previous` rather than passing silently. "The check succeeded"
 * and "the check did not run" are different facts, and the second one looks exactly like the first in a
 * green build log.
 */
async function checkContinuity(
  previousDir: string | undefined,
  ids: ReadonlySet<string>,
  aliases: ReadonlyMap<string, string>,
  retired: ReadonlySet<string>,
  fail: Fail,
): Promise<Continuity> {
  if (!previousDir) return { continuity: "no-previous" };

  const previous = await readIds(previousDir);
  const lost: string[] = [];
  for (const id of previous) {
    if (!ids.has(id) && !aliases.has(id) && !retired.has(id)) lost.push(id);
  }
  if (lost.length > 0) {
    // Named, not just counted: the operator has to be able to look one up and find out what happened.
    const shown = lost.slice(0, 5).join(", ");
    fail(
      "continuity",
      `${lost.length} place id(s) from the previous version are neither live nor aliased: ${shown}` +
        (lost.length > 5 ? `, and ${lost.length - 5} more` : ""),
    );
  }
  return { continuity: "checked", previousIds: previous.size };
}

/** Every place id a published version holds, live or aliased. */
async function readIds(dir: string): Promise<Set<string>> {
  const manifest = JSON.parse(await readFile(join(dir, "manifest.json"), "utf8")) as Manifest;
  const index = JSON.parse(await readFile(join(dir, manifest.index.path), "utf8")) as {
    cells: CellSummary[];
  };
  const ids = new Set<string>();
  for (const summary of index.cells) {
    const tile = JSON.parse(await readFile(join(dir, `cells/${summary.cell}.json`), "utf8")) as {
      places: TileRecord[];
    };
    for (const place of tile.places) {
      ids.add(place.id);
      for (const alias of place.aliases ?? []) ids.add(alias);
    }
  }
  return ids;
}

/** Read a JSON file, check it against the hash the level above advertised, and parse it. */
async function hashedJson<T>(
  dir: string,
  path: string,
  expected: string,
  fail: Fail,
): Promise<T | undefined> {
  let text: string;
  try {
    text = await readFile(join(dir, path), "utf8");
  } catch {
    fail("missing", path);
    return undefined;
  }
  const actual = hashText(text);
  if (actual !== expected) {
    fail("hash", `${path}: advertised ${expected}, bytes hash to ${actual}`);
    return undefined;
  }
  return JSON.parse(text) as T;
}

function checkPlace(
  place: TileRecord,
  cell: string,
  bounds: BBox,
  dict: Dictionary | undefined,
  fail: Fail,
): void {
  const [lng, lat] = place.point;
  // The rule that makes partial import correct: a consumer that fetched this cell must have got every
  // place filed under it, and a place outside its own cell is one nobody will ever fetch.
  if (lat < bounds.minLat || lat > bounds.maxLat || lng < bounds.minLng || lng > bounds.maxLng) {
    fail("cell", `${place.id}: point [${lng}, ${lat}] is outside cell ${cell}`);
  }
  if (!dict) return;
  checkMedia(place, dict, fail);
  if (dict.categories[place.category] === undefined) {
    fail("dict", `${place.id}: category index ${place.category} is out of range`);
  }
  if (place.subcategory !== undefined && dict.subcategories[place.subcategory] === undefined) {
    fail("dict", `${place.id}: subcategory index ${place.subcategory} is out of range`);
  }
  if (
    typeof place.descriptionCredit === "number" &&
    dict.credits[place.descriptionCredit] === undefined
  ) {
    fail("dict", `${place.id}: credit index ${place.descriptionCredit} is out of range`);
  }
  for (const source of place.sources) {
    if (dict.sources[source] === undefined) {
      fail("dict", `${place.id}: source index ${source} is out of range`);
    }
  }
  // A description without its credit is legal; a credit without the description it credits is not, and it
  // is the direction that misattributes text (`fields.ts`'s `OWNED_BY`).
  if (place.descriptionCredit !== undefined && place.description === undefined) {
    fail("credit", `${place.id}: carries a descriptionCredit with no description`);
  }
}

/**
 * A place's photos, checked from the outside.
 *
 * Three of these are enforced by nothing else in the tree. `media` is an array of independent entries, so
 * nothing structural says the pairs line up, that the indices resolve, or that the count fits the wire — and
 * the last one is the nastiest to discover late: an over-capped place is accepted by a server importing the
 * volume and then fails a **downstream** server's `places.import`, taking a 2,000-feature collection with it.
 */
function checkMedia(place: TileRecord, dict: Dictionary, fail: Fail): void {
  const media = place.media;
  if (media === undefined) return;
  // `[]` is not "no photos" to a consumer — the server's media policy reads a present array as "this source
  // supplies media" and blanks the place's own. Absent is the only correct way to say none.
  if (media.length === 0) {
    fail("media", `${place.id}: carries an empty media array; it must be absent instead`);
    return;
  }
  // Re-checked against the wire's own number, not the publisher's — the third-party-authority rule
  // `withinCaps` follows for geometry.
  if (media.length > MAX_PLACE_MEDIA) {
    fail(
      "media",
      `${place.id}: ${media.length} media entries exceeds the wire's ${MAX_PLACE_MEDIA}`,
    );
  }

  for (const entry of media) {
    if (typeof entry.credit === "number" && dict.credits[entry.credit] === undefined) {
      fail("dict", `${place.id}: media credit index ${entry.credit} is out of range`);
    }
    if (dict.sources[entry.source] === undefined) {
      fail("dict", `${place.id}: media source index ${entry.source} is out of range`);
    }
  }

  // Adjacent, thumb first. `Media` has no group id, so this ordering is the *only* thing joining a pair —
  // a lone `full`, or a pair the wrong way round, silently gives a consumer the wrong image for a marker.
  if (media.length % 2 !== 0) {
    fail("media", `${place.id}: ${media.length} media entries cannot pair up`);
  }
  for (let at = 0; at + 1 < media.length; at += 2) {
    if (media[at]?.role !== "thumb" || media[at + 1]?.role !== "full") {
      fail(
        "media",
        `${place.id}: media entries ${at}/${at + 1} are ` +
          `${media[at]?.role}/${media[at + 1]?.role}, not thumb/full`,
      );
    }
  }
}

/**
 * The caps re-checked from the outside — against **the wire's schema**, not against `volume.ts`.
 *
 * The distinction is the whole point of this module: importing the publisher's checker would verify
 * that publish agrees with itself, which was never in doubt. `placeGeometrySchema` is a third party
 * to both, and it is the authority a consumer will actually apply
 * (`apps/atlas/doc/spec/beacon-integration.md` §7).
 *
 * It replaces a hand-written copy that had already drifted from the publisher's in the same commit — this
 * one omitted the ring-closure check — so "the same caps" was two different rules.
 */
function withinCaps(geometry: PlaceGeometry): boolean {
  return placeGeometrySchema.safeParse(geometry).success;
}

/**
 * Every media file a tile referenced: present, and its bytes hash to its name.
 *
 * **This is what puts the blobs inside the signature.** `manifest.media` carries `{base, count, bytes}` and
 * no file list, so unlike every other file in the tree a blob is not named by anything the signature
 * covers — directly. It is covered *transitively*: the hash sits in a `TileRecord`, the tile's hash is in
 * `index.json`, and the index's hash is in the signed manifest. Re-hashing here is what makes that chain a
 * check rather than a diagram.
 *
 * **It must not fail on an orphan**, and that is a real constraint rather than laxity: `media/` is
 * shared across versions by design (`apps/atlas/doc/spec/volume-format.md` §1), so a blob this
 * version does not reference may legitimately belong to the previous one, and "every file under
 * media/ is referenced" would fail on any second version. A withdrawn source's files land in the
 * same state. So the count is reported and collecting them is a separate operator job.
 */
async function checkMediaFiles(
  dir: string,
  manifest: Manifest,
  wanted: Map<string, string>,
  fail: Fail,
  log: (message: string) => void,
): Promise<{ checked: number; bytes: number; skipped: boolean }> {
  if (manifest.media.count !== wanted.size) {
    fail(
      "media",
      `manifest claims ${manifest.media.count} media files, tiles reference ${wanted.size}`,
    );
  }
  if (wanted.size === 0) return { checked: 0, bytes: 0, skipped: false };

  // A volume may point `media.base` at a CDN (`apps/atlas/doc/spec/volume-format.md` §6), which a
  // local verify cannot walk from disk. Said out loud rather than silently checking nothing and
  // reporting a pass.
  if (/^[a-z][a-z0-9+.-]*:/i.test(manifest.media.base)) {
    log(
      `media.base is remote (${manifest.media.base}) — skipping the byte check, nothing was verified`,
    );
    return { checked: 0, bytes: 0, skipped: true };
  }

  let bytes = 0;
  let checked = 0;
  for (const [hash, placeId] of wanted) {
    const path = join(dir, manifest.media.base, mediaPath(hash));
    let raw: Buffer;
    try {
      raw = await readFile(path);
    } catch {
      fail("media", `${placeId}: ${hash} is referenced but missing at ${manifest.media.base}`);
      continue;
    }
    const actual = hashBytes(raw);
    if (actual !== hash) {
      fail(
        "media",
        `${mediaPath(hash)}: bytes hash to ${actual}, not the name they are filed under`,
      );
      continue;
    }
    bytes += raw.length;
    checked += 1;
  }
  if (checked === wanted.size && bytes !== manifest.media.bytes) {
    fail("media", `manifest claims ${manifest.media.bytes} media bytes, files hold ${bytes}`);
  }
  log(`checked ${checked} media files, ${bytes} bytes`);
  return { checked, bytes, skipped: false };
}
