/**
 * The Atlas connector — imports places from a published, signed volume
 * (`apps/atlas/doc/spec/beacon-integration.md` §1).
 *
 * A volume is **static files**: a signed manifest, a cell index, an interning dictionary, one tile per
 * geohash cell. So this connector fetches paths and verifies hashes; there is no query API to be fair to
 * and no third party to be throttled by at snapshot time, which is the entire point of Atlas existing.
 *
 * Three properties it must not break, each of which has a comment where it is enforced:
 *
 * - **A volume from an unconfigured publisher is not read at all.** No unsigned mode, no
 *   "unverifiable but convenient" fallback (the integration spec, §2).
 * - **A tile it cannot read is a thrown error, never an empty result.** The runner has no per-chunk catch
 *   and its retirement pass sits outside the try, so a swallowed fetch failure would mark the chunk done
 *   and then retire every place in it.
 * - **It supplies the volume's photos but no image tags.** Never `media: []` — see {@link toSourcePlace}.
 */
import {
  CELL_PRECISION,
  candidateSourceIds,
  fetchHashed,
  mediaBareHash,
  mediaPath,
  withAlgorithm,
  tilePath,
  type CellTile,
  type Dictionary,
  type TileRecord,
  type VolumeReader,
  type VolumeRoot,
} from "@beaconsgg/atlas-volume";
import { encode, type BBox } from "@beaconsgg/geo";
import {
  geoPositionSchema,
  placeCategorySchema,
  placeSubcategorySchema,
  PLACE_MEDIA_TYPE,
  type Media,
  type MediaCredit,
  type PlaceCategory,
} from "@beaconsgg/protocol-types";
import { OutboundHttp, OutboundLimiter, type OutboundClient } from "../../common/outbound-http";
import type { MediaTransport, PlaceConnector, SourcePlace } from "./connector";

/**
 * What one chunk's re-validation refused (the integration spec, §7).
 *
 * Counted per chunk and **reported**, not accumulated on the connector. Held as a field it was
 * per-process state nothing read — so the numbers would have kept climbing across every run for the
 * life of the server and meant nothing to anyone. And the information matters: a volume built against a
 * newer taxonomy quietly importing fewer places is the same failure class as a throttled fetch recorded
 * as "this place has no photo".
 */
interface DropCounts {
  /** Places whose category the server's own enum cannot parse — a taxonomy the volume is newer than. */
  category: number;
  /** Places whose subcategory is not a valid slug. The place still imports, without one. */
  subcategory: number;
  /** Places with an out-of-range point. */
  point: number;
}

export class AtlasConnector implements PlaceConnector {
  readonly id: string;

  /**
   * Where the runner gets this volume's photos, and what to call the bytes.
   *
   * **Derived from the hash the manifest chain verified, never read back from a `uris` entry** — that
   * makes "under this volume" true by construction. A hosted volume yields URLs for the runner to fetch;
   * a staged archive yields the bytes themselves (`load`), and the transfer's verification chain is
   * identical either way.
   */
  readonly mediaTransport: MediaTransport;

  /**
   * Takes an already-**verified** root, and that is the design rather than a convenience:
   * `openVolume` (the signature + hash-chain check) runs in the service before any run is enqueued,
   * because the service is where the operator's pinned publisher lives — a connector is a pure
   * mapper with no store access, so it cannot be the thing that decides trust.
   */
  constructor(
    private readonly reader: VolumeReader,
    private readonly root: VolumeRoot,
    outbound: OutboundClient,
    /** Named for provenance — `atlas:us-west` reads correctly in the console and in `place_sources`. */
    name: string,
    /**
     * This server's own host, so a place that originated here as a player contribution is
     * **recognised coming home** instead of duplicated (`apps/atlas/doc/spec/place-identity.md`
     * §7).
     *
     * A volume republishes a contribution carrying `contrib:<host>/<unique>`. Without knowing its
     * own host a server cannot tell that id from any other volume's, falls back to the Atlas id,
     * finds no local record under it, and creates a second copy of a place it already has —
     * alongside the operator edits and player contributions keyed to the original.
     *
     * Required, not optional: `ServerConfig.host` is validated at boot, so no caller legitimately
     * lacks one — and a default here would make forgetting it silent, which is the whole failure.
     */
    private readonly selfHost: string,
  ) {
    this.id = `atlas:${name}`;
    const base = root.manifest.media.base;
    this.mediaTransport = {
      origin: (entry: Media): string | undefined =>
        this.reader.mediaUrl?.(base, withAlgorithm(entry.hash)),
      type: PLACE_MEDIA_TYPE,
      // This connector's own client — unpaced, because a volume is static files that owe nobody fairness.
      outbound,
      ...(reader.mediaLoad
        ? { load: (entry: Media) => reader.mediaLoad!(base, withAlgorithm(entry.hash)) }
        : {}),
    };
  }

  /**
   * One chunk — which, because the volume and the server share `CELL_PRECISION`, is exactly one tile.
   *
   * The chunk's cell comes from the centre of the bbox the runner derived from it. Round-tripping
   * through the shared `encode` rather than carrying the cell name means the runner's grid and the
   * volume's index cannot disagree about which cell this is.
   */
  async fetchChunk(
    bbox: BBox,
    categories: readonly PlaceCategory[] | undefined,
  ): Promise<SourcePlace[]> {
    const cell = encode(
      { lat: (bbox.minLat + bbox.maxLat) / 2, lng: (bbox.minLng + bbox.maxLng) / 2 },
      CELL_PRECISION,
    );
    return this.fetchCell(cell, categories);
  }

  /**
   * One tile, by cell name.
   *
   * **A cell the volume does not hold returns `[]`, and that is not the same as a failure**: it is the
   * honest answer for a region the publisher has no data in, and the runner's retirement is scoped to the
   * chunks it asked for, so an empty answer for an empty cell retires nothing that was not already absent.
   * A cell the volume *does* hold but which cannot be read throws, via `fetchHashed`.
   */
  private async fetchCell(
    cell: string,
    categories: readonly PlaceCategory[] | undefined,
  ): Promise<SourcePlace[]> {
    const root = this.root;
    const summary = root.index.get(cell);
    if (!summary) return [];

    const tile = await fetchHashed<CellTile>(this.reader, tilePath(cell), summary.hash, this.id);
    const wanted = categories && categories.length > 0 ? new Set(categories) : undefined;
    const drops: DropCounts = { category: 0, subcategory: 0, point: 0 };

    const out: SourcePlace[] = [];
    for (const record of tile.places) {
      const place = this.toSourcePlace(record, root, drops);
      if (!place) continue;
      if (wanted && !wanted.has(place.fields.category)) continue;
      out.push(place);
    }

    // Said out loud, because the alternative is a volume that imports fewer places than it holds with
    // nothing anywhere recording that it did.
    const refused = Object.entries(drops).filter(([, n]) => n > 0);
    if (refused.length > 0) {
      console.warn(
        `${this.id}: cell ${cell} — refused ${refused.map(([k, n]) => `${n} on ${k}`).join(", ")}; ` +
          "a published field the server cannot re-validate is dropped, never coerced",
      );
    }
    return out;
  }

  /**
   * One tile record as the server's own shape, **re-validated** — or nothing.
   *
   * The integration spec, §7: a signature proves a volume came from a configured publisher intact;
   * it does not prove the publisher is right. So everything that *can* be re-derived is: the
   * category against the server's own enum, the subcategory against the slug pattern, the geometry
   * against the wire caps, the point in range. Anything failing is **dropped and counted, never
   * coerced** — a coerced category is a place filed under the wrong thing, which is worse than a
   * missing one.
   */
  private toSourcePlace(
    record: TileRecord,
    root: VolumeRoot,
    drops: DropCounts,
  ): SourcePlace | undefined {
    const dict = root.dict;
    const category = placeCategorySchema.safeParse(dict.categories[record.category]);
    if (!category.success) {
      drops.category += 1;
      return undefined;
    }
    const point = geoPositionSchema.safeParse(record.point);
    if (!point.success) {
      drops.point += 1;
      return undefined;
    }
    const [lng, lat] = point.data;

    const fields: SourcePlace["fields"] = { category: category.data, point: { lat, lng } };

    if (record.subcategory !== undefined) {
      const slug = placeSubcategorySchema.safeParse(dict.subcategories[record.subcategory]);
      if (slug.success) fields.subcategory = slug.data;
      else drops.subcategory += 1;
    }
    if (record.name) fields.name = record.name;
    if (record.altNames?.length) fields.altNames = [...record.altNames];
    if (record.description) {
      fields.description = record.description;
      // The credit travels with the text or not at all — `merge.ts`'s `OWNED_BY`. Splitting them here
      // would relabel one source's words with another's licence.
      const credit = this.credit(record.descriptionCredit, dict);
      if (credit) fields.descriptionCredit = credit;
    }
    if (record.website) fields.website = record.website;
    if (record.wikipedia) fields.wikipedia = record.wikipedia;

    // **No geometry.** A volume keeps polygons in a per-cell `.geom.json` sibling so a consumer
    // wanting map pins need not pay for boundaries (`apps/atlas/doc/spec/volume-format.md` §5), and
    // fetching it is a second request per cell that only pays off once a game asks for outlines.
    // Left out rather than stubbed: `GeometryTile`, `geomTilePath` and `summary.geomHash` are all
    // in the format package, so adding it is a short method — whereas a stub with no caller reads
    // as a shipped capability that nothing exercises.

    // The volume's photos, when it has any for this place.
    //
    // **Absent, never `[]`** — the runner's media policy tests `fields.media !== undefined`, so an empty
    // array would count as "this source supplies media", blank the place's photos and block the fallback,
    // while an absent key lets per-field merge keep whatever another source already ingested.
    //
    // Still **no `imageTags`**: the server resolves nothing from a third party, which is what Atlas exists
    // to stop. These entries name bytes the *publisher* already fetched, licence-checked and re-encoded.
    const media = this.media(record, dict, root.manifest.media.base);
    if (media.length > 0) fields.media = media;

    // `apps/atlas/doc/spec/place-identity.md` §6 step 1 and step 2 in one derivation: the key
    // first, then the place's former ids for the runner to follow when the key itself is new.
    // Computed once — the two used to be separate helpers that each rebuilt the whole list, per
    // place.
    const [sourceId, ...aliasSourceIds] = candidateSourceIds(
      record.upstream,
      record.id,
      record.aliases ?? [],
      this.selfHost,
    ) as [string, ...string[]];

    return {
      sourceId,
      fields,
      // No `raw`. The tile record would be the obvious payload, but its dictionary indices are
      // per-version (`apps/atlas/doc/spec/volume-format.md` §10), so a republish that merely
      // re-interned would change `raw` for every place — and `raw` participates in the runner's
      // byte-identity `unchanged` short-circuit, so every place in the volume would count as
      // updated and **re-log the whole admin-conflict set**. The fields are the re-mappable
      // content; the ids below are the provenance.
      attribution: this.attribution(record, dict),
      ...(aliasSourceIds.length > 0 ? { aliasSourceIds } : {}),
    };
  }

  /**
   * A tile's photos as `Media` entries, addressed at the volume so the runner can fetch and re-host them.
   *
   * Three translations happen here and each one is a trap on its own:
   *
   * - **The hash loses its prefix.** A volume writes `sha256:…`; `Media.hash` is bare base64url and
   *   `ingestTrusted` re-hashes the bytes and compares against exactly that. `mediaBareHash` is the single
   *   conversion, shared with the publisher.
   * - **`type` is synthesized as the media *kind*, not the MIME type.** `mediaSchema.type` is
   *   `"image" | "sound" | …` and three consumers filter on it — `pickMedia`, `mediaPairs` (both in
   *   `@beaconsgg/protocol-types`), the game's `markerThumb` — so `"image/webp"` here would have stored every photo
   *   correctly and made all of them invisible everywhere. The MIME type belongs on the *transport*
   *   ({@link mediaTransport}), which is the only place it is a content type.
   * - **`uris` holds the volume's own URL**, resolved through `mediaUrl` so `media.base`'s `../` lands right
   *   whether or not the configured version URL ends in a slash. This pointer is a *fetch instruction for
   *   the runner*, not something to serve: `MediaTransfer` rewrites it to this server's own address before
   *   anything is stored, which is what keeps the platform's no-hot-linking rule intact.
   */
  private media(record: TileRecord, dict: Dictionary, base: string): Media[] {
    const out: Media[] = [];
    for (const entry of record.media ?? []) {
      const credit = this.credit(entry.credit, dict);
      // `author` and `sourceUrl` are per file and sit outside the interned licence pair
      // (`apps/atlas/doc/spec/volume-format.md` §7), so the credit a consumer sees is the two
      // reassembled.
      const merged: MediaCredit | undefined =
        credit || entry.author || entry.sourceUrl
          ? {
              ...credit,
              ...(entry.author ? { author: entry.author } : {}),
              ...(entry.sourceUrl ? { sourceUrl: entry.sourceUrl } : {}),
            }
          : undefined;
      out.push({
        type: "image",
        role: entry.role,
        hash: mediaBareHash(entry.hash),
        // A fetch instruction for the runner, rewritten to this server's own address before anything is
        // stored (the no-hot-linking rule). A staged archive has no URL, so its interim address is the
        // volume-relative path — descriptive only, since the transport's `load` supplies the bytes.
        uris: [this.reader.mediaUrl?.(base, entry.hash) ?? base + mediaPath(entry.hash)],
        ...(merged ? { credit: merged } : {}),
      });
    }
    return out;
  }

  /** A credit is an index into the dictionary or an inline object — the one-off escape hatch (`apps/atlas/doc/spec/volume-format.md` §4). */
  private credit(
    credit: number | MediaCredit | undefined,
    dict: Dictionary,
  ): MediaCredit | undefined {
    if (credit === undefined) return undefined;
    return typeof credit === "number" ? dict.credits[credit] : credit;
  }

  /**
   * The attribution line this record carries — every contributing source's, joined.
   *
   * Derived from `dict.sources` rather than invented, because this is what makes the volume
   * lawfully redistributable (`apps/atlas/doc/spec/volume-format.md` §7) and it must survive a
   * merge: `attribution` is per-record, so a place whose description came from Wikipedia keeps that
   * credit even when OSM wins its name.
   */
  private attribution(record: TileRecord, dict: Dictionary): string {
    const lines = record.sources
      .map((at) => dict.sources[at]?.attribution)
      .filter((line): line is string => Boolean(line));
    return [...new Set(lines)].join(" · ");
  }
}

/**
 * The outbound client an Atlas run uses for tiles and media alike — **its own**, not the image
 * budget's: a volume is static files on object storage with nothing to be fair to, and sharing a
 * limiter would make every tile read queue behind photo fetches. Interval zero for the same reason —
 * unlike Overpass or Wikimedia, there is no upstream budget to pace against.
 */
/** The DI token the admin controller receives {@link atlasOutbound} under. */
export const ATLAS_OUTBOUND = "ATLAS_OUTBOUND";

/**
 * The DI token for `config.atlasVolumesDir` — the host-mounted volume-tree root that enables
 * `path` imports, or `undefined` when they are disabled.
 */
export const ATLAS_VOLUMES_DIR = "ATLAS_VOLUMES_DIR";

export function atlasOutbound(cfg: { userAgent: string; timeoutMs: number }): OutboundClient {
  // `cfg` is passed straight through, not re-wrapped: `OutboundHttp` holds its options and reads
  // them per request, so whatever liveness the caller's object has is preserved by doing nothing.
  return { http: new OutboundHttp(cfg), limiter: new OutboundLimiter(() => 0) };
}
