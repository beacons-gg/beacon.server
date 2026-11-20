import type { MediaCredit } from "@beaconsgg/protocol-types";

/**
 * The OSM/Wikimedia **reference vocabulary** — the facts about an OSM element's outbound references
 * that every ingestion path has to agree on: how an element is named as a source id, which tags can
 * name a photo, how a Commons file reference is spelled, and what Wikipedia's reuse terms are.
 *
 * These live beside the tag map for the same reason it does. They were written for three programs: the
 * beacon server's snapshot connectors, its image ingestor, and Cartographer. The first two were retired in
 * 27d69d8; today Cartographer writes these facts into a volume and `@beaconsgg/atlas-volume` reads the source
 * id back. Each fact below has already cost something when a copy drifted:
 *
 * - **the Commons title form**: comparing an underscore title against MediaWiki's space form rejected
 *   *every* lead image, a 100% rejection rate indistinguishable from "these articles have no photos"
 * - **the image-tag list**: a copy that omits a tag yields a place with a photo on one path and none
 *   on the other, visible only by diffing the two
 * - **the source id form**: `upsert` resolves identity on `(source, sourceId)`, so a divergent
 *   spelling duplicates every place instead of merging it — silently, with no error anywhere
 */

const OSM_TYPE_NAME = { N: "node", W: "way", R: "relation" } as const;

/** The one-letter osm2pgsql type code (`N`/`W`/`R`). */
export type OsmTypeCode = keyof typeof OSM_TYPE_NAME;

/**
 * The `sourceId` an OSM element is stored under: `way/586464226`.
 *
 * The **Overpass-parity** form, and it has to stay that way — a local osm2pgsql snapshot, an Overpass
 * snapshot, and an Atlas volume all upsert onto the same records, and identity resolves on
 * `(source, sourceId)`. Returns nothing for an unrecognized type code rather than inventing a prefix.
 */
export function osmSourceId(type: string, id: string): string | undefined {
  const name = OSM_TYPE_NAME[type as OsmTypeCode];
  return name ? `${name}/${id}` : undefined;
}

/** A place unique — a ULID, the id form every Beacon server mints places under. */
const ULID = "[0-9A-HJKMNP-TV-Z]{26}";

/** `contrib:beacon.example/01ARZ3NDEKTSV4RRFFQ69G5FAV` — host, then that host's place unique. */
const CONTRIB_ID = new RegExp(`^([^/\\s]+)/(${ULID})$`);

/**
 * The `sourceId` a **contributed** place is named by across the round trip: `<host>/<unique>`.
 *
 * Here with {@link osmSourceId} and for the same stated reason. Three programs spell this form —
 * the exporting server produces it, Cartographer validates it as an upstream-id namespace, and a
 * consumer parses it back to decide whether the place is one of its own coming home
 * (`apps/atlas/doc/spec/place-identity.md` §7). A divergent spelling between any two of them does
 * not error: the consumer fails to recognise its own contribution, creates a second copy of a place
 * it already holds, and the operator edits and player contributions stay on the original.
 *
 * `<host>` is matched loosely (anything without a slash or whitespace) because it is whatever the
 * exporting server calls itself — a hostname, a hostname with a port. The ULID is not: an id that
 * is not one names no place, and a guessed id is worse than a missing one.
 */
export function contribSourceId(host: string, unique: string): string {
  return `${host}/${unique}`;
}

/** `<host>/<unique>` split back apart, or nothing if it is not that form. */
export function parseContribSourceId(id: string): { host: string; unique: string } | undefined {
  const match = CONTRIB_ID.exec(id);
  return match ? { host: match[1] as string, unique: match[2] as string } : undefined;
}

/**
 * Whether a bare `sourceId` is the Overpass-parity OSM form — `way/586464226`.
 *
 * The inverse question to {@link osmSourceId}, needed by anything that receives source ids without
 * their source name and has to tell one namespace from another.
 */
export function isOsmSourceId(id: string): boolean {
  return /^(?:node|way|relation)\/\d+$/.test(id);
}

/**
 * Every tag an image can be resolved from, in resolution order.
 *
 * One list, several questions asked of it. The one that drifts silently is the one that decides a
 * place has no photo when it has one.
 */
export const IMAGE_TAGS = ["image", "wikimedia_commons", "wikidata", "brand:wikidata"] as const;

/**
 * A Commons file reference normalized to a `File:Name` title — the form the credit lookup wants, and
 * the form MediaWiki answers in. Accepts a bare name, a `File:`-prefixed one, or an upload URL.
 *
 * **Underscores become spaces**, which is not cosmetic: MediaWiki treats the two as the same
 * character in a title but always *replies* with the space form, while `pageimage` hands them out
 * with underscores. Comparing the two directly meant every single lead image looked absent from
 * Commons and was rejected — a 100% rejection rate that reads exactly like "these articles have no
 * free images."
 *
 * Trim before stripping the prefix, too: the `^File:` anchor can't match past leading whitespace, so
 * the other order doubles the prefix on a padded value.
 */
export function commonsFileTitle(raw: string): string {
  return `File:${bareCommonsName(raw).replace(/_/g, " ")}`;
}

/**
 * The bare file name, underscores intact — what a URL builder needs, since `Special:FilePath` and the
 * upload host both accept either form and percent-encoding a space is one more thing to get wrong.
 */
export function bareCommonsName(raw: string): string {
  const trimmed = raw.trim();
  return (commonsNameFromUrl(trimmed) ?? trimmed).replace(/^File:/i, "").trim();
}

/**
 * The `File:Name` title inside a Wikimedia URL, or nothing when the URL names no file — the
 * distinction the caller needs, since a URL from some other Wikimedia host is still fetchable but has
 * no title to look a credit up by.
 */
export function commonsFileTitleFromUrl(url: string): string | undefined {
  const name = commonsNameFromUrl(url.trim());
  return name === undefined ? undefined : commonsFileTitle(name);
}

/**
 * The file name inside a Wikimedia URL, in either of the two forms that actually occur in OSM tags.
 * Both are measured on a us-west extract's 1,302 `wikimedia_commons` values:
 *
 * - a **wiki page** URL, `https://commons.wikimedia.org/wiki/File:Example.jpg` — 10 values
 * - an **upload** URL, `https://upload.wikimedia.org/wikipedia/commons/a/ab/Example.jpg`, or its
 *   `/thumb/a/ab/Example.jpg/800px-…` variant — 1 value
 *
 * Matching the upload form's sharded `a/ab/` path is what makes the thumb variant work: taking the
 * last path segment instead would yield `800px-Example.jpg`, a file that does not exist. The page form
 * has to be handled separately for the same reason it can't share that rule — it has no shard — and it
 * is the commoner of the two, so a helper that only knew the upload form would mangle nine values into
 * a `File:https://…` title.
 */
function commonsNameFromUrl(url: string): string | undefined {
  const name =
    /\/wiki\/(?:File|Image):([^/?#]+)/i.exec(url)?.[1] ??
    /\/commons\/(?:thumb\/)?[0-9a-f]\/[0-9a-f]{2}\/([^/]+)/i.exec(url)?.[1];
  if (!name) return undefined;
  try {
    return decodeURIComponent(name);
  } catch {
    return name;
  }
}

/** The prefix that makes a Commons title a category rather than a file. */
const COMMONS_CATEGORY_PREFIX = "Category:";

/**
 * Whether this Commons reference names a **category** — a set of photos of one place — rather than a file.
 *
 * The distinction is the whole value of the reference: an article's lead image is one editor's hero shot,
 * while a category is "photos of exactly this thing". OSM's `wikimedia_commons` tag carries either.
 */
export function isCommonsCategory(raw: string): boolean {
  return raw.trim().startsWith(COMMONS_CATEGORY_PREFIX);
}

/**
 * A Commons category reference normalized to `Category:Name`.
 *
 * Here beside {@link commonsFileTitle} because it is the same class of fact and has the same failure mode:
 * OSM states the prefix and Wikidata's P373 states a bare name, so the two must be spelled identically or
 * the tier-2 bridge silently misses every category. Three separate string literals were doing this job.
 *
 * **Underscores become spaces**, for {@link commonsFileTitle}'s reason: MediaWiki treats the two as one
 * title but always replies in the space form, and OSM tags carry pasted-URL underscores where P373 and the
 * API carry spaces — one category, two cache keys, and the bridge and the category cache both miss.
 */
export function commonsCategoryTitle(raw: string): string {
  const value = raw.trim().replace(/_/g, " ");
  return isCommonsCategory(value) ? value : `${COMMONS_CATEGORY_PREFIX}${value}`;
}

/**
 * Attribution required for OSM-derived data (ODbL) — the one shared copy of the credit line.
 *
 * Here rather than in the server for the reason {@link WIKIPEDIA_CREDIT} gives: it is an
 * **attribution** fact, and the copy that doesn't get updated is the one already baked into
 * published data. It now has three consumers rather than one — the server's two connectors and **an
 * Atlas volume's source dictionary** — and the file it used to live in (`places/overpass.ts`) is
 * scheduled for deletion by the three-inputs decision (`apps/atlas/doc/spec/beacon-integration.md`
 * §6), which would have orphaned it.
 */
export const OSM_ATTRIBUTION = "© OpenStreetMap contributors (ODbL)";

/** ODbL's canonical URL, for a volume's machine-readable licence entry (`apps/atlas/doc/spec/volume-format.md` §7). */
export const ODBL_URL = "https://opendatacommons.org/licenses/odbl/1-0/";

/**
 * Wikipedia's reuse terms, for a description taken from an article extract.
 *
 * Constant rather than read from the data: only English Wikipedia extracts are ever stored, and they
 * are all under the same licence. Shared because it is an **attribution** fact — the copy that
 * doesn't get updated when Wikimedia moves version (3.0 → 4.0 has happened) is the one already baked
 * into published data.
 */
export const WIKIPEDIA_CREDIT = {
  license: "CC BY-SA 4.0",
  licenseUrl: "https://creativecommons.org/licenses/by-sa/4.0/",
  /** Articles have thousands of authors; this is the credit line Wikimedia's own reuse guide asks for. */
  author: "Wikipedia contributors",
} as const satisfies MediaCredit;
