/**
 * Stage 3 — merge each entity's records into the fields a volume publishes, in the database.
 *
 * The thin half: every rule lives in `fields.ts`, which is pure. This pages over entities, assigns each
 * place its tile cell, and writes the result.
 *
 * **Unlike stage 2, this is safely bounded.** Merging one entity needs only that entity's records, so a
 * `--limit` produces *fewer* places rather than wrong ones — the opposite of identity, where a partial
 * pass mints ids for components it cannot see all of. What a partial run is not is publishable, and
 * `publish` refuses it rather than emitting a volume with places missing.
 */
import { encode } from "@beaconsgg/geo";
import { mergePlace } from "./fields";
import type { Querier } from "./store";
import { fetchEntityRecords, writeMergedPlaces, type MergedPlaceRow } from "./store";
import { CELL_PRECISION } from "@beaconsgg/atlas-volume";
import { parsePoint } from "./volume";

/** Entities per page. The join fans out to their records, so this is thousands of rows, not one. */
const PAGE = 1_000;

export interface MergeReport {
  /** Entities considered. */
  entities: number;
  /** Places written. */
  merged: number;
  /** Entities that produced no servable place — no category or no point. */
  unmergeable: number;
  /** Places whose fields came from more than one source. */
  multiSource: number;
  /** Places that carry a `descriptionCredit`. */
  credited: number;
}

export async function merge(
  db: Querier,
  opts: {
    limit: number;
    dryRun: boolean;
    now: () => string;
    log: (message: string) => void;
  },
): Promise<MergeReport> {
  const report: MergeReport = {
    entities: 0,
    merged: 0,
    unmergeable: 0,
    multiSource: 0,
    credited: 0,
  };
  const now = opts.now();
  let after: string | undefined;

  while (report.entities < opts.limit) {
    const budget = Math.min(PAGE, opts.limit - report.entities);
    const page = await fetchEntityRecords(db, { limit: budget, ...(after ? { after } : {}) });
    if (page.length === 0) break;

    const writes: MergedPlaceRow[] = [];
    for (const entity of page) {
      report.entities += 1;
      const place = mergePlace(entity.records);
      if (!place) {
        report.unmergeable += 1;
        continue;
      }
      report.merged += 1;
      if (place.sources.length > 1) report.multiSource += 1;
      if (place.descriptionCredit) report.credited += 1;

      const { sources, geometry, point, ...fields } = place;
      writes.push({
        entityId: entity.entityId,
        // The tile a consumer will find this place in, decided here so `index.json` is a GROUP BY rather
        // than a second pass over 225k points. `encode` is `@beaconsgg/geo`'s — the same implementation the
        // server indexes with, so a place cannot be filed under a cell the server would compute
        // differently.
        //
        // **Encoded from the ROUNDED point, which is the one that gets published.** Measured: 31 of
        // 225,084 places sit close enough to a cell edge that rounding to 5 decimals moves them across
        // it, so a cell derived from full precision names a tile the published coordinate is not inside.
        // A consumer filtering imported places by cell would drop exactly those, and the whole
        // partial-import model rests on point-in-cell holding — see `verify`'s `cell` assertion, which is
        // what found this.
        cell: encode(publishedPoint(point), CELL_PRECISION),
        fields,
        sources,
        point,
        ...(geometry ? { geometry } : {}),
      });
    }

    if (!opts.dryRun) await writeMergedPlaces(db, writes, now);
    // Non-empty by the check above, so this cannot be undefined.
    const last = page[page.length - 1]!;
    after = last.entityId;
    opts.log(`merged ${report.merged} places from ${report.entities} entities`);
    if (page.length < budget) break;
  }

  return report;
}

/**
 * GeoJSON `Point` text → the `{lat, lng}` `@beaconsgg/geo` takes, **at the precision the volume publishes**.
 *
 * `volume.ts`'s own `parsePoint`, flipped into the wire's coordinate order — not a second parser. The
 * rounding is the load-bearing part: anything deciding *where a place lives* has to agree with what gets
 * published, or a tile names a cell its own contents fall outside.
 */
function publishedPoint(geojson: string): { lat: number; lng: number } {
  const [lng, lat] = parsePoint(geojson);
  return { lat, lng };
}
