import type { BBox } from "@beaconsgg/geo";
import type { OutboundClient } from "../../common/outbound-http";
import type {
  LatLng,
  Media,
  MediaCredit,
  PlaceCategory,
  PlaceGeometry,
  PlaceSubcategory,
} from "@beaconsgg/protocol-types";

/**
 * The connector seam (`doc/spec/places.md` §6.1): a connector translates a source's vocabulary into
 * taxonomy-mapped {@link SourcePlace}s; the run engine owns everything else (chunking,
 * upsert/merge, retirement, stats). Places come from three inputs only
 * (`apps/atlas/doc/spec/beacon-integration.md` §6), so there is exactly one implementation — the
 * Atlas connector, constructed per import from the volume being imported — but the seam stays: the
 * engine is generic over *what is being read*, which is also what lets tests drive it without a
 * volume in hand.
 */

/** One place as a connector reports it: mapped canonical fields + provenance. */
export interface SourcePlace {
  /** Stable within the source, e.g. `node/123` — the upsert identity `(source, sourceId)`. */
  sourceId: string;
  fields: {
    category: PlaceCategory;
    subcategory?: PlaceSubcategory;
    name?: string;
    description?: string;
    /** Attribution for `description`, when the source's text came with terms (a CC BY-SA summary).
     *  Merged as an attribute of `description`, never on its own — see `merge.ts`'s `OWNED_BY`. */
    descriptionCredit?: MediaCredit;
    website?: string;
    wikipedia?: string;
    altNames?: string[];
    point: LatLng;
    geometry?: PlaceGeometry;
    /** Media the source itself supplies (the import path — already content-addressed locally). */
    media?: Media[];
  };
  /** The raw source payload (e.g. OSM tags), kept on the source record for re-mapping/debug. */
  raw?: unknown;
  /** The license/credit line this source's data carries (per-record — it must survive merges). */
  attribution?: string;
  /**
   * `sourceId`s this place was **formerly** keyed under, newest-irrelevant-first.
   *
   * A source that resolves duplicates upstream (Atlas) merges two places into one and keeps the
   * losing id forever, so a consumer holding the old key can follow it. The runner tries these
   * after `sourceId` itself when looking for a place it may already hold, which turns an upstream
   * merge into a field update on the same place rather than a retire-plus-create that would take
   * the operator's edits and the players' contributions with it
   * (`apps/atlas/doc/spec/place-identity.md` §5).
   *
   * The connector supplies the ids; the **runner** does the lookups, because connectors are pure mappers
   * with no store access.
   */
  aliasSourceIds?: readonly string[];
}

/**
 * How to fetch the bytes behind media a connector supplied, when its addresses are not `hash@host`.
 *
 * Declared by the connector and consumed by the runner, so the widening stays **scoped to sources the
 * operator configured**. The alternative — teaching `mediaOriginUrl` to accept any absolute URL — would widen
 * the same code path that untrusted `places.import` data flows through, where `hash@host` plus
 * `unique === entry.hash` is currently the only thing stopping an uploaded file from naming an arbitrary host
 * and path.
 *
 * `type` is asserted rather than sniffed for a related reason: a static host serving a volume may answer
 * `application/octet-stream`, which the media capability's allowlist refuses, so trusting the header would
 * make a correctly-published volume lose every photo on a slightly-misconfigured mirror.
 *
 * `outbound` carries the **pacing** too, which is the third fact of the same kind. A connector already owns a
 * client tuned for its host — the Atlas one is unpaced because a volume is static files that owe nobody
 * fairness — and supplying it here is what keeps that one client rather than having the module graph build a
 * second `MediaTransfer` by hand with a second timeout knob to forget to keep aligned.
 */
export interface MediaTransport {
  origin(entry: Media): string | undefined;
  type: string;
  outbound: OutboundClient;
  /**
   * Local bytes instead of a fetch — a staged Atlas archive, whose media is already on this disk.
   * When present it wins over {@link origin}; the transfer's verification chain is identical either
   * way (metadata detect + re-hash), so a tampered archive drops like tampered network bytes.
   */
  load?(entry: Media): Promise<Buffer | undefined>;
}

export interface PlaceConnector {
  /** The source name records are keyed under, e.g. `"osm"`. */
  readonly id: string;
  /** Fetch every matching place in one chunk bbox (a snapshot decomposes its boundary into these). */
  fetchChunk(bbox: BBox, categories: readonly PlaceCategory[] | undefined): Promise<SourcePlace[]>;
  /** Present only for a source whose media is not addressed `hash@host` — see {@link MediaTransport}. */
  readonly mediaTransport?: MediaTransport;
}
