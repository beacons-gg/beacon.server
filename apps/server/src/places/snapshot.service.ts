import {
  cellBounds,
  coarsestFitCover,
  coverageContains,
  coverageIntersects,
  encode,
  type BBox,
} from "@beaconsgg/geo";
import {
  canonicalJson,
  type GeoBBox,
  type LatLng,
  type PlaceAtlasImportOptions,
  type PlaceAtlasImportParams,
  type PlaceAtlasPreview,
  type PlaceExport,
  type PlaceSnapshotParams,
  type PlaceSnapshotStats,
} from "@beaconsgg/protocol-types";
import { Injectable, Logger, type OnApplicationBootstrap } from "@nestjs/common";
import { ulid } from "ulid";
import type { ServerConfig } from "../config";
import { liveView } from "../settings/live-config";
import { writeLocked } from "../common/capability-http";
import type {
  AtlasPinRecord,
  PlaceCommitEntry,
  PlaceConflictRecord,
  PlaceRecord,
  PlaceSnapshotRecord,
  PlaceSourceRecord,
  PlaceStore,
} from "../stores/place-store";
import type { MediaTransfer } from "../media/media-transfer";
import { openVolume, type VolumeReader, type VolumeRoot } from "@beaconsgg/atlas-volume";
import type { OutboundClient } from "../common/outbound-http";
import { AtlasConnector } from "./connectors/atlas";
import { canonicalPlace, cellsForPlace, remergeOrRetire } from "./canonical";
import type { MediaTransport, PlaceConnector, SourcePlace } from "./connectors/connector";
import {
  boundaryBBox,
  fromFeature,
  pointInBoundary,
  type ExportBoundary,
  type ImportedPlace,
} from "./export-import";
import { adminConflicts, isInputSource, mergeFields } from "./merge";

/** The snapshot knobs, lifted out of {@link ServerConfig} so the service is easy to test. */
export interface SnapshotConfig {
  enabled: boolean;
  cellPrecision: number;
  /**
   * This server's own host — what lets an Atlas import recognise a place that originated here as a
   * player contribution, instead of creating a second copy of it
   * (`apps/atlas/doc/spec/place-identity.md` §7).
   */
  host: string;
  /** Whether the server is locked read-only: a run admitted before the lock must not start after it. */
  writeLocked: boolean;
}
/** The snapshot run slice, as accessors over the live config — see settings/live-config.ts. */
export function snapshotConfigFrom(c: ServerConfig): SnapshotConfig {
  return liveView(c, {
    enabled: "placesEnabled",
    cellPrecision: "placesCellPrecision",
    host: "host",
    writeLocked: "writeLocked",
  });
}

/** The optional runner collaborators (kept off the positional list — they keep growing). */
export interface SnapshotServiceOptions {
  /** `| undefined` explicitly, so a caller may supply an accessor that reports media being off. */
  mediaTransfer?: MediaTransfer | undefined;
  now?: () => number;
}

/** How many recent snapshots a list fetch returns (the service owns its list limits). */
const SNAPSHOT_LIST_LIMIT = 50;

/** A create-time parameter rejection (a refused volume / a living input) — maps to `400`. */
export class SnapshotParamsError extends Error {}

/** The recorded boundary of a whole-dataset run (a source retire sweeps everything, everywhere). */
const WORLD_BBOX: GeoBBox = { minLat: -90, minLng: -180, maxLat: 90, maxLng: 180 };

/** Cap on the retirement sweep's SQL prefix cover (mirrors the export cover's discipline). */
const SWEEP_PREFIX_MAX = 64;

/**
 * Progress-write throttle: the run flushes `stats` to the durable snapshot record at most this
 * often — never once per chunk. A continent-scale boundary is 30k+ chunks, and the poll doesn't
 * need per-chunk resolution; one write per chunk is that many round-trips spent purely on progress.
 * The terminal status write (`trackRun`) always lands the final counts, retirement included.
 */
const PROGRESS_FLUSH_MS = 1000;

/**
 * How many elements one batched upsert slice covers — the runner's working-set bound (the three
 * batched reads and the in-memory identity/merge maps all scale with it). Statement size is NOT
 * this constant's job: the pg store bounds its own multi-row statements. At 500, a 225k-place
 * volume import is ~450 slices ≈ a few thousand round trips where per-element commits were ~1.8
 * million.
 */
const UPSERT_BATCH = 500;

/**
 * How many chunk fetches run ahead of the one being processed. Tiles are small static files, so
 * the window is sized for request latency; it holds at most this many parsed tiles in memory.
 */
const PREFETCH_DEPTH = 16;

/** One element queued for the batched upsert (media already re-hosted by the caller). */
interface UpsertItem {
  sp: SourcePlace;
  /** The import path's identity carry-over: a new place keeps the file's `unique` instead of minting. */
  forcedUnique?: string;
}

/** Group `items` by `key`, preserving first-appearance group order and in-group element order. */
function groupBy<T>(items: readonly T[], key: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const k = key(item);
    const list = groups.get(k);
    if (list) list.push(item);
    else groups.set(k, [item]);
  }
  return groups;
}

/** `openVolume` labelled "atlas" and warning to `logger`, its errors mapped to parameter errors. */
export async function openAtlasVolume(
  reader: VolumeReader,
  logger: Logger,
  expectedPublisher?: string,
): Promise<VolumeRoot> {
  try {
    return await openVolume(reader, {
      ...(expectedPublisher !== undefined ? { expectedPublisher } : {}),
      label: "atlas",
      warn: (message) => logger.warn(message),
    });
  } catch (err) {
    // A refused volume is the operator's input being wrong, not this server failing: 400, not 500.
    throw new SnapshotParamsError(err instanceof Error ? err.message : String(err));
  }
}

/**
 * The cells of an Atlas volume an import reads: those matching the coverage-style `prefixes` (by
 * the rule discovery matches coverage with) AND overlapping `boundary`, each when given. The survey
 * counts with this too, so its numbers describe exactly what the import would read.
 */
export function scopeCells(
  root: VolumeRoot,
  prefixes: readonly string[] | undefined,
  box: BBox | undefined,
): string[] {
  return [...root.index.keys()].filter((cell) => {
    if (prefixes && !coverageIntersects(prefixes, [cell])) return false;
    if (!box) return true;
    const b = cellBounds(cell);
    return (
      b.minLat <= box.maxLat &&
      b.maxLat >= box.minLat &&
      b.minLng <= box.maxLng &&
      b.maxLng >= box.minLng
    );
  });
}

/**
 * Which of an Atlas import's filters excludes a place: `"type"` (`skipTypes`, never retired) or
 * `"content"` (photo, name, description: what `retireFiltered` retires). `undefined` when the place
 * passes. The category filter is not here: the connector applies it while reading the tile, and the
 * retirement sweep knows it separately.
 */
export function excludedBy(
  fields: SourcePlace["fields"],
  options: PlaceAtlasImportOptions,
): "type" | "content" | undefined {
  if (isSkippedType(fields, options.skipTypes)) return "type";
  if (options.requirePhotos && !(fields.media && fields.media.length > 0)) return "content";
  if (options.requireName && !fields.name) return "content";
  if (options.requireDescription && !fields.description) return "content";
  return undefined;
}

/** Whether `skipTypes` names a place's type: an exact match, a pair without a subcategory naming the places that have none. */
function isSkippedType(
  fields: { category?: string | undefined; subcategory?: string | undefined },
  skipTypes: PlaceAtlasImportOptions["skipTypes"],
): boolean {
  return (
    skipTypes?.some(
      (type) => type.category === fields.category && type.subcategory === fields.subcategory,
    ) ?? false
  );
}

/**
 * The area an Atlas import was asked for, as the operator gave it. The run reads whole volume
 * cells, so a cell that only overlaps the area is read in full; this is the exact area, which
 * `retireFiltered` is held to.
 */
export interface ImportArea {
  /** Coverage-style geohash prefixes (`cells`); absent means no prefix limit. */
  prefixes?: readonly string[] | undefined;
  /** The requested `boundary` (bbox or polygon); absent means no boundary limit. */
  boundary?: ExportBoundary | undefined;
}

/**
 * What `retireFiltered` and `retireUnselectedTypes` hand the sweep: the area both are held to, the
 * source ids the run read and released (with the filter that excluded each), and whether records of
 * categories the run never read are to be retired too.
 */
interface Release {
  area: ImportArea;
  ids: Map<string, "content" | "type">;
  unselectedTypes: boolean;
}

/**
 * Whether a place's own point lies inside the requested area. A place with no point is never
 * provably inside, so it is never released for retirement.
 */
export function inImportArea(point: LatLng | undefined, area: ImportArea): boolean {
  if (!point) return false;
  if (area.prefixes && area.prefixes.length > 0) {
    // Hashed only as deep as the longest prefix: that is all `startsWith` can compare.
    const depth = Math.max(1, ...area.prefixes.map((prefix) => prefix.length));
    if (!coverageContains(area.prefixes, encode(point, depth))) return false;
  }
  if (area.boundary && !pointInBoundary(point, area.boundary)) return false;
  return true;
}

/**
 * The fields with their photos removed when the import was asked not to download any. Removing the
 * key, not emptying it, matters: an absent `media` keeps photos the place already holds.
 */
function withoutMediaUnless(
  fields: SourcePlace["fields"],
  options: PlaceAtlasImportOptions,
): SourcePlace["fields"] {
  if (options.importPhotos !== false || fields.media === undefined) return fields;
  const { media: _media, ...rest } = fields;
  return rest;
}

/** Terminal `error` line for a run whose in-process runner died with a server restart. */
const INTERRUPTED_REASON = "interrupted by server restart";

/** Terminal `error` line for a run an admin closed out via the cancel surface. */
const CANCELLED_REASON = "cancelled by admin";

/**
 * The retirement sweep's store-scan scoping: a small prefix cover of the boundary — never the
 * raw chunk list (a p2 boundary = 32k chunks, one bind parameter and one `LIKE` each). Over-selection
 * is fine; the precise in-scope gate stays with the caller ({@link coarsestFitCover}).
 */
export function sweepPrefixCover(bbox: BBox, chunkPrecision: number): string[] {
  return coarsestFitCover(bbox, { precision: chunkPrecision, maxCells: SWEEP_PREFIX_MAX });
}

/** The union bbox of a set of cells — the recorded boundary of a whole-volume import. */
function bboxOfCells(cells: readonly string[]): GeoBBox {
  let minLat = 90;
  let minLng = 180;
  let maxLat = -90;
  let maxLng = -180;
  for (const cell of cells) {
    const b = cellBounds(cell);
    minLat = Math.min(minLat, b.minLat);
    minLng = Math.min(minLng, b.minLng);
    maxLat = Math.max(maxLat, b.maxLat);
    maxLng = Math.max(maxLng, b.maxLng);
  }
  return { minLat, minLng, maxLat, maxLng };
}

const EMPTY_STATS: PlaceSnapshotStats = {
  chunksDone: 0,
  chunksTotal: 0,
  fetched: 0,
  created: 0,
  updated: 0,
  unchanged: 0,
  skipped: 0,
  retired: 0,
  conflicts: 0,
  imagesIngested: 0,
  filtered: 0,
};

/**
 * The ingestion runner (`doc/spec/places.md` §6.2) — admin-triggered population of the owned
 * dataset, from the three place inputs and nothing else
 * (`apps/atlas/doc/spec/beacon-integration.md` §6): an Atlas volume import, a `list:` interchange
 * file, the operator's own curation. No persistent connector exists any more — an Atlas run
 * constructs its connector from the volume being imported, uses it, and discards it. Runs execute
 * **serially** (deterministic retirement) on an in-process chain. Per element the upsert-merge
 * flow: existing source record → skip when byte-identical (`unchanged`) → replace +
 * `adminConflicts` (never applying a value the admin holds) → `mergeFields` over all live sources →
 * one transactional `commitPlaces` per batched slice ({@link UPSERT_BATCH} elements, accumulated
 * across chunks). After all chunks it retires **scope-aware**: only this source's records whose
 * cell was actually queried (and whose category was in the filter) can be marked gone;
 * admin-touched places never retire.
 */
@Injectable()
export class SnapshotService implements OnApplicationBootstrap {
  private readonly logger = new Logger("PlaceSnapshots");
  private readonly now: () => number;
  /** The serial run queue — snapshot runs never overlap. */
  private queue: Promise<void> = Promise.resolve();
  /**
   * Cooperative-cancel flags for runs live in THIS process, keyed by snapshot id. `enqueue` seeds
   * one, `trackRun` clears it, and the run loop checks it at each chunk boundary. A run orphaned by
   * a restart has no entry here — cancelling it is a pure DB flip (there is nothing to signal).
   */
  private readonly runControls = new Map<string, { aborted: boolean }>();

  constructor(
    private readonly store: PlaceStore,
    private readonly cfg: SnapshotConfig,
    private readonly opts: SnapshotServiceOptions = {},
  ) {
    this.now = opts.now ?? (() => Date.now());
  }
  /**
   * Read per use rather than captured, so a caller may supply it as an accessor.
   *
   * `app.module` does exactly that: media is a runtime capability now, and the transfer used to be
   * omitted entirely when `mediaEnabled` was false at boot (`doc/spec/runtime-settings.md` §3.4).
   * Enabling media later then fixed the routes and left snapshot runs with no way to fetch a photo
   * for the life of the process.
   */
  private get mediaTransfer(): MediaTransfer | undefined {
    return this.opts.mediaTransfer;
  }

  /** Whether the places capability is enabled (admin routes 404 when off). */
  get enabled(): boolean {
    return this.cfg.enabled;
  }

  /**
   * Boot-time reconciliation: runs live in an in-process serial queue, so any run left `queued`/
   * `running` in the durable log is orphaned — its runner died with the previous process and can
   * never reach a terminal state. Flip them to `failed` once, before the server starts serving (no
   * run can have been enqueued in THIS process yet), so a mid-run restart self-heals on next boot.
   */
  async onApplicationBootstrap(): Promise<void> {
    // Unconditional: closing out interrupted runs is data hygiene, not a capability. Gated on
    // `placesEnabled` it was skipped exactly when it was most needed — a server that crashed
    // mid-run and came back with places off left those rows stuck `running` forever, including
    // after an admin turned places back on, because this hook only ever runs at boot.
    const flipped = await this.store.failSnapshots(INTERRUPTED_REASON, this.nowIso());
    if (flipped > 0) {
      this.logger.warn(`closed out ${flipped} interrupted snapshot run(s) after restart`);
    }
  }

  /**
   * Persist a `queued` run for `connector` over the given chunk cells and enqueue it — the chunked
   * engine's one entry, shared by the Atlas import (a volume's index cells are its chunks) and by
   * tests driving the run loop directly. Returns the record immediately; progress is polled via
   * `places.snapshots.fetch`. The stored `source` is `connector.id` **by construction** — the name
   * the run is recorded under, the name its records upsert under, and the retirement scope cannot
   * diverge, because only the connector supplies it.
   */
  createRun(
    connector: PlaceConnector,
    scope: Omit<PlaceSnapshotParams, "source">,
    requestedBy: string,
    chunks: string[],
    opts: { cleanup?: (() => Promise<void>) | undefined; area?: ImportArea | undefined } = {},
  ): Promise<PlaceSnapshotRecord> {
    const params: PlaceSnapshotParams = { source: connector.id, ...scope };
    return this.enqueue(params.source, params, requestedBy, chunks.length, async (id, stats) => {
      try {
        await this.run(id, stats, connector, params, chunks, opts.area);
      } finally {
        // A staged archive is transient by design — deleted however the run ends. Runs with
        // nothing held pass no cleanup.
        await opts.cleanup?.();
      }
    });
  }

  /**
   * The deliberate close-out for a source that is **no longer an input**
   * (`op:"places.source.retire"`, `apps/atlas/doc/spec/beacon-integration.md` §6): mark every live
   * record of `source` gone and re-merge or retire each affected place, as a durable, cancellable
   * run. This is the migration path for the residue the deleted OSM connectors left behind — which
   * stays live and merge-ranked *last* until the operator runs this, because retiring it earlier
   * would forfeit more than fields: **adoption follows only live records**, so an Atlas import must
   * land on the `osm`-held places *first* (same `sourceId`, `apps/atlas/doc/spec/place-identity.md`
   * §6) for their identity — and the edits and contributions keyed to it — to survive the
   * close-out. Places whose only live source was the retired one soft-retire, which is the recorded
   * cost of the three-inputs decision; admin-touched places never retire.
   *
   * Refused for a living input: `admin`, `contrib`, `list:*` and `atlas:*` records each retire
   * through their own lifecycle (an edit clear, replace-the-list, a re-import's sweep) — bulk-going
   * one of those is never a migration, so the guard is {@link isInputSource} itself.
   */
  async createSourceRetire(source: string, requestedBy: string): Promise<PlaceSnapshotRecord> {
    if (isInputSource(source)) {
      throw new SnapshotParamsError(
        `${JSON.stringify(source)} is a living place input — its records retire through their ` +
          "own lifecycle, never in bulk",
      );
    }
    return this.enqueue(source, { source, boundary: WORLD_BBOX }, requestedBy, 1, (id, stats) =>
      this.runRetire(id, stats, source),
    );
  }

  /**
   * Land an interchange file as the `list:<name>` source (`doc/spec/places.md` §7): a durable,
   * queued run through the same upsert/merge/conflict pipeline as every connector, with
   * **replace-the-list** retirement (a live `list:<name>` record absent from the file goes gone).
   * Features keep their `unique`, so a re-import updates in place and cross-server identity holds.
   * Media entries are re-hosted by content-addressed transfer (hash-verified); with the media
   * capability off they are dropped (this server could neither verify nor serve them).
   */
  async createImport(
    name: string,
    collection: PlaceExport,
    requestedBy: string,
  ): Promise<PlaceSnapshotRecord> {
    const source = `list:${name}`;
    const entries = collection.features.map(fromFeature);
    if (entries.length === 0) throw new SnapshotParamsError("empty collection");

    // The stored params make the run auditable; the file itself is not persisted (a re-import
    // is a new upload, not a params re-run).
    return this.enqueue(
      source,
      { source, boundary: bboxOfPoints(entries) },
      requestedBy,
      1,
      (id, stats) => this.runImport(id, stats, source, entries),
    );
  }

  /**
   * Read a volume's manifest and answer the preview an operator confirms *before* anything imports
   * (`places.atlas.inspect`): identity, size, and above all **who signed it** and how that compares
   * to the pin. No expected publisher here — the signature is verified against the did the manifest
   * itself names, because "who is this from?" is exactly the question the operator is asking.
   */
  async inspectAtlas(
    reader: VolumeReader,
    opts: { versionUrl?: string | undefined } = {},
  ): Promise<PlaceAtlasPreview> {
    const root = await this.openAtlas(reader, undefined);
    const manifest = root.manifest;
    const pinned = await this.store.getAtlasPublisher(manifest.volume);
    const pin =
      pinned === undefined ? "new" : pinned === manifest.publisher ? "pinned" : "mismatch";
    let tileBytes = 0;
    let geometryCells = 0;
    for (const summary of root.index.values()) {
      tileBytes += summary.bytes;
      if (summary.geomHash !== undefined) geometryCells += 1;
    }
    return {
      volume: manifest.volume,
      version: manifest.version,
      places: manifest.places,
      cells: root.index.size,
      publisher: manifest.publisher,
      media: manifest.media.count,
      mediaBytes: manifest.media.bytes,
      pin,
      ...(pin === "mismatch" && pinned !== undefined ? { pinnedPublisher: pinned } : {}),
      // The rest is what the operator reads before choosing what to import: all of it from the
      // verified root, nothing fetched beyond the three files inspect already read.
      ...(opts.versionUrl !== undefined ? { versionUrl: opts.versionUrl } : {}),
      revision: manifest.revision,
      createdAt: manifest.createdAt,
      bounds: { ...manifest.bounds },
      coverage: [...manifest.coverage],
      cellPrecision: manifest.cellPrecision,
      tileBytes,
      geometryCells,
      retired: manifest.retired?.length ?? 0,
      categories: [...root.dict.categories],
      subcategories: [...root.dict.subcategories],
      sources: root.dict.sources.map((source) => ({
        id: source.id,
        name: source.name,
        attribution: source.attribution,
        license: source.license,
        ...(source.licenseUrl !== undefined ? { licenseUrl: source.licenseUrl } : {}),
      })),
      inputs: manifest.inputs.map(({ source, artifact }) => ({ source, artifact })),
    };
  }

  /**
   * One durable, one-shot Atlas import (`places.atlas.import`) — the runtime replacement for the
   * deploy-time `BEACON_PLACES_ATLAS` mechanism, which made "trust this volume" a redeploy.
   *
   * Verification happens **before** anything is enqueued: the signature against the publisher the
   * operator restated from the inspect preview, then the pin — created on first import (recording
   * the operator's decision at the moment they made it), matched forever after, with a mismatch
   * refusing the run and naming the `places.atlas.unpin` escape. Then the run itself is the plain
   * snapshot pipeline: the volume's **own index cells** are the chunks (never a bbox grid — a
   * volume's bbox covers ocean its index never mentions), so `run()`'s per-cell upsert, media
   * re-hosting, progress, cancel and scope-aware retirement all apply unchanged.
   */
  async createAtlasImport(
    reader: VolumeReader,
    params: PlaceAtlasImportParams,
    requestedBy: string,
    opts: { outbound: OutboundClient; cleanup?: () => Promise<void> },
  ): Promise<PlaceSnapshotRecord> {
    const root = await this.openAtlas(reader, params.publisher);
    const volume = root.manifest.volume;

    // The volume's own cells, optionally scoped. `cells` are coverage-style geohash prefixes (the
    // descriptor's own vocabulary, so "import what this server covers" is a copy-paste), matched by
    // the SAME rule discovery matches coverage with — one definition, so import scope and discovery
    // can never drift apart on what a prefix means. `boundary` stays the bbox-level
    // over-approximation the osm path already accepts for its chunk cover. The two AND together.
    const boundary = params.boundary ? boundaryBBox(params.boundary) : undefined;
    const cells = scopeCells(root, params.cells, boundary);
    // No cleanup here or on any parameter error: a staged tree is deleted by the run's `finally`
    // or the boot sweep, never by a rejection — "no cells in that scope" is exactly the error an
    // operator retries with a corrected scope, against the same staged id, without re-uploading.
    if (cells.length === 0) {
      throw new SnapshotParamsError("the volume holds no cells in that boundary/coverage scope");
    }

    const pinnedNow = await this.store.pinAtlasPublisher(
      volume,
      params.publisher,
      this.nowIso(),
      requestedBy,
    );
    if (!pinnedNow) {
      const current = await this.store.getAtlasPublisher(volume);
      throw new SnapshotParamsError(
        `volume ${JSON.stringify(volume)} is pinned to ${String(current)} — a different publisher ` +
          "is refused. Rotating the key is a deliberate act: run places.atlas.unpin first.",
      );
    }

    const connector = new AtlasConnector(reader, root, opts.outbound, volume, this.cfg.host);

    // The stored scope is the plain snapshot shape, so the run reads in the console like any
    // other: the boundary recorded is what the missing-place sweep was scoped by. `retireFiltered`
    // is held to the exact area instead, passed as `area` below.
    // URL imports pass no cleanup: nothing was ever held.
    return this.createRun(
      connector,
      {
        boundary: boundary ?? bboxOfCells(cells),
        ...(params.categories && params.categories.length > 0
          ? { categories: params.categories }
          : {}),
        ...(params.options && Object.keys(params.options).length > 0
          ? { options: params.options }
          : {}),
      },
      requestedBy,
      cells,
      // The area as requested: the polygon itself, never the bbox the chunk cover uses.
      { cleanup: opts.cleanup, area: { prefixes: params.cells, boundary: params.boundary } },
    );
  }

  /** Forget a volume's publisher pin (`places.atlas.unpin`) — returns whether one existed. */
  unpinAtlas(volume: string): Promise<boolean> {
    return this.store.unpinAtlasPublisher(volume);
  }

  /** Every pin this server holds (`places.atlas.pins.fetch`) — the audit list revocation starts from. */
  listAtlasPins(): Promise<AtlasPinRecord[]> {
    return this.store.listAtlasPublishers();
  }

  private openAtlas(reader: VolumeReader, expectedPublisher: string | undefined) {
    return openAtlasVolume(reader, this.logger, expectedPublisher);
  }

  /** Persist the durable run record and chain it onto the serial queue (shared by both run kinds). */
  private async enqueue(
    source: string,
    params: PlaceSnapshotParams,
    requestedBy: string,
    chunksTotal: number,
    run: (id: string, stats: PlaceSnapshotStats) => Promise<void>,
  ): Promise<PlaceSnapshotRecord> {
    const snapshot: PlaceSnapshotRecord = {
      id: ulid(this.now()),
      source,
      params,
      requestedBy,
      status: "queued",
      stats: { ...EMPTY_STATS, chunksTotal },
      createdAt: this.nowIso(),
    };
    // Checked here because an import does slow work between passing the lock's guard and arriving
    // here. The control goes in before the await, so `hasActiveRun` closes the window from the
    // other side: from this point a lock is refused.
    if (this.cfg.writeLocked) writeLocked();
    this.runControls.set(snapshot.id, { aborted: false }); // cancellable from the moment it's queued
    try {
      await this.store.createSnapshot(snapshot);
    } catch (err) {
      this.runControls.delete(snapshot.id);
      throw err;
    }

    this.queue = this.queue.then(() =>
      this.trackRun(snapshot.id, chunksTotal, run).catch((err: unknown) => {
        this.logger.error(
          `run ${snapshot.id} (${source}) crashed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }),
    );
    return snapshot;
  }

  /** The shared status/stats envelope: running → body → done, any throw → failed + error. */
  private async trackRun(
    id: string,
    chunksTotal: number,
    body: (id: string, stats: PlaceSnapshotStats) => Promise<void>,
  ): Promise<void> {
    try {
      // A run cancelled while still queued never enters `running` — `cancel` already wrote the
      // terminal row, so honour it instead of flipping it back to running for a no-op pass.
      if (this.runControls.get(id)?.aborted) return;
      await this.store.updateSnapshot(id, { status: "running", startedAt: this.nowIso() });
      const stats: PlaceSnapshotStats = { ...EMPTY_STATS, chunksTotal };
      try {
        await body(id, stats);
        // A cancel that landed during the final chunk (past the loop's last abort check) or its
        // retirement sweep still wins — honour it rather than labelling a closed-out run `done`.
        if (this.runControls.get(id)?.aborted) {
          await this.store.updateSnapshot(id, {
            status: "failed",
            stats,
            error: CANCELLED_REASON,
            finishedAt: this.nowIso(),
          });
        } else {
          await this.store.updateSnapshot(id, { status: "done", stats, finishedAt: this.nowIso() });
        }
      } catch (err) {
        await this.store.updateSnapshot(id, {
          status: "failed",
          stats,
          error: err instanceof Error ? err.message : String(err),
          finishedAt: this.nowIso(),
        });
      }
    } finally {
      this.runControls.delete(id); // the run is terminal — nothing left to signal
    }
  }

  /**
   * Whether a run is queued or running in this process. A run writes for as long as it lasts, so a
   * read-only lock must not be set under one. Read off the in-process run controls rather than the
   * durable log: a run lives only in this process's queue, and every run holds a control from the
   * moment it is queued until it is terminal.
   */
  hasActiveRun(): boolean {
    return this.runControls.size > 0;
  }

  /**
   * Close out one run (`op:"places.snapshot.cancel"`). Terminal runs are an idempotent no-op; a run
   * live in this process is flagged so its loop stops at the next chunk boundary; either way the
   * durable row is flipped to `failed` + {@link CANCELLED_REASON} for immediate operator feedback.
   * Returns the updated record, or `undefined` when the id is unknown (the controller maps it 404).
   */
  async cancel(id: string): Promise<PlaceSnapshotRecord | undefined> {
    const snapshot = await this.store.getSnapshot(id);
    if (!snapshot) return undefined;

    const control = this.runControls.get(id);
    if (control) control.aborted = true; // an in-process runner drops out at its next chunk boundary
    // Conditional flip: a no-op when the run already reached done/failed, so a cancel racing a
    // finishing run can't clobber its terminal state. Idempotent — re-cancelling changes nothing.
    await this.store.failSnapshots(CANCELLED_REASON, this.nowIso(), id);
    return (await this.store.getSnapshot(id)) ?? snapshot;
  }

  /** Throw {@link CANCELLED_REASON} if this run's cooperative abort flag is set — the ONE cancel
   *  check both run loops make between units of work, so the semantics can't drift apart. */
  private throwIfCancelled(id: string): void {
    if (this.runControls.get(id)?.aborted) throw new Error(CANCELLED_REASON);
  }

  /**
   * A self-throttling durable progress writer for one run — at most one write per
   * {@link PROGRESS_FLUSH_MS}, shared by both run loops so the poll cadence has one definition.
   * The terminal status write (`trackRun`) always lands the final counts regardless.
   */
  private progressWriter(id: string): (stats: PlaceSnapshotStats) => Promise<void> {
    let lastFlush = this.now();
    return async (stats) => {
      const nowMs = this.now();
      if (nowMs - lastFlush >= PROGRESS_FLUSH_MS) {
        await this.store.updateSnapshot(id, { stats });
        lastFlush = nowMs;
      }
    };
  }

  /** Settles when every enqueued run has finished (tests + graceful shutdown). */
  idle(): Promise<void> {
    return this.queue;
  }

  /** Pass-throughs so the admin controller stays store-free. */
  getPlace(unique: string): Promise<PlaceRecord | undefined> {
    return this.store.getPlace(unique);
  }
  getSnapshot(id: string): Promise<PlaceSnapshotRecord | undefined> {
    return this.store.getSnapshot(id);
  }
  listSnapshots(limit: number = SNAPSHOT_LIST_LIMIT): Promise<PlaceSnapshotRecord[]> {
    return this.store.listSnapshots(limit);
  }

  private async run(
    id: string,
    stats: PlaceSnapshotStats,
    connector: PlaceConnector,
    params: PlaceSnapshotParams,
    chunks: string[],
    /** Absent: no area was given, so `retireFiltered` releases nothing. */
    area: ImportArea | undefined,
  ): Promise<void> {
    const seen = new Set<string>();
    const leftOut = new Set<string>();
    const options = params.options ?? {};
    // Places the filters exclude inside the area, which `retireFiltered` (content) and
    // `retireUnselectedTypes` (type) hand to the sweep. Never without an area: none given means none
    // to hold the retirement to.
    const release: Release | undefined =
      (options.retireFiltered === true || options.retireUnselectedTypes === true) && area
        ? {
            area,
            ids: new Map(),
            // Only with a type left out: otherwise there is nothing for it to retire.
            unselectedTypes:
              options.retireUnselectedTypes === true &&
              ((params.categories?.length ?? 0) > 0 || (options.skipTypes?.length ?? 0) > 0),
          }
        : undefined;
    const transport = connector.mediaTransport;
    const fetchAt = (i: number): Promise<SourcePlace[]> =>
      connector.fetchChunk(cellBounds(chunks[i]!), params.categories);

    // A prefetch window: the next PREFETCH_DEPTH chunks' fetches (remote volume-tile reads) ride in
    // flight while chunk N's rows are prepared/flushed. A tile read is latency, not bandwidth, so
    // one in flight left a regional import waiting on ~50k round trips back to back. Processing
    // and retirement order are unchanged: only the fetches are pulled forward.
    const pending: Promise<SourcePlace[]>[] = [];
    let nextFetch = 0;
    const fill = () => {
      while (nextFetch < chunks.length && pending.length < PREFETCH_DEPTH) {
        const fetch = fetchAt(nextFetch++);
        // Observed now: a fetch can fail while an earlier chunk is still awaited, and an unobserved
        // rejection in that gap would take the process down. The await below still sees the error.
        fetch.catch(() => {});
        pending.push(fetch);
      }
    };
    fill();
    const flushProgress = this.progressWriter(id);
    // Elements accumulate ACROSS chunks and upsert in batched slices: an Atlas volume's chunks are
    // its index cells, averaging a handful of places each, so a commit per chunk would still be
    // 50k transactions against a remote database.
    const batch: UpsertItem[] = [];
    try {
      for (let i = 0; i < chunks.length; i++) {
        // Cooperative cancel: bail at the chunk boundary (trackRun writes `failed` + the reason).
        this.throwIfCancelled(id);
        const found = await pending.shift()!;
        fill();
        stats.fetched += found.length;
        for (const sp of found) {
          if (seen.has(sp.sourceId)) continue; // border elements can appear in two chunks
          // Marked seen even when filtered out: a place the options exclude is left untouched, so
          // the retirement sweep below must not read its absence as "gone from the volume".
          seen.add(sp.sourceId);
          const excluded = excludedBy(sp.fields, options);
          if (excluded) {
            stats.filtered = (stats.filtered ?? 0) + 1;
            // `retireFiltered` releases a place the content filters exclude, and
            // `retireUnselectedTypes` one `skipTypes` excludes, to the sweep: only when its own point
            // is inside the requested area, so a place read only because its cell overlaps the area
            // is never retired.
            const releasing =
              excluded === "content" ? options.retireFiltered === true : release?.unselectedTypes;
            if (release && releasing && inImportArea(sp.fields.point, release.area)) {
              release.ids.set(sp.sourceId, excluded);
            }
            continue;
          }
          // A connector that supplies media supplies *pointers*; the bytes are re-hosted here, before
          // the upsert, for the same two reasons the import path does it there. Nothing a connector
          // named is ever stored as-is — see `rehost`.
          const fields = await this.rehost(
            withoutMediaUnless(sp.fields, options),
            stats,
            leftOut,
            transport,
          );
          batch.push({ sp: { ...sp, fields } });
        }
        if (batch.length >= UPSERT_BATCH) {
          await this.upsertMany(connector.id, batch.splice(0), id, stats);
        }
        stats.chunksDone += 1;
        await flushProgress(stats);
      }
      await this.upsertMany(connector.id, batch.splice(0), id, stats);
    } finally {
      // A mid-loop throw leaves the prefetch in flight: let it settle before the run ends, so the
      // run's cleanup (a staged tree's deletion) never races a read still under way.
      await Promise.all(pending.map((fetch) => fetch.catch(() => {})));
    }
    await this.retireGone(connector.id, params, chunks, seen, stats, release);
  }

  /**
   * Re-host any media a source supplied, replacing its pointers with this server's own addresses.
   *
   * **One mechanism for both paths**, because the rule is the same for a GeoJSON import and for an Atlas
   * volume: *this server never serves bytes it does not hold*. `contributions.service.ts` states the reason
   * at length — keeping a foreign pointer means the place serves bytes from a host we do not control, "with
   * whoever owns that host free to swap them afterwards". Media transfer is also gated on the media
   * capability, so on a places-without-media server there is no store to check and the entries must go
   * rather than be stored unfetched.
   *
   * Three details, each of which is a bug if reversed:
   *
   * - **Before `upsert`**, so `uris` is already the stable local id by the time the refresh no-op compares
   *   fields. After it, every place would rewrite on every run.
   * - **`delete`, never `[]`** on an empty result. The media policy tests `fields.media !== undefined`, so an
   *   empty array counts as "this source supplies media" and blanks the place's photos — meaning one
   *   transient CDN outage would strip every picture in the volume.
   * - **Locally-held bytes cost no network** (`lookupIngested`), which is what makes a steady-state re-import
   *   one cheap store lookup per entry instead of a re-download storm.
   *
   * `leftOut` is the run's set of photos the store had no room for (`MediaTransfer.transfer`). A set,
   * so a photo many places share counts once in `imagesStorageFull`, the number an operator reads
   * as what to make room for.
   */
  private async rehost(
    fields: SourcePlace["fields"],
    stats: PlaceSnapshotStats,
    leftOut: Set<string>,
    transport?: MediaTransport,
  ): Promise<SourcePlace["fields"]> {
    if (fields.media === undefined) return fields;
    const out = { ...fields };
    // The transport passed whole, not spread field by field: its members are required, so a conditional
    // spread would be inert — and passing the object keeps `origin` bound to its receiver. It also carries
    // the source's own client, which is why a volume's photos need no second `MediaTransfer` to skip the
    // Wikimedia pacing.
    const result = this.mediaTransfer
      ? await this.mediaTransfer.transfer(fields.media, transport ?? {}, leftOut)
      : { media: [], fetched: 0 };
    // Only bytes that actually moved. Counting everything that *verified* would report ~17k ingests on a
    // re-import where every photo was already held locally and nothing was downloaded.
    stats.imagesIngested += result.fetched;
    if (leftOut.size > 0) stats.imagesStorageFull = leftOut.size;
    if (result.media.length > 0) out.media = result.media;
    else delete out.media;
    return out;
  }

  /** The batched upsert entry: hands `items` to {@link upsertSlice} in {@link UPSERT_BATCH} slices. */
  private async upsertMany(
    source: string,
    items: readonly UpsertItem[],
    snapshotId: string,
    stats: PlaceSnapshotStats,
  ): Promise<void> {
    for (let i = 0; i < items.length; i += UPSERT_BATCH) {
      await this.upsertSlice(source, items.slice(i, i + UPSERT_BATCH), snapshotId, stats);
    }
  }

  /**
   * The upsert-merge flow (`doc/spec/places.md` §3.1) for one slice of elements: three batched
   * reads, the per-element decisions in memory, one transactional {@link PlaceStore.commitPlaces}
   * write.
   *
   * **Semantically element-by-element.** Every decision below replays what committing the elements
   * one at a time would have done — including what each element would have seen of the ones before
   * it (`assignedTo`), so batching never changes which place an element lands on. What changes is
   * the cost: ~8 sequential statements per element made a 225k-place volume import 90 minutes of
   * round-trip waits against a remote database; a slice is a handful of statements per 500.
   */
  private async upsertSlice(
    source: string,
    items: readonly UpsertItem[],
    snapshotId: string,
    stats: PlaceSnapshotStats,
  ): Promise<void> {
    if (items.length === 0) return;
    const nowIso = this.nowIso();

    // Read 1 — this source's own records: the primary identity, and the refresh comparison.
    const existingOf = new Map(
      (
        await this.store.getSources(
          source,
          items.map((it) => it.sp.sourceId),
        )
      ).map((r) => [r.sourceId, r]),
    );

    interface Prepared extends UpsertItem {
      existing: PlaceSourceRecord | undefined;
      fields: PlaceSourceRecord["fields"];
    }
    const prepared: Prepared[] = [];
    for (const item of items) {
      const existing = existingOf.get(item.sp.sourceId);
      // Media policy: a source that *supplies* media (a volume, an import) wins outright; one that
      // doesn't keeps whatever its record already ingested — a refresh never strips photos.
      const fields: PlaceSourceRecord["fields"] = { ...item.sp.fields };
      if (fields.media === undefined && existing?.fields.media) {
        fields.media = existing.fields.media;
      }
      // Refresh no-op: identical live source data means the merge inputs (and therefore the
      // canonical row, cells, and any conflicts) are identical too — skip every write. This turns a
      // steady-state re-run from O(N) writes into O(changed), and keeps re-runs from re-logging the
      // same admin conflicts. (`syncedAt` intentionally stays at the last *change*.)
      if (
        existing &&
        existing.goneAt === undefined &&
        canonicalJson({
          f: existing.fields,
          r: existing.raw ?? null,
          a: existing.attribution ?? null,
        }) === canonicalJson({ f: fields, r: item.sp.raw ?? null, a: item.sp.attribution ?? null })
      ) {
        stats.unchanged += 1;
        continue;
      }
      prepared.push({ ...item, existing, fields });
    }
    if (prepared.length === 0) return;

    // Read 2 — the cross-source identity step: the place another source already holds under an
    // element's id, or one of its former ids. Without it, the moment a second source describes a
    // place the server already has, it mints a duplicate: a server that snapshotted `osm` and then
    // imports an Atlas volume duplicates every place, and two volumes covering one region duplicate
    // every overlap (`apps/atlas/doc/spec/beacon-integration.md` §4). Runner-level, not
    // Atlas-specific — two sources naming the same `sourceId` are describing the same thing whoever
    // they are; the id space is namespaced to keep that true
    // (`apps/atlas/doc/spec/place-identity.md` §6). Asked only when nothing else already answers
    // it: `existing` answers for this source's own record, and a `forcedUnique` outranks the
    // answer.
    const candidates = new Set<string>();
    for (const p of prepared) {
      if (p.existing || p.forcedUnique !== undefined) continue;
      candidates.add(p.sp.sourceId);
      for (const alias of p.sp.aliasSourceIds ?? []) candidates.add(alias);
    }
    const owners = new Map(
      (await this.store.placeUniquesForSourceIds([...candidates])).map((o) => [o.sourceId, o]),
    );

    // Identity assignment, in element order. `assignedTo` mirrors what the store would already
    // hold had the earlier elements committed one at a time, so an element whose alias names an id
    // this very slice introduces still adopts that place instead of minting a duplicate. Aliases
    // are tried after the id itself, in order — a former id *is* a `sourceId`.
    const assignedTo = new Map<string, string>(); // sourceId -> its element's assigned place
    const adoptionOf = (sp: SourcePlace): string | undefined => {
      for (const id of [sp.sourceId, ...(sp.aliasSourceIds ?? [])]) {
        const stored = owners.get(id);
        const local = assignedTo.get(id);
        // An id both stored and introduced by this slice is the per-element query's min-by-source
        // contest, replayed (the local record's source is `source` itself).
        if (stored && (local === undefined || stored.source < source)) return stored.placeUnique;
        if (local !== undefined) return local;
      }
      return undefined;
    };

    interface Assigned extends Prepared {
      placeUnique: string;
      record: PlaceSourceRecord;
    }
    const assigned: Assigned[] = [];
    // Read 3's working set, collected as identities resolve: only a place that pre-exists (via
    // this source's own record, a forced unique landing on another source's place, or an adopted
    // one) can have stored siblings. A fresh ULID can't — and a place minted by this slice has its
    // records in `byPlace` below, not in the store.
    const preExisting = new Set<string>();
    for (const p of prepared) {
      // `forcedUnique` still wins over an adopted one: the GeoJSON import carries the place's own
      // `unique`, which is a statement about identity rather than an inference from a shared id.
      const adopted = p.existing || p.forcedUnique !== undefined ? undefined : adoptionOf(p.sp);
      const placeUnique = p.existing?.placeUnique ?? p.forcedUnique ?? adopted ?? ulid(this.now());
      if (p.existing || p.forcedUnique !== undefined || adopted !== undefined) {
        preExisting.add(placeUnique);
      }
      assignedTo.set(p.sp.sourceId, placeUnique);
      const record: PlaceSourceRecord = {
        source,
        sourceId: p.sp.sourceId,
        placeUnique,
        fields: p.fields,
        ...(p.sp.raw !== undefined ? { raw: p.sp.raw } : {}),
        ...(p.sp.attribution !== undefined ? { attribution: p.sp.attribution } : {}),
        syncedAt: nowIso,
        // goneAt deliberately unset — a re-appearing element comes back to life.
      };
      assigned.push({ ...p, placeUnique, record });
    }

    // Read 3 — the pre-existing places' current siblings (slim: merge and conflicts never read `raw`).
    const storedByPlace = groupBy(
      await this.store.sourcesForPlaces([...preExisting]),
      (s) => s.placeUnique,
    );

    // The approval seam, per element: values colliding with admin-held fields are logged, never
    // applied (the merge keeps the admin value regardless — the conflict row is the review queue).
    // Stored siblings suffice as the reference: an admin record is never part of a snapshot batch.
    const conflictsOf = (a: Assigned): PlaceConflictRecord[] =>
      adminConflicts(a.record, storedByPlace.get(a.placeUnique) ?? []).map((c) => ({
        id: ulid(this.now()),
        placeUnique: a.placeUnique,
        field: c.field,
        currentValue: c.currentValue,
        incomingValue: c.incomingValue,
        source,
        snapshotId,
        createdAt: nowIso,
      }));

    // Merge ONCE per place, over the stored siblings (minus the rows this slice replaces) plus the
    // slice's own records in element order — exactly the inputs the per-element flow's final commit
    // for that place would have merged.
    const byPlace = groupBy(assigned, (a) => a.placeUnique);
    const replaced = new Set(assigned.map((a) => a.sp.sourceId));
    const entries: PlaceCommitEntry[] = [];
    for (const [placeUnique, group] of byPlace) {
      const siblings = (storedByPlace.get(placeUnique) ?? []).filter(
        (s) => !(s.source === source && replaced.has(s.sourceId)),
      );
      const place = canonicalPlace(
        placeUnique,
        mergeFields([...siblings, ...group.map((a) => a.record)]),
        nowIso,
      );
      if (!place) {
        // Nothing servable (connectors guarantee category/point, but stay total). Counted per
        // element, and nothing of the group's is written — conflicts included.
        stats.skipped += group.length;
        continue;
      }
      const conflicts = group.flatMap(conflictsOf);
      stats.conflicts += conflicts.length;
      entries.push({
        place,
        sources: group.map((a) => a.record),
        cells: cellsForPlace(place, this.cfg.cellPrecision),
        conflicts,
      });
      for (const a of group) stats[a.existing ? "updated" : "created"] += 1;
    }
    await this.store.commitPlaces(entries);
  }

  /**
   * Scope-aware retirement (`doc/spec/places.md` §3.3): only this source's live records whose
   * anchor cell was actually queried — and whose category was in the filter — can be marked gone.
   * The store scopes the sweep to the chunk cells, so its cost tracks the snapshot, not the
   * dataset. A place retires only when no live sources remain (an admin record is a live source, so
   * admin-touched places never retire).
   *
   * Three kinds of record are retired: those the run never saw (gone from the version, unless
   * `retireMissing` is off), those `retireFiltered` or `retireUnselectedTypes` released, and, with
   * `retireUnselectedTypes`, those of a category the run left out. All pass the same scope gates; the
   * last two are also held to the exact area.
   */
  private async retireGone(
    source: string,
    params: PlaceSnapshotParams,
    chunks: string[],
    seen: Set<string>,
    stats: PlaceSnapshotStats,
    release?: Release,
  ): Promise<void> {
    const missing = params.options?.retireMissing !== false;
    if (!missing && !release?.ids.size && !release?.unselectedTypes) return;
    // The chunk precision is the chunks' own, by construction — never a config knob. There used to
    // be one, and after the bbox-grid path was deleted it was pure hazard: every production chunk
    // list is a volume's index cells (pinned to one precision by the reader), and a knob set to
    // anything else would make the `encode` below miss every cell and silently disable retirement.
    const precision = chunks[0]?.length;
    if (precision === undefined) return; // no chunks queried ⇒ nothing provably in scope
    const nowIso = this.nowIso();
    const chunkSet = new Set(chunks);
    // The store filter takes a COARSE prefix cover, never the chunk list itself: a large boundary
    // (a p2 cell = 32k p5 chunks) would bind 32k parameters into a pathological OR-chain. Over-selection is harmless — the precise in-scope gate is the
    // `chunkSet` membership check below.
    const prefixes = sweepPrefixCover(boundaryBBox(params.boundary), precision);
    const live = await this.store.liveSourcesBySource(source, prefixes);
    for (const rec of live) {
      const category = rec.fields.category;
      const outsideCategories =
        params.categories !== undefined &&
        params.categories.length > 0 &&
        (!category || !params.categories.includes(category));
      // Why this record would retire: released by a filter the run applied to it, a type left out,
      // or gone from the version. For a record the run read, the version's type decided; for one
      // it did not (a category it never asked for, or a type gone from the version), the stored
      // type does. A record with no category is never provably of a type left out.
      let released = release?.ids.get(rec.sourceId);
      if (
        !released &&
        !seen.has(rec.sourceId) &&
        release?.unselectedTypes &&
        category &&
        (outsideCategories || isSkippedType(rec.fields, params.options?.skipTypes))
      ) {
        released = "type";
      }
      // A category the run never read is reached only by the type clean-up.
      if (outsideCategories && released !== "type") continue;
      if (!released && (seen.has(rec.sourceId) || !missing)) continue;
      const point = rec.fields.point;
      if (!point) continue; // can't prove it was in scope
      if (!chunkSet.has(encode(point, precision))) continue;
      // A released record is held to the exact area by its stored point (for one the run read, the
      // version's point was checked too), so a place that only shares a map cell with the area, or
      // moved into it, is never retired.
      if (released && !inImportArea(point, release!.area)) continue;

      await this.retireSourceRecord(source, rec.sourceId, rec.placeUnique, nowIso, stats);
      if (released === "content") stats.retiredFiltered = (stats.retiredFiltered ?? 0) + 1;
      if (released === "type") stats.retiredUnselected = (stats.retiredUnselected ?? 0) + 1;
    }
  }

  /**
   * The source-retire run ({@link createSourceRetire}): one sweep over the source's live records,
   * each marked gone + its place re-merged or retired — the same per-record tail the scope sweep
   * and replace-the-list use. Cancellable between records; progress rides the same stats throttle
   * as the chunk loop (`retired` is the moving counter, `fetched` the sweep's size).
   */
  private async runRetire(id: string, stats: PlaceSnapshotStats, source: string): Promise<void> {
    const nowIso = this.nowIso();
    // Keys only, deliberately: this is the one sweep pointed at a WHOLE source by design (the `osm`
    // residue is dataset-scale), and the loop reads nothing but the two ids — pulling every record's
    // parsed `fields` would pin tens of MB for the run's whole duration.
    const records = await this.store.liveSourceKeysBySource(source);
    stats.fetched = records.length;
    const flushProgress = this.progressWriter(id);
    for (const rec of records) {
      this.throwIfCancelled(id); // cancellable between records — a whole-source sweep is long
      await this.retireSourceRecord(source, rec.sourceId, rec.placeUnique, nowIso, stats);
      await flushProgress(stats);
    }
    stats.chunksDone = 1;
  }

  /** Mark one source record gone and re-merge/retire its place (shared by sweep + import + retire). */
  private async retireSourceRecord(
    source: string,
    sourceId: string,
    placeUnique: string,
    nowIso: string,
    stats: PlaceSnapshotStats,
  ): Promise<void> {
    await this.store.setSourceGone(source, sourceId, nowIso);
    stats.retired += 1;
    await remergeOrRetire(this.store, placeUnique, nowIso, this.cfg.cellPrecision);
  }

  /** The import run: one pass over the file's entries, then replace-the-list retirement. */
  private async runImport(
    id: string,
    stats: PlaceSnapshotStats,
    source: string,
    entries: ImportedPlace[],
  ): Promise<void> {
    stats.fetched = entries.length;
    const seen = new Set<string>();
    const leftOut = new Set<string>();
    const items: UpsertItem[] = [];
    for (const entry of entries) {
      if (seen.has(entry.unique)) continue; // duplicate feature ids: first wins
      seen.add(entry.unique);

      // Re-host by content-addressed transfer (hash-verified), through the same helper the connector path
      // uses. An imported file addresses its bytes `hash@host`, so it needs no transport override.
      const fields = await this.rehost(entry.fields, stats, leftOut);

      items.push({
        sp: {
          sourceId: entry.unique,
          fields,
          ...(entry.attribution !== undefined ? { attribution: entry.attribution } : {}),
        },
        forcedUnique: entry.unique,
      });
      // Flush at slice granularity, like the chunk path: the file's rehost I/O then overlaps the
      // DB writes, and the queue never holds the whole file's prepared items at once.
      if (items.length >= UPSERT_BATCH) await this.upsertMany(source, items.splice(0), id, stats);
    }
    await this.upsertMany(source, items, id, stats);
    stats.chunksDone = 1;

    // Replace-the-list: the file IS the list — live records absent from it go gone.
    const nowIso = this.nowIso();
    for (const rec of await this.store.liveSourcesBySource(source)) {
      if (!seen.has(rec.sourceId)) {
        await this.retireSourceRecord(source, rec.sourceId, rec.placeUnique, nowIso, stats);
      }
    }
  }

  private nowIso(): string {
    return new Date(this.now()).toISOString();
  }
}

/** The informational bbox stored on an import run's params (naive min/max — audit only). */
function bboxOfPoints(entries: ImportedPlace[]): GeoBBox {
  let minLat = 90;
  let maxLat = -90;
  let minLng = 180;
  let maxLng = -180;
  for (const e of entries) {
    const p = e.fields.point;
    if (p.lat < minLat) minLat = p.lat;
    if (p.lat > maxLat) maxLat = p.lat;
    if (p.lng < minLng) minLng = p.lng;
    if (p.lng > maxLng) maxLng = p.lng;
  }
  return { minLat, minLng, maxLat, maxLng };
}
