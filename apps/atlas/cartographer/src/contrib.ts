/**
 * The contribution source — approved player submissions, exported from a Beacon server and staged
 * here (`apps/atlas/doc/spec/beacon-integration.md` §9, `apps/atlas/doc/spec/place-identity.md`
 * §7).
 *
 * **The first primary source that is not OSM.** Every source added since stage 1 has been *derived*:
 * it took a record staging already held and said more about it. This one brings places of its own —
 * a trailhead nobody mapped, described by somebody who walked to it — which is exactly the gap the
 * whole project exists for. Measured on the published volume: `park` 5.7% described, `nature` 7.1%,
 * `community` 3.4%, and no institutional corpus reaches any of them.
 *
 * **Acquisition is a file, never a fetch.** Cartographer does not call Beacon servers, and should
 * not: the whole architecture points the other way, and a builder that dialled game servers would
 * invert it. An operator exports and hands the file over, recorded through stage 0's `--input` so
 * the manifest names the exact bytes that were ingested.
 *
 * ## Identity, which is the whole difficulty
 *
 * A contribution arrives in one of two shapes, and they must not be treated alike:
 *
 * - An **improvement** names the place it improves, through the source keys the exporting server
 *   holds it under. It joins that place's entity by **derivation** — naming a record, asserting no
 *   ids. That is not a technicality: `apps/atlas/doc/spec/place-identity.md` §7 requires that a
 *   builder be able to tell "an independent source agrees with this" from "this is the assertion I
 *   published last month", and a record that restated the parent's identifiers would be counted as
 *   the second. It would also add an asserter to the distance gate's span measurement, which is how
 *   the *same* mistake was caught and corrected once already (422 shared identifiers → 1,029, on a
 *   pass that staged 348 records).
 * - A **new place** joins nothing. It asserts `contrib:<host>/<unique>` and becomes its own
 *   single-record entity, which is correct — nothing here knows about it yet.
 *
 * Either way the contribution id is asserted and kept forever, because it is also what lets the
 * originating server recognise its own contribution coming home instead of duplicating it.
 *
 * ## What is trusted, and what is checked again
 *
 * The file is an operator's own export, but it is still an input. A photo with no stated licence is
 * refused here as well as at the exporting end — a volume that carried a field it could not state
 * terms for is the one publishing mistake that cannot be undone, so it is worth two gates. And
 * nothing is published on faith: contributed places and photos land in the review console like any
 * other imagery, where a reviewer can reject a photo, unlink it, or remove the place.
 */
import { placeExportSchema, type PlaceFeature } from "@beaconsgg/protocol-types";
import { readFile } from "node:fs/promises";
import {
  collapseWhitespace,
  CONTRIB_SOURCE,
  findContribParents,
  writeContribMedia,
  writeStaged,
  type ContribImageMeta,
  type MediaRef,
  type Querier,
  type RecordRef,
  type StagedRow,
} from "./store";
import { upstreamId } from "./upstream";

export interface ContribReport {
  /** Features the file carried. */
  features: number;
  /** Records that joined an existing place by naming a record of it. */
  improvements: number;
  /** Records that became a place of their own. */
  newPlaces: number;
  /**
   * Features naming a place this build does not hold, staged as new places rather than dropped.
   *
   * Reported because it is the number that says whether the *export* and the *extract* describe the
   * same region: a handful is a server whose coverage runs past ours, and a wall of them means the
   * two were built from different places and the join is silently doing nothing.
   */
  unresolvedParent: number;
  /** Photo references carried through to the media crawl. */
  photos: number;
  /** Photos dropped for stating no licence — a grant is what makes a photo publishable at all. */
  unlicensedPhotos: number;
  /** Features refused: no contribution block, or a malformed contribution id. */
  skipped: number;
  dryRun: boolean;
}

export interface ContribOptions {
  /** The `beacon-contrib/1` file, as `--input contrib=<path>` recorded it. */
  file: string;
  dryRun: boolean;
  now: () => string;
  log: (message: string) => void;
}

/**
 * Read one contribution export and stage what it carries.
 *
 * Not paged: a contribution file is an operator's own export of what their players submitted, which
 * is thousands of records at the very most — the paging every other stage does exists for 862,992
 * OSM rows and 27,689 photos, and imposing it here would be machinery with nothing to carry.
 */
export async function stageContrib(db: Querier, opts: ContribOptions): Promise<ContribReport> {
  const report: ContribReport = {
    features: 0,
    improvements: 0,
    newPlaces: 0,
    unresolvedParent: 0,
    photos: 0,
    unlicensedPhotos: 0,
    skipped: 0,
    dryRun: opts.dryRun,
  };

  const parsed = placeExportSchema.parse(JSON.parse(await readFile(opts.file, "utf8")));
  if (parsed.beacon.profile !== "beacon-contrib/1") {
    throw new Error(
      `${opts.file} is a ${parsed.beacon.profile} file — ` +
        "`contrib` stages a contribution export (places.contrib.export), not a place list",
    );
  }
  report.features = parsed.features.length;

  // Every parent key in one read, before the loop: the alternative is a round trip per feature, and
  // the join population is the whole file.
  const parents = await findContribParents(
    db,
    parsed.features.flatMap((f) => f.properties.contrib?.upstream ?? []),
  );

  const rows: StagedRow[] = [];
  const grants: (ContribImageMeta & { url: string })[] = [];
  for (const feature of parsed.features) {
    const contrib = feature.properties.contrib;
    // A feature with no contribution block is a plain place record that landed in the wrong file;
    // staging it would credit a player with whatever produced it. The id is kept rather than
    // recomputed downstream — validating a value and then re-deriving it is two chances to disagree.
    const upstream = contrib ? upstreamId("contrib", contrib.id) : undefined;
    if (!contrib || !upstream) {
      report.skipped++;
      continue;
    }
    const parent = (contrib.upstream ?? []).map((key) => parents.get(key)).find(Boolean);
    if (contrib.upstream?.length && !parent) report.unresolvedParent++;

    const { mediaRefs, grants: photoGrants, dropped } = photoRefs(feature);
    report.photos += mediaRefs.length;
    report.unlicensedPhotos += dropped;
    grants.push(...photoGrants);

    rows.push(stagedRow(feature, contrib, upstream, parent, mediaRefs));
    if (parent) report.improvements++;
    else report.newPlaces++;
  }

  opts.log(
    `${parsed.features.length} feature(s): ${report.improvements} improvement(s), ` +
      `${report.newPlaces} new place(s)`,
  );
  if (!opts.dryRun) {
    // Grants first: a staged reference whose grant had not landed yet would be crawled, find no
    // metadata, and be refused `missing` — over a photo whose terms are sitting in the same file.
    await writeContribMedia(db, grants, opts.now());
    await writeStaged(db, rows, opts.now());
  }
  return report;
}

/**
 * One feature as a staged record.
 *
 * `category` and `point` are copied from the feature **verbatim**, and for an improvement the
 * exporting server took them from the place rather than from the contribution — they are positional
 * context, not a claim. Copying rather than deriving is the rule a derived source already follows
 * for a reason: a parent and child whose points differ inflate the span of every id they share, and
 * a gated id is carried rather than established, which re-mints the place. Verbatim makes it 0 m.
 */
function stagedRow(
  feature: PlaceFeature,
  contrib: NonNullable<PlaceFeature["properties"]["contrib"]>,
  upstream: string,
  parent: RecordRef | undefined,
  mediaRefs: readonly MediaRef[],
): StagedRow {
  const props = feature.properties;
  return {
    source: CONTRIB_SOURCE,
    sourceId: contrib.id,
    ...(props.name !== undefined ? { name: props.name } : {}),
    // The staging convention every stager applies: a player's multi-line submission would otherwise
    // publish with paragraph breaks where every other source is one line.
    ...(props.description !== undefined
      ? { description: collapseWhitespace(props.description) }
      : {}),
    ...(props.descriptionCredit !== undefined
      ? { descriptionCredit: props.descriptionCredit }
      : {}),
    ...(props.website !== undefined ? { website: props.website } : {}),
    ...(props.altNames !== undefined ? { altNames: props.altNames } : {}),
    category: props.category,
    ...(props.subcategory !== undefined ? { subcategory: props.subcategory } : {}),
    point: JSON.stringify({ type: "Point", coordinates: [props.point.lng, props.point.lat] }),
    ...(feature.geometry.type !== "Point" ? { geometry: JSON.stringify(feature.geometry) } : {}),
    mediaRefs: [...mediaRefs],
    // **An improvement asserts nothing.** Its identity is the derivation below; restating the
    // parent's ids would make it a second record agreeing with itself. A new place asserts its own
    // contribution id and only that.
    upstreamIds: parent ? [] : [upstream],
    ...(parent ? { derivedFrom: parent } : {}),
    // Build-side provenance: which submission this was, and under what grant. Nothing selects `raw`
    // downstream and a volume never carries it.
    raw: { contribId: contrib.id, license: contrib.license },
  };
}

/**
 * The photo references a contributed feature carries, and how many it refused.
 *
 * A contributed photo is addressed by the **`uris[0]` the exporting server rewrote it to** — that
 * pointer is the server's own copy, which is the whole reason it rewrites it: the bytes a reviewer
 * judged and the bytes a builder fetches have to be the same ones, and a client-supplied host could
 * swap them afterwards.
 *
 * A photo with no credit states no licence, and one with no licence is not publishable. Dropped and
 * counted, never staged and sorted out later — a reference that reached the crawl would spend a
 * fetch to arrive at the same answer.
 */
function photoRefs(feature: PlaceFeature): {
  mediaRefs: MediaRef[];
  grants: (ContribImageMeta & { url: string })[];
  dropped: number;
} {
  const mediaRefs: MediaRef[] = [];
  const grants: (ContribImageMeta & { url: string })[] = [];
  let dropped = 0;
  for (const entry of feature.properties.media ?? []) {
    // `thumb`s are the exporting server's own re-encode of the same photo; the crawl re-encodes from
    // the largest it can get, so taking both would fetch one picture twice and publish the worse one.
    if (entry.role === "thumb") continue;
    if (!entry.credit?.license) {
      dropped++;
      continue;
    }
    // `mediaSchema` requires at least one uri, so this only narrows the index type — counting it
    // as `dropped` would report "no licence stated" about a photo whose licence was fine.
    const uri = entry.uris[0];
    if (!uri) continue;
    mediaRefs.push({ kind: "url", value: uri, claimedBy: CONTRIB_SOURCE });
    grants.push({
      url: uri,
      license: entry.credit.license,
      ...(entry.credit.licenseUrl ? { licenseUrl: entry.credit.licenseUrl } : {}),
      ...(entry.credit.author ? { author: entry.credit.author } : {}),
    });
  }
  return { mediaRefs, grants, dropped };
}
