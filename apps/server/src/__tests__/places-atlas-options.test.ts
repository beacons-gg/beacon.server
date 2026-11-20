/**
 * What an operator decides before an Atlas import: the survey that counts a volume's area, the
 * filters that narrow an import (and leave what they exclude untouched), and a hosted URL naming
 * the volume's root rather than one version.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CellTile, TileRecord, VolumeReader } from "@beaconsgg/atlas-volume";
import type { PlaceAtlasSurvey } from "@beaconsgg/protocol-types";
import { PUBLISHER, lighthouse, volume, volumeTree } from "./atlas-fixture";
import { placesHarness, signedEnv } from "./test-helpers";
import { OutboundError } from "../common/outbound-http";
import { AtlasSurveys } from "../places/atlas-survey";
import { excludedBy } from "../places/snapshot.service";

const PHOTO = "sha256:47DEQpj8HBSa-_TImW-5JCeuQeRkm5NMpJWZG3hSuFU";

/** Three places in one cell: named and described; a photo but no subcategory; neither. */
function places(): TileRecord[] {
  return [
    lighthouse(),
    {
      id: "01K9Q7M4ZB8X2VNR5T0P0WR3AD",
      upstream: ["osm:n/2"],
      category: 1,
      name: "Harbor Park",
      point: [-122.30574, 47.94866],
      sources: [0],
      media: [
        { hash: PHOTO, role: "thumb", source: 0 },
        { hash: PHOTO, role: "full", source: 0 },
      ],
    },
    {
      id: "01K9Q7M4ZB8X2VNR5T0P0WR3AE",
      upstream: ["osm:n/3"],
      category: 1,
      point: [-122.30674, 47.94666],
      sources: [0],
    },
  ];
}
/** The cell all three points encode to: retirement only sweeps places inside the cells it read. */
const CELL = "c290b";
const tile = (list = places()): CellTile => ({ cell: CELL, revision: 1, places: list });

let volumesDir: string;
beforeEach(async () => {
  volumesDir = await mkdtemp(join(tmpdir(), "atlas-options-"));
});
afterEach(async () => {
  await rm(volumesDir, { recursive: true, force: true });
});

/** A harness with `volume(tile)` mounted at `us-west`. */
async function mounted(list?: TileRecord[]) {
  await volumeTree(join(volumesDir, "us-west"), volume(tile(list)));
  return placesHarness({ atlasVolumesDir: volumesDir });
}

/** Import the mounted volume with `options` (and an area `scope`) and wait for the run to finish. */
async function importMounted(
  h: Awaited<ReturnType<typeof mounted>>,
  options?: object,
  scope?: { cells?: string[]; boundary?: object; categories?: string[] },
) {
  const run = await h.controller.atlasImport(
    signedEnv(h.admin, "places.atlas.import", {
      path: "us-west",
      publisher: PUBLISHER.did,
      ...scope,
      ...(options ? { options } : {}),
    }),
  );
  await h.snapshots.idle();
  return h.snapshots.getSnapshot(run.snapshot.id);
}

describe("places.atlas.survey", () => {
  it("counts the area by type and by what each place carries, polled until done", async () => {
    const { controller, admin } = await mounted();
    const ask = () =>
      controller.atlasSurvey(signedEnv(admin, "places.atlas.survey", { path: "us-west" }));

    let survey: PlaceAtlasSurvey = (await ask()).survey;
    expect(survey.tilesTotal).toBe(1);
    for (let i = 0; i < 50 && survey.status === "running"; i++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      survey = (await ask()).survey;
    }
    expect(survey.status).toBe("done");
    expect(survey.result).toMatchObject({ cells: 1, places: 3, photoFiles: 2 });
    expect(survey.result?.buckets).toEqual([
      {
        category: "landmark",
        subcategory: "structure",
        supported: true,
        variants: [
          { hasPhotos: false, hasName: true, hasDescription: true, places: 1, photoFiles: 0 },
        ],
      },
      {
        category: "park",
        supported: true,
        variants: [
          { hasPhotos: false, hasName: false, hasDescription: false, places: 1, photoFiles: 0 },
          { hasPhotos: true, hasName: true, hasDescription: false, places: 1, photoFiles: 2 },
        ],
      },
    ]);
    expect(survey.result?.sources).toEqual([
      { id: "osm", places: 3 },
      { id: "wikipedia", places: 1 },
    ]);
  });

  it("starts one survey when two requests for it overlap", async () => {
    const files = volume(tile());
    let opened = 0;
    const open = () => {
      opened += 1;
      const reader: VolumeReader = {
        describe: "test volume",
        text: (path) =>
          files[path] !== undefined
            ? Promise.resolve(files[path])
            : Promise.reject(new Error(`missing ${path}`)),
      };
      return Promise.resolve(reader);
    };
    const surveys = new AtlasSurveys();
    const [a, b] = await Promise.all([
      surveys.get("k", open, undefined),
      surveys.get("k", open, undefined),
    ]);
    expect(opened).toBe(1);
    expect(b).toBe(a);
  });

  it("refuses an area the volume holds nothing in", async () => {
    const { controller, admin } = await mounted();
    await expect(
      controller.atlasSurvey(
        signedEnv(admin, "places.atlas.survey", { path: "us-west", cells: ["zz"] }),
      ),
    ).rejects.toThrow(/no cells/);
  });
});

describe("places.atlas.import options", () => {
  it("skips what the filters exclude, counts it, and records the options on the run", async () => {
    const options = { requireName: true, requireDescription: true, importPhotos: false };
    const done = await importMounted(await mounted(), options);
    expect(done?.status).toBe("done");
    expect(done?.stats).toMatchObject({ fetched: 3, created: 1, filtered: 2 });
    expect(done?.params.options).toEqual(options);
  });

  it("never retires a place a later, narrower import filtered out", async () => {
    const h = await mounted();
    expect((await importMounted(h))?.stats).toMatchObject({ created: 3, retired: 0 });
    const narrow = await importMounted(h, { requirePhotos: true });
    expect(narrow?.stats).toMatchObject({ filtered: 2, retired: 0 });
  });

  it("leaves places missing from a new version live when retireMissing is off", async () => {
    const h = await mounted();
    await importMounted(h);

    // The next version drops the unnamed park.
    await volumeTree(join(volumesDir, "us-west"), volume(tile(places().slice(0, 2))));
    expect((await importMounted(h, { retireMissing: false }))?.stats).toMatchObject({ retired: 0 });
    expect((await importMounted(h))?.stats).toMatchObject({ retired: 1 });
  });

  describe("retireFiltered", () => {
    // In the fixture's one cell: the lighthouse (no photo) hashes to c290bbs, Harbor Park (the only
    // photo) to c290bbg, the unnamed park (no photo) to c290bb6.

    it("retires places an earlier, wider import brought in that the filters now skip", async () => {
      const h = await mounted();
      await importMounted(h);
      const clean = await importMounted(h, { requirePhotos: true, retireFiltered: true });
      expect(clean?.stats).toMatchObject({ filtered: 2, retired: 2, retiredFiltered: 2 });
      expect(clean?.params.options).toEqual({ requirePhotos: true, retireFiltered: true });
      // Run again: nothing left to retire.
      expect(
        (await importMounted(h, { requirePhotos: true, retireFiltered: true }))?.stats,
      ).toMatchObject({ retired: 0 });
    });

    it("never retires a filtered place outside the requested prefixes, even in a cell the area overlaps", async () => {
      const h = await mounted();
      await importMounted(h);
      // c290bb6 holds only the unnamed park; the lighthouse shares the volume cell c290b.
      const run = await importMounted(
        h,
        { requirePhotos: true, retireFiltered: true },
        { cells: ["c290bb6"] },
      );
      expect(run?.stats).toMatchObject({ filtered: 2, retired: 1, retiredFiltered: 1 });
    });

    it("never retires a filtered place outside the requested boundary", async () => {
      const h = await mounted();
      await importMounted(h);
      const run = await importMounted(
        h,
        { requirePhotos: true, retireFiltered: true },
        { boundary: { minLat: 47.946, minLng: -122.307, maxLat: 47.947, maxLng: -122.306 } },
      );
      expect(run?.stats).toMatchObject({ filtered: 2, retired: 1, retiredFiltered: 1 });
    });

    it("holds a polygon boundary to the polygon, not its bounding box", async () => {
      const h = await mounted();
      await importMounted(h);
      // A triangle around the unnamed park whose bounding box also holds the lighthouse.
      const triangle = {
        type: "Polygon" as const,
        coordinates: [
          [
            [-122.308, 47.946],
            [-122.304, 47.946],
            [-122.308, 47.948],
            [-122.308, 47.946],
          ],
        ],
      };
      const run = await importMounted(
        h,
        { requirePhotos: true, retireFiltered: true },
        { boundary: triangle },
      );
      expect(run?.stats).toMatchObject({ filtered: 2, retired: 1, retiredFiltered: 1 });
    });

    it("never retires a place that moved into the area from outside it", async () => {
      // First stored beside the lighthouse (c290bbs), outside the area c290bb6 asked for below.
      const [lh, harbor, unnamed] = places();
      const outside = { ...unnamed!, point: [-122.30484, 47.94776] as [number, number] };
      const h = await mounted([lh!, harbor!, outside]);
      await importMounted(h);
      // The next version moves it to its own point, inside c290bb6.
      await volumeTree(join(volumesDir, "us-west"), volume(tile([lh!, harbor!, unnamed!])));
      const run = await importMounted(
        h,
        { requirePhotos: true, retireFiltered: true },
        { cells: ["c290bb6"] },
      );
      expect(run?.stats).toMatchObject({ filtered: 2, retired: 0 });
    });

    it("never retires a place left out by type", async () => {
      const h = await mounted();
      await importMounted(h);
      const run = await importMounted(h, {
        skipTypes: [{ category: "park" }],
        retireFiltered: true,
      });
      expect(run?.stats).toMatchObject({ filtered: 2, retired: 0 });
    });

    it("retires filtered places while retireMissing off keeps the ones gone from the version", async () => {
      const h = await mounted();
      await importMounted(h);
      // The next version drops the lighthouse; the unnamed park is still in it, without a photo.
      await volumeTree(join(volumesDir, "us-west"), volume(tile(places().slice(1))));
      const run = await importMounted(h, {
        requirePhotos: true,
        retireFiltered: true,
        retireMissing: false,
      });
      expect(run?.stats).toMatchObject({ filtered: 1, retired: 1, retiredFiltered: 1 });
    });
  });

  describe("retireUnselectedTypes", () => {
    // The lighthouse is a landmark (c290bbs); both parks have no subcategory (c290bbg, c290bb6).

    it("retires places of a category the import leaves out", async () => {
      const h = await mounted();
      await importMounted(h);
      const run = await importMounted(h, { retireUnselectedTypes: true }, { categories: ["park"] });
      expect(run?.stats).toMatchObject({ retired: 1, retiredUnselected: 1 });
      expect(run?.params.options).toEqual({ retireUnselectedTypes: true });
      // Run again: nothing left to retire.
      expect(
        (await importMounted(h, { retireUnselectedTypes: true }, { categories: ["park"] }))?.stats,
      ).toMatchObject({ retired: 0 });
    });

    it("retires places of a type skipTypes leaves out", async () => {
      const h = await mounted();
      await importMounted(h);
      const run = await importMounted(h, {
        skipTypes: [{ category: "park" }],
        retireUnselectedTypes: true,
      });
      expect(run?.stats).toMatchObject({ filtered: 2, retired: 2, retiredUnselected: 2 });
    });

    it("leaves a left-out category alone without it", async () => {
      const h = await mounted();
      await importMounted(h);
      expect((await importMounted(h, undefined, { categories: ["park"] }))?.stats).toMatchObject({
        retired: 0,
      });
    });

    it("never retires a place of a left-out type outside the requested area", async () => {
      const h = await mounted();
      await importMounted(h);
      // c290bb6 holds only the unnamed park; the lighthouse shares the volume cell c290b.
      const run = await importMounted(
        h,
        { retireUnselectedTypes: true },
        { categories: ["park"], cells: ["c290bb6"] },
      );
      expect(run?.stats).toMatchObject({ retired: 0 });
    });

    it("never retires a place of a skipped type outside the requested area", async () => {
      const h = await mounted();
      await importMounted(h);
      // Both parks are skipped; only the unnamed one is inside c290bb6.
      const run = await importMounted(
        h,
        { skipTypes: [{ category: "park" }], retireUnselectedTypes: true },
        { cells: ["c290bb6"] },
      );
      expect(run?.stats).toMatchObject({ retired: 1, retiredUnselected: 1 });
    });

    it("retires a skipped type gone from the version, with retireMissing off", async () => {
      const h = await mounted();
      await importMounted(h);
      // The next version drops the unnamed park; its stored record is still a skipped type.
      await volumeTree(join(volumesDir, "us-west"), volume(tile(places().slice(0, 2))));
      const run = await importMounted(h, {
        skipTypes: [{ category: "park" }],
        retireUnselectedTypes: true,
        retireMissing: false,
      });
      expect(run?.stats).toMatchObject({ retired: 2, retiredUnselected: 2 });
    });

    it("goes by the version's type for a place the run read, not the stored one", async () => {
      const h = await mounted();
      await importMounted(h);
      // The next version makes the lighthouse a park; it has no photo, so the filter skips it.
      const [lh, harbor, unnamed] = places();
      const { subcategory: _sub, ...rest } = lh!;
      const asPark = { ...rest, category: 1 };
      await volumeTree(join(volumesDir, "us-west"), volume(tile([asPark, harbor!, unnamed!])));
      const run = await importMounted(
        h,
        { requirePhotos: true, retireUnselectedTypes: true },
        { categories: ["park"] },
      );
      expect(run?.stats).toMatchObject({ filtered: 2, retired: 0 });
    });

    it("retires left-out types while retireMissing off keeps the ones gone from the version", async () => {
      const h = await mounted();
      await importMounted(h);
      // The next version drops the unnamed park; the run leaves out landmarks.
      await volumeTree(join(volumesDir, "us-west"), volume(tile(places().slice(0, 2))));
      const run = await importMounted(
        h,
        { retireUnselectedTypes: true, retireMissing: false },
        { categories: ["park"] },
      );
      expect(run?.stats).toMatchObject({ retired: 1, retiredUnselected: 1 });
    });
  });

  it("skips exact types, where a type without a subcategory means places that have none", () => {
    const park = { category: "park" as const, point: { lat: 0, lng: 0 } };
    const trail = { ...park, subcategory: "trail" };
    expect(excludedBy(park, { skipTypes: [{ category: "park" }] })).toBe("type");
    expect(excludedBy(trail, { skipTypes: [{ category: "park" }] })).toBeUndefined();
    expect(excludedBy(trail, { skipTypes: [{ category: "park", subcategory: "trail" }] })).toBe(
      "type",
    );
    expect(
      excludedBy(
        { ...trail, category: "nature" },
        { skipTypes: [{ category: "park", subcategory: "trail" }] },
      ),
    ).toBeUndefined();
    expect(excludedBy(park, {})).toBeUndefined();
    expect(excludedBy(park, { requireName: true })).toBe("content");
  });
});

describe("hosted volume URLs", () => {
  const ROOT = "https://atlas.example.org/us-west";
  const files = volume(tile());
  const serve = (url: string): Promise<string> => {
    if (url === `${ROOT}/latest.json`) {
      return Promise.resolve(
        JSON.stringify({ version: "2026-08", manifest: "2026-08/manifest.json" }),
      );
    }
    const path = url.startsWith(`${ROOT}/2026-08/`) ? url.slice(`${ROOT}/2026-08/`.length) : "";
    const text = files[path];
    return text !== undefined
      ? Promise.resolve(text)
      : Promise.reject(new OutboundError("http", `${url} returned 404`, 404));
  };

  it("follows a volume root's latest.json, and previews everything the operator chooses from", async () => {
    const { controller, admin } = placesHarness({ atlasGetText: serve });
    const { preview } = await controller.atlasInspect(
      signedEnv(admin, "places.atlas.inspect", { url: `${ROOT}/` }),
    );
    expect(preview).toMatchObject({
      volume: "us-west",
      version: "2026-08",
      versionUrl: `${ROOT}/2026-08`,
      revision: 1,
      createdAt: "2026-08-06T00:00:00.000Z",
      coverage: ["c2"],
      cellPrecision: 5,
      geometryCells: 0,
      retired: 0,
      categories: ["landmark", "park", "not-a-real-category"],
    });
    expect(preview.sources?.map((s) => s.id)).toEqual(["osm", "wikipedia"]);
  });

  it("reads a version URL as given", async () => {
    const { controller, admin } = placesHarness({ atlasGetText: serve });
    const { preview } = await controller.atlasInspect(
      signedEnv(admin, "places.atlas.inspect", { url: `${ROOT}/2026-08` }),
    );
    expect(preview.versionUrl).toBe(`${ROOT}/2026-08`);
  });

  it("reports a failing latest.json instead of reading the root as a version", async () => {
    const down = (url: string) =>
      url.endsWith("/latest.json")
        ? Promise.reject(new OutboundError("http", `${url} returned 503`, 503))
        : serve(url);
    const { controller, admin } = placesHarness({ atlasGetText: down });
    await expect(
      controller.atlasInspect(signedEnv(admin, "places.atlas.inspect", { url: `${ROOT}/` })),
    ).rejects.toThrow(/latest\.json.*503/);
  });

  it("never follows a latest.json out of the volume's root", async () => {
    const seen: string[] = [];
    const escaping = (url: string) => {
      seen.push(url);
      return url === `${ROOT}/latest.json`
        ? Promise.resolve(JSON.stringify({ version: "..", manifest: "../manifest.json" }))
        : serve(url);
    };
    const { controller, admin } = placesHarness({ atlasGetText: escaping });
    await expect(
      controller.atlasInspect(signedEnv(admin, "places.atlas.inspect", { url: `${ROOT}/` })),
    ).rejects.toThrow();
    expect(seen.some((url) => url.includes(".."))).toBe(false);
  });
});
