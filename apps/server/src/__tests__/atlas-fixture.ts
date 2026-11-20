/**
 * A tiny signed volume, shared by the connector suite (which reads it over a faked HTTP client) and
 * the admin suite (which zips it and pushes it through the upload/import surface). One fixture so
 * the two suites cannot drift about what a well-formed volume looks like.
 */
import {
  hashText,
  latestJson,
  tilePath,
  type CellTile,
  type Dictionary,
  type ManifestBody,
  type VolumeIndex,
} from "@beaconsgg/atlas-volume";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { accountFromMnemonic, signUtf8 } from "@beaconsgg/identity";
import { canonicalJson } from "@beaconsgg/protocol-types";
import { ZipFile } from "yazl";

export const PUBLISHER = accountFromMnemonic(
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
);
export const IMPOSTOR = accountFromMnemonic(
  "legal winner thank year wave sausage worth useful legal winner thank yellow",
);

export const CELL = "c23nb";
export const BASE = "https://atlas.example.org/us-west/2026-08";

export const DICT: Dictionary = {
  categories: ["landmark", "park", "not-a-real-category"],
  subcategories: ["structure", "NOT A SLUG"],
  credits: [{ license: "CC BY-SA 4.0", author: "Wikipedia contributors" }],
  sources: [
    {
      id: "osm",
      name: "OpenStreetMap",
      attribution: "© OpenStreetMap contributors (ODbL)",
      license: "ODbL 1.0",
    },
    {
      id: "wikipedia",
      name: "English Wikipedia",
      attribution: "Wikipedia contributors",
      license: "CC BY-SA 4.0",
    },
  ],
};

export const lighthouse = () => ({
  id: "01K9Q7M4ZB8X2VNR5T0P0WR3AC",
  upstream: ["osm:w/586464226", "wd:Q2680081"],
  category: 0,
  subcategory: 0,
  name: "Mukilteo Lighthouse",
  description: "An operational navigation aid.",
  descriptionCredit: 0,
  point: [-122.30474, 47.94766] as [number, number],
  sources: [0, 1],
});

/** A volume as a set of paths, so a test can corrupt exactly one file. One tile or several. */
export function volume(
  tiles: CellTile | CellTile[],
  over: Partial<ManifestBody> = {},
  signer = PUBLISHER,
) {
  const list = Array.isArray(tiles) ? tiles : [tiles];
  const dictText = JSON.stringify(DICT);
  const index: VolumeIndex = {
    cellPrecision: 5,
    cells: list.map((tile) => ({
      cell: tile.cell,
      places: tile.places.length,
      hash: hashText(JSON.stringify(tile)),
      bytes: 1,
    })),
  };
  const indexText = JSON.stringify(index);
  const body: ManifestBody = {
    format: 1,
    volume: "us-west",
    version: "2026-08",
    revision: 1,
    createdAt: "2026-08-06T00:00:00.000Z",
    publisher: signer.did,
    bounds: { minLat: 47, minLng: -123, maxLat: 48, maxLng: -122 },
    coverage: ["c2"],
    cellPrecision: 5,
    places: list.reduce((n, tile) => n + tile.places.length, 0),
    index: { path: "index.json", hash: hashText(indexText), bytes: indexText.length },
    dict: { path: "dict.json", hash: hashText(dictText), bytes: dictText.length },
    media: { base: "../media/", count: 0, bytes: 0 },
    taxonomy: 3,
    mediaProfile: { thumbPx: 256, fullPx: 1024, format: "image/webp" },
    inputs: [],
    licenses: [],
    ...over,
  };
  const manifestText = JSON.stringify({
    ...body,
    signature: signUtf8(canonicalJson(body), signer.root.privateKey),
  });
  return {
    "manifest.json": manifestText,
    "index.json": indexText,
    "dict.json": dictText,
    ...Object.fromEntries(list.map((tile) => [tilePath(tile.cell), JSON.stringify(tile)])),
  } as Record<string, string>;
}

/** The same volume as an ON-DISK tree — what a mounted `BEACON_ATLAS_VOLUMES_DIR` entry holds. */
export async function volumeTree(
  dir: string,
  files: Record<string, string>,
  version = "2026-08",
): Promise<void> {
  await mkdir(join(dir, version, "cells"), { recursive: true });
  await writeFile(join(dir, "latest.json"), JSON.stringify(latestJson(version)));
  for (const [name, text] of Object.entries(files)) {
    await writeFile(join(dir, version, name), text);
  }
}

/** The same volume as an uploadable archive — the tree verbatim: latest.json + <version>/ paths. */
export function volumeZip(files: Record<string, string>, version = "2026-08"): Promise<Buffer> {
  const zip = new ZipFile();
  zip.addBuffer(Buffer.from(JSON.stringify(latestJson(version))), "latest.json");
  for (const [path, text] of Object.entries(files)) {
    zip.addBuffer(Buffer.from(text), `${version}/${path}`);
  }
  zip.end();
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    zip.outputStream.on("data", (c: Buffer) => chunks.push(c));
    zip.outputStream.on("end", () => resolve(Buffer.concat(chunks)));
    zip.outputStream.on("error", reject);
  });
}
