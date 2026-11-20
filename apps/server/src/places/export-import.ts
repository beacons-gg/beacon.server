import { bboxContainsPoint, containsPoint, geometryBBox, type BBox } from "@beaconsgg/geo";
import type {
  ContribLicense,
  GeoBBox,
  LatLng,
  PlaceExport,
  PlaceFeature,
  PlaceGeometry,
} from "@beaconsgg/protocol-types";
import type { PlaceRecord } from "../stores/place-store";
import type { SourcePlace } from "./connectors/connector";

/**
 * The export/import interchange helpers (`doc/spec/places.md` §7): pure Feature builders/parsers. A
 * GeoJSON FeatureCollection is the file format — the import lands as a `list:<name>` source through
 * the exact upsert/merge pipeline every connector uses, and `unique` survives the move so
 * re-imports update rather than duplicate. (Cross-server media re-hosting is the generic
 * `media/media-transfer.ts`.)
 */

/** A boundary for export/snapshot scoping: a bbox or a polygon. */
export type ExportBoundary = GeoBBox | PlaceGeometry;

/** The per-feature provenance summary — the wire's `sources` element, not a second shape. */
export type FeatureProvenance = NonNullable<PlaceFeature["properties"]["sources"]>[number];

/** The place fields a Feature carries (a full record satisfies this; so does summary+geometry). */
export type ExportablePlace = Pick<
  PlaceRecord,
  | "unique"
  | "category"
  | "subcategory"
  | "name"
  | "description"
  | "descriptionCredit"
  | "website"
  | "wikipedia"
  | "altNames"
  | "point"
  | "geometry"
  | "media"
  | "updatedAt"
>;

/** Build one Feature from a place + its live-source provenance summary. */
export function toFeature(place: ExportablePlace, sources: FeatureProvenance[]): PlaceFeature {
  return {
    type: "Feature",
    geometry: place.geometry ?? {
      type: "Point",
      coordinates: [place.point.lng, place.point.lat],
    },
    properties: {
      unique: place.unique,
      category: place.category,
      ...(place.subcategory !== undefined ? { subcategory: place.subcategory } : {}),
      ...(place.name !== undefined ? { name: place.name } : {}),
      ...(place.description !== undefined ? { description: place.description } : {}),
      ...(place.descriptionCredit !== undefined
        ? { descriptionCredit: place.descriptionCredit }
        : {}),
      ...(place.website !== undefined ? { website: place.website } : {}),
      ...(place.wikipedia !== undefined ? { wikipedia: place.wikipedia } : {}),
      ...(place.altNames !== undefined ? { altNames: place.altNames } : {}),
      point: place.point,
      ...(place.media !== undefined ? { media: place.media } : {}),
      ...(sources.length > 0 ? { sources } : {}),
      updatedAt: place.updatedAt,
    },
  };
}

/** Assemble the interchange file (dataset attribution travels with it — ODbL discipline). */
export function toFeatureCollection(
  features: PlaceFeature[],
  meta: {
    host: string;
    exportedAt: string;
    attribution: string[];
    truncated: boolean;
    profile?: PlaceExport["beacon"]["profile"];
  },
): PlaceExport {
  return {
    type: "FeatureCollection",
    beacon: {
      profile: meta.profile ?? "beacon-places/1",
      host: meta.host,
      exportedAt: meta.exportedAt,
      ...(meta.attribution.length > 0 ? { attribution: meta.attribution } : {}),
      ...(meta.truncated ? { truncated: true } : {}),
    },
    features,
  };
}

/**
 * The redistribution envelope for a set of contributions: **CC BY if any of them is**.
 *
 * A feature's fields come from several submissions, and the ones with a credit slot state their own
 * exact terms. This covers the ones that do not (`name`, `website`), and it has to be the strictest
 * of the contributing grants — a consumer reading one licence for the feature must not be told CC0
 * about a field somebody granted only under attribution.
 *
 * Only credited contributions can be anything but CC0 (the wire refuses otherwise), which is why
 * the credited rows alone determine the answer.
 */
export function licenseEnvelope(
  contributions: readonly { license?: ContribLicense }[],
): ContribLicense {
  return contributions.some((c) => c.license === "CC-BY-4.0") ? "CC-BY-4.0" : "CC0-1.0";
}

/**
 * One contribution Feature — the `contrib` source record's **own** fields, plus what an ingesting
 * dataset needs to place them (`apps/atlas/doc/spec/beacon-integration.md` §9).
 *
 * Built by {@link toFeature} with a `contrib` block grafted on, rather than by a second property
 * builder: the two files differ in exactly one property, and two builders that look alike are two
 * places to remember when the wire gains a field.
 *
 * What is absent matters as much as what is here. There is no merged place: exporting the merged
 * record would ship OSM's description as though a player wrote it. There is no reviewer `note`: it
 * was written to an operator, not to the world. And there is no DID except the ones whose authors
 * asked to be named — an uncredited contribution travels as content and nothing else.
 */
export function toContribFeature(input: {
  unique: string;
  /**
   * The `contrib` record's own fields — descriptor values only.
   *
   * Typed as {@link ExportablePlace} minus the four the caller supplies, so "a contribution
   * contributes descriptors" is stated by the type rather than by a comment: `point` and `category`
   * are context it does not own, and `unique`/`updatedAt` belong to the place.
   */
  fields: Partial<Omit<ExportablePlace, "unique" | "updatedAt" | "point" | "category">>;
  /**
   * Where the place is and what kind it is — **positional context, not a contributed claim.**
   *
   * Passed apart from `fields` because an improvement contributes neither (moving or
   * recategorizing someone else's place is operator-only), so they come from the place itself. A
   * Feature cannot exist without them, which is why they are required here rather than optional.
   */
  point: LatLng;
  category: PlaceFeature["properties"]["category"];
  /** `<host>/<unique>` — the id this contribution keeps forever. */
  contribId: string;
  /** The place's other live source keys, so an improvement joins rather than duplicates. */
  upstream: readonly string[];
  license: ContribLicense;
  /** DIDs of contributors who asked to be named; deduped and sorted by the caller. */
  contributors: readonly string[];
  updatedAt: string;
}): PlaceFeature {
  const { fields } = input;
  // `sources: []` because a contribution file states its terms per field and per photo — a
  // source-name summary here would be a second, weaker claim about the same thing.
  const feature = toFeature(
    {
      ...fields,
      unique: input.unique,
      category: input.category,
      point: input.point,
      updatedAt: input.updatedAt,
    },
    [],
  );
  return {
    ...feature,
    properties: {
      ...feature.properties,
      contrib: {
        id: input.contribId,
        ...(input.upstream.length > 0 ? { upstream: [...input.upstream] } : {}),
        license: input.license,
        ...(input.contributors.length > 0 ? { contributors: [...input.contributors] } : {}),
      },
    },
  };
}

/** What an imported feature contributes: the canonical `unique` + the list record's inputs. */
export interface ImportedPlace {
  unique: string;
  fields: SourcePlace["fields"];
  /** The upstream credit lines this feature carried (preserved on the `list:` source record). */
  attribution?: string;
}

/**
 * Parse one Feature into its import contribution. The area polygon comes from `geometry` when the
 * feature has one (a `Point` geometry contributes no area); the representative point is always
 * `properties.point`. Upstream attribution lines are folded onto the list record so credit
 * survives the hop.
 */
export function fromFeature(feature: PlaceFeature): ImportedPlace {
  const props = feature.properties;
  const geometry = feature.geometry.type === "Point" ? undefined : feature.geometry;
  const attributions = [
    ...new Set((props.sources ?? []).map((s) => s.attribution).filter((a): a is string => !!a)),
  ];
  return {
    unique: props.unique,
    fields: {
      category: props.category,
      ...(props.subcategory !== undefined ? { subcategory: props.subcategory } : {}),
      ...(props.name !== undefined ? { name: props.name } : {}),
      ...(props.description !== undefined ? { description: props.description } : {}),
      ...(props.descriptionCredit !== undefined
        ? { descriptionCredit: props.descriptionCredit }
        : {}),
      ...(props.website !== undefined ? { website: props.website } : {}),
      ...(props.wikipedia !== undefined ? { wikipedia: props.wikipedia } : {}),
      ...(props.altNames !== undefined ? { altNames: props.altNames } : {}),
      point: props.point,
      ...(geometry ? { geometry } : {}),
      ...(props.media !== undefined ? { media: props.media } : {}),
    },
    ...(attributions.length > 0 ? { attribution: attributions.join(" · ") } : {}),
  };
}

/** The bbox of a boundary — one shared dispatch (snapshots and export both scope with it). */
export function boundaryBBox(boundary: ExportBoundary): BBox {
  return "type" in boundary ? geometryBBox(boundary) : boundary;
}

/** Whether a point falls inside a boundary (polygon containment, or the geo bbox predicate). */
export function pointInBoundary(point: LatLng, boundary: ExportBoundary): boolean {
  return "type" in boundary ? containsPoint(point, boundary) : bboxContainsPoint(point, boundary);
}
