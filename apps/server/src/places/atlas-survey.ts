import {
  fetchHashed,
  tilePath,
  type CellTile,
  type Dictionary,
  type TileRecord,
  type VolumeReader,
  type VolumeRoot,
} from "@beaconsgg/atlas-volume";
import {
  placeCategorySchema,
  placeSubcategorySchema,
  type PlaceAtlasSurvey,
  type PlaceAtlasSurveyBucket,
  type PlaceAtlasSurveyResult,
} from "@beaconsgg/protocol-types";
import { Logger } from "@nestjs/common";
import { SnapshotParamsError, openAtlasVolume, scopeCells } from "./snapshot.service";

/**
 * Tiles read at once. A tile is a few hundred bytes to a few KB of static JSON, so the survey is
 * bound by request latency: at ~250 ms per request from object storage, 64 in flight surveys a
 * 50k-tile regional volume in a few minutes, where 16 took a quarter of an hour.
 */
const SURVEY_CONCURRENCY = 64;

/** How long a finished survey is kept, so the console can re-read it while the operator decides. */
const SURVEY_TTL_MS = 30 * 60 * 1000;

/**
 * A running survey nobody has polled for this long is stopped and forgotten: the console polls every
 * second while it shows one, so silence means the operator left, and the reads would be wasted.
 */
const SURVEY_ABANDON_MS = 2 * 60 * 1000;

/**
 * Surveys held at once. The oldest finished one is dropped first; a running one is never dropped,
 * so when this many are running a new one is refused until one finishes.
 */
const SURVEY_MAX = 16;

/**
 * Counts places by category and subcategory, and inside each by the three yes/no facts the import
 * options filter on. Kept separate from the fetching so it can be tested on plain tiles.
 */
export class SurveyTally {
  places = 0;
  tileBytes = 0;
  photoFiles = 0;
  /** Keyed by the tile's own category and subcategory indexes, named once in `result()`. */
  private readonly buckets = new Map<string, Bucket>();
  private readonly sources = new Map<string, number>();
  /**
   * Per dictionary subcategory, whether it is a valid slug. Counted as the import will store it: a
   * subcategory that is not one is dropped, and the place counts as having none.
   */
  private readonly validSubcategory: boolean[];

  constructor(private readonly dict: Dictionary) {
    this.validSubcategory = dict.subcategories.map(
      (slug) => placeSubcategorySchema.safeParse(slug).success,
    );
  }

  add(tile: CellTile, bytes: number): void {
    this.tileBytes += bytes;
    for (const record of tile.places) this.addPlace(record);
  }

  private addPlace(record: TileRecord): void {
    const sub =
      record.subcategory !== undefined && this.validSubcategory[record.subcategory]
        ? record.subcategory
        : -1;
    const files = record.media?.length ?? 0;
    // Bit 0 photos, bit 1 name, bit 2 description: one counter per combination that occurs.
    const flags = (files > 0 ? 1 : 0) | (record.name ? 2 : 0) | (record.description ? 4 : 0);

    const key = `${record.category}:${sub}`;
    let bucket = this.buckets.get(key);
    if (!bucket)
      this.buckets.set(key, (bucket = { category: record.category, sub, variants: new Map() }));
    const variant = bucket.variants.get(flags) ?? { places: 0, photoFiles: 0 };
    variant.places += 1;
    variant.photoFiles += files;
    bucket.variants.set(flags, variant);

    this.places += 1;
    this.photoFiles += files;
    record.sources.forEach((at, i) => {
      if (record.sources.indexOf(at) !== i) return; // a source listed twice counts once
      const id = this.dict.sources[at]?.id;
      if (id) this.sources.set(id, (this.sources.get(id) ?? 0) + 1);
    });
  }

  result(cells: number, root: VolumeRoot): PlaceAtlasSurveyResult {
    const media = root.manifest.media;
    const buckets: PlaceAtlasSurveyBucket[] = [...this.buckets.values()].map((bucket) => {
      const category = this.dict.categories[bucket.category] ?? `#${bucket.category}`;
      const subcategory = bucket.sub >= 0 ? this.dict.subcategories[bucket.sub] : undefined;
      return {
        category,
        ...(subcategory !== undefined ? { subcategory } : {}),
        supported: placeCategorySchema.safeParse(category).success,
        variants: [...bucket.variants]
          .sort(([a], [b]) => a - b)
          .map(([flags, counts]) => ({
            hasPhotos: (flags & 1) !== 0,
            hasName: (flags & 2) !== 0,
            hasDescription: (flags & 4) !== 0,
            ...counts,
          })),
      };
    });
    buckets.sort(
      (a, b) =>
        a.category.localeCompare(b.category) ||
        (a.subcategory ?? "").localeCompare(b.subcategory ?? ""),
    );
    return {
      cells,
      places: this.places,
      tileBytes: this.tileBytes,
      photoFiles: this.photoFiles,
      // The volume records only its total, so the area's share is estimated at the average file
      // size. Photos shared between places are counted once per place, so this leans high.
      mediaBytesEstimate:
        media.count > 0 ? Math.round((this.photoFiles * media.bytes) / media.count) : 0,
      buckets,
      sources: [...this.sources]
        .map(([id, places]) => ({ id, places }))
        .sort((a, b) => b.places - a.places),
    };
  }
}

interface Bucket {
  category: number;
  /** The subcategory's dictionary index, or -1 for none. */
  sub: number;
  variants: Map<number, { places: number; photoFiles: number }>;
}

interface SurveyJob {
  state: PlaceAtlasSurvey;
  touchedAt: number;
}

/**
 * `places.atlas.survey`: what a volume holds inside an area, counted before anything imports.
 *
 * The index only records places per cell, so the counts come from reading every tile in scope,
 * which for a whole regional volume is tens of thousands of requests. That is too slow for one
 * HTTP request, so a survey runs in the background and the op answers its current state; the
 * console polls with the same params. Jobs live in memory only: a survey is a convenience the
 * operator can rerun, never a record.
 */
export class AtlasSurveys {
  private readonly logger = new Logger("AtlasSurvey");
  private readonly jobs = new Map<string, SurveyJob>();
  /** Surveys between their first request and their job, so a second request joins the first. */
  private readonly starting = new Map<string, Promise<PlaceAtlasSurvey>>();

  constructor(private readonly now: () => number = () => Date.now()) {}

  /**
   * The survey for `key`, starting it if none is held. `open` supplies the reader only when a new
   * survey starts. The volume is verified before the job exists, so a bad target is an immediate
   * `SnapshotParamsError` rather than a job that fails.
   */
  async get(
    key: string,
    open: () => Promise<VolumeReader>,
    prefixes: readonly string[] | undefined,
  ): Promise<PlaceAtlasSurvey> {
    this.evict();
    const held = this.jobs.get(key);
    if (held) {
      held.touchedAt = this.now();
      // A failure is reported once and then forgotten, so asking again is the retry.
      if (held.state.status === "failed") this.jobs.delete(key);
      return held.state;
    }
    const pending = this.starting.get(key);
    if (pending) return pending;
    if (
      [...this.jobs.values()].filter((job) => job.state.status === "running").length >= SURVEY_MAX
    ) {
      throw new SnapshotParamsError("too many surveys are running; try again when one finishes");
    }

    const start = this.start(key, open, prefixes);
    this.starting.set(key, start);
    try {
      return await start;
    } finally {
      this.starting.delete(key);
    }
  }

  private async start(
    key: string,
    open: () => Promise<VolumeReader>,
    prefixes: readonly string[] | undefined,
  ): Promise<PlaceAtlasSurvey> {
    const reader = await open();
    const root = await openAtlasVolume(reader, this.logger);
    const cells = scopeCells(root, prefixes, undefined);
    if (cells.length === 0) {
      throw new SnapshotParamsError("the volume holds no cells in that coverage scope");
    }

    const job: SurveyJob = {
      state: { status: "running", tilesDone: 0, tilesTotal: cells.length },
      touchedAt: this.now(),
    };
    this.jobs.set(key, job);
    void this.run(key, job, reader, root, cells);
    return job.state;
  }

  private async run(
    key: string,
    job: SurveyJob,
    reader: VolumeReader,
    root: VolumeRoot,
    cells: string[],
  ): Promise<void> {
    const tally = new SurveyTally(root.dict);
    let next = 0;
    const worker = async () => {
      while (next < cells.length) {
        if (this.now() - job.touchedAt > SURVEY_ABANDON_MS) {
          next = cells.length;
          if (this.jobs.get(key) === job) this.jobs.delete(key);
          return;
        }
        const cell = cells[next++]!;
        const summary = root.index.get(cell)!;
        const tile = await fetchHashed<CellTile>(reader, tilePath(cell), summary.hash, "atlas");
        tally.add(tile, summary.bytes);
        job.state = { ...job.state, tilesDone: job.state.tilesDone + 1 };
      }
    };
    try {
      await Promise.all(Array.from({ length: Math.min(SURVEY_CONCURRENCY, cells.length) }, worker));
      if (this.jobs.get(key) !== job) return; // abandoned
      job.state = { ...job.state, status: "done", result: tally.result(cells.length, root) };
    } catch (err) {
      // Stop the other workers at their next tile: there is no partial result worth showing.
      next = cells.length;
      const error = err instanceof Error ? err.message : String(err);
      this.logger.warn(`survey failed: ${error}`);
      job.state = { ...job.state, status: "failed", error };
    }
  }

  /** Drop expired surveys, then the oldest finished ones beyond the cap. */
  private evict(): void {
    const now = this.now();
    for (const [key, job] of this.jobs) {
      if (job.state.status !== "running" && now - job.touchedAt > SURVEY_TTL_MS) {
        this.jobs.delete(key);
      }
    }
    const finished = [...this.jobs].filter(([, job]) => job.state.status !== "running");
    finished.sort(([, a], [, b]) => a.touchedAt - b.touchedAt);
    while (this.jobs.size >= SURVEY_MAX && finished.length > 0) {
      this.jobs.delete(finished.shift()![0]);
    }
  }
}
