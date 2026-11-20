/**
 * How a consumer turns a place's `upstream` ids into the `sourceId` it stores —
 * `apps/atlas/doc/spec/place-identity.md` §6 step 1.
 *
 * **A fixed order, so two volumes describing one place independently derive the same key.** That is the
 * whole point: matching downstream is string equality, so the order cannot be a preference either side
 * expresses locally.
 *
 * Shared with the builder because the builder owns the id *vocabulary* (`upstream.ts`) and the consumer
 * owns the *derivation*, and a disagreement between them is silent — it produces a key that matches
 * nothing, which reads exactly like "this place is new" and duplicates it.
 */
import { osmSourceId, parseContribSourceId } from "@beaconsgg/place-taxonomy";

/**
 * Namespaces that can name a place, most authoritative first.
 *
 * `contrib` leads, and only for the server that issued it: a `contrib:<host>/<unique>` id is **this
 * server's own place unique**, which is the most direct key there is. It has to outrank `osm`,
 * because a contributed improvement to an OSM place carries both and the local record was created
 * under the contribution's key.
 *
 * `osm` follows because it is the other namespace a Beacon server may **already hold records under**:
 * a server that snapshotted OSM directly has `way/586464226` in `place_sources`, and an Atlas record has
 * to land on it rather than beside it.
 */
const PRIORITY = ["contrib", "osm", "wd", "nrhp", "gnis", "nps"] as const;

/** `osm:w/586464226` → `w`, `586464226`. The builder's namespaced form, which is not the server's. */
const OSM_ID = /^osm:([nwr])\/(\d+)$/;

/** The one-letter form the builder uses → the osm2pgsql type code `osmSourceId` takes. */
const OSM_TYPE_CODE = { n: "N", w: "W", r: "R" } as const;

/**
 * The `sourceId` for a place, given the `upstream` ids it carries and its Atlas id as the fallback.
 *
 * Falls back to the Atlas id when nothing in `upstream` can name it — which is correct rather than
 * a defeat: a place only Atlas knows about is keyed by Atlas, and its id is stable forever by
 * construction (`apps/atlas/doc/spec/place-identity.md` §5).
 */
export function sourceIdFor(
  upstream: readonly string[],
  atlasId: string,
  /**
   * This consumer's own host — **required**, because the one thing it controls is whether a place
   * that originated here as a contribution is recognised coming home or duplicated, and a default
   * would make forgetting it silent. `ServerConfig.host` is required and validated at boot, so no
   * caller legitimately lacks one.
   */
  selfHost: string,
): string {
  for (const namespace of PRIORITY) {
    for (const id of upstream) {
      const rendered = renderSourceId(namespace, id, selfHost);
      if (rendered) return rendered;
    }
  }
  return atlasId;
}

/**
 * One id in the consumer's spelling, or nothing if it is not of that namespace.
 *
 * **OSM is rendered in the existing connector's convention** — `way/586464226`, not the builder's
 * `osm:w/586464226` — because that is what a server's own `osm` snapshot already wrote, and step 3's
 * matching is string equality. Built with `osmSourceId`, the shared producer of that form, rather than by
 * concatenation: `osm-refs.ts` says outright that a divergent spelling "duplicates every place instead of
 * merging it — silently, with no error anywhere".
 *
 * Everything else keeps its namespace prefix, which cannot collide with the OSM form.
 */
function renderSourceId(namespace: string, id: string, selfHost: string): string | undefined {
  if (namespace === "contrib") {
    // **Only this server's own contributions resolve.** A `contrib:<host>/<unique>` id is a place
    // unique in `<host>`'s namespace, and uniques are ULIDs minted independently per server — so
    // rendering another host's would be a lookup against an id space we do not share, and could
    // collide with a local place that has nothing to do with it. Another host's contribution falls
    // through to the Atlas id, which is right: to this server it is simply a place Atlas knows.
    const parsed = parseContribSourceId(id.slice("contrib:".length));
    return parsed?.host === selfHost ? parsed.unique : undefined;
  }
  if (namespace === "osm") {
    const match = OSM_ID.exec(id);
    if (!match) return undefined;
    const [, letter, number] = match as unknown as [string, keyof typeof OSM_TYPE_CODE, string];
    return osmSourceId(OSM_TYPE_CODE[letter], number);
  }
  return id.startsWith(`${namespace}:`) ? id : undefined;
}

/**
 * Every id a consumer should try when looking for a place it may already hold under another key — the
 * derived `sourceId` first, then the place's former ids.
 *
 * A tile's `aliases` are **former Atlas ids**, and a place with no upstream id is keyed by its
 * Atlas id — so an alias is looked up as a `sourceId` through the same query, not through a second
 * mechanism (`apps/atlas/doc/spec/place-identity.md` §5: a merged place's losing id keeps
 * resolving, forever).
 */
export function candidateSourceIds(
  upstream: readonly string[],
  atlasId: string,
  aliases: readonly string[],
  selfHost: string,
): string[] {
  const primary = sourceIdFor(upstream, atlasId, selfHost);
  // Deduped and order-preserving: the derived id must be tried first, and an alias equal to it adds
  // nothing but a wasted query per place.
  return [...new Set([primary, ...aliases])];
}
