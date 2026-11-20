import {
  MAX_PLACE_DESCRIPTION_LEN,
  type PlaceCategory,
  type PlaceSubcategory,
} from "@beaconsgg/protocol-types";

/**
 * The OSM tag → taxonomy mapping (`doc/spec/places.md` §1 and §4). Games code against the neutral
 * `PlaceCategory` buckets, never OSM vocabulary; this module is the one seam that translates —
 * every OSM element is classified through the same {@link entryForTags} matcher.
 */

/** One OSM key/value filter and the taxonomy bucket + subcategory a match is reported under. */
export interface OsmTagMapping {
  key: string; // OSM key, e.g. "leisure"
  value: string; // OSM value, e.g. "stadium"
  category: PlaceCategory; // neutral taxonomy bucket surfaced to the game
  /**
   * The curated **group** slug several tags share (`nature/water` = beach, spring, waterfall…),
   * when it differs from `value` — the default IS the tag value ({@link subcategoryOf}), so a
   * group named after its only tag needs no entry. Descriptor only (games display / switch on
   * it; no query facet — that promotion has a documented trigger on `placeSubcategorySchema`).
   */
  subcategory?: PlaceSubcategory;
  /**
   * Objects matching this entry are kept even without a `name` (surveillance gear is ~never
   * named). Everything else stays name-required — in the Overpass QL clause AND the Lua import
   * filter's NAMELESS_OK pair list (`apps/atlas/osm-import/beacon-places.lua`, CI-pinned).
   */
  nameless?: true;
}

/** The subcategory slug an entry reports: the explicit rename, else the tag value itself. */
export function subcategoryOf(entry: OsmTagMapping): PlaceSubcategory {
  return entry.subcategory ?? entry.value;
}

/** The descriptor facts enrichment derives from an element's tags (all optional). */
export interface PlaceEnrichment {
  /** Synthesized display name — only for nameless surveillance gear with a known brand. */
  name?: string;
  description?: string;
  website?: string;
  /** The English Wikipedia article URL (only `en:` entries). */
  wikipedia?: string;
  /** "Also known as" names, deduped against each other (the caller drops ones equal to `name`). */
  altNames?: string[];
}

export const DESCRIPTION_MAX = MAX_PLACE_DESCRIPTION_LEN;
const WEBSITE_MAX = 300;
const ALT_NAME_MAX = 256;
const MAX_ALT_NAMES = 8;
/** The tags "also known as" collects from, in display order. `alt_name` is `;`-separated. */
const ALT_NAME_TAGS = ["alt_name", "short_name", "official_name", "old_name"] as const;

/**
 * The shared tag→descriptor enrichment, next to the classifier so both connectors report the same
 * facts (`apps/atlas/doc/spec/cartographer.md` §1.1): the OSM `description` tag (or, for
 * surveillance gear, a line synthesized from `surveillance:type`/`manufacturer`/`brand`/`operator`
 * — the DeFlock mapping convention, so a Flock ALPR identifies itself), the
 * `website`/`contact:website`/`url` tag scheme-normalized, and — **branded gear only** — a
 * synthesized name for nameless cameras ("Flock Safety ALPR"); generic unnamed cameras stay
 * nameless (the UI shows the category label).
 */
export function enrichmentForTags(
  tags: Record<string, string>,
  entry: OsmTagMapping,
): PlaceEnrichment {
  const out: PlaceEnrichment = {};

  const website = normalizeWebsite(tags["website"] ?? tags["contact:website"] ?? tags["url"]);
  if (website) out.website = website;

  const wikipedia = englishWikipediaUrl(tags);
  if (wikipedia) out.wikipedia = wikipedia;

  const altNames = collectAltNames(tags);
  if (altNames.length > 0) out.altNames = altNames;

  let description = tags["description"]?.trim().slice(0, DESCRIPTION_MAX);
  if (entry.category === "surveillance") {
    const brand = tags["manufacturer"]?.trim() || tags["brand"]?.trim();
    const alpr = (tags["surveillance:type"] ?? "").trim().toLowerCase() === "alpr";
    const operator = tags["operator"]?.trim();
    if (!description && (brand || alpr || operator)) {
      const what = alpr
        ? "ALPR (automatic license plate reader) camera"
        : entry.value === "speed_camera"
          ? "speed camera"
          : "surveillance camera";
      description = `${brand ? `${brand} ` : ""}${what}${
        operator ? `, operated by ${operator}` : ""
      }`.slice(0, DESCRIPTION_MAX);
    }
    if (!tags["name"] && brand) {
      out.name = `${brand} ${alpr ? "ALPR" : entry.value === "speed_camera" ? "speed camera" : "camera"}`;
    }
  }
  if (description) out.description = description;

  return out;
}

/**
 * The English Wikipedia article URL, or nothing: `wikipedia=en:Title` (the language-prefixed
 * convention) or the `wikipedia:en=Title` variant. Other languages are deliberately skipped — a
 * `de:` article doesn't serve an English-language place card, and language fallback is a game
 * decision.
 */
function englishWikipediaUrl(tags: Record<string, string>): string | undefined {
  const prefixed = tags["wikipedia"]?.trim();
  const title = prefixed?.toLowerCase().startsWith("en:")
    ? prefixed.slice(3).trim()
    : tags["wikipedia:en"]?.trim();
  return title ? enwikiArticleUrl(title) : undefined;
}

/**
 * An English Wikipedia article URL from its title, or nothing when the result would exceed the URL
 * cap the wire enforces.
 *
 * Shared because two fields point at the same article from different directions: a place's
 * `wikipedia` link, and the `sourceUrl` of the `descriptionCredit` on a summary taken from it. Built
 * separately, they drifted immediately — one applied the cap and the other didn't, so a long-titled
 * article yielded a place with no `wikipedia` field but a credit citing it.
 */
export function enwikiArticleUrl(title: string): string | undefined {
  const url = `https://en.wikipedia.org/wiki/${encodeURIComponent(title.trim().replace(/ /g, "_"))}`;
  return url.length <= WEBSITE_MAX ? url : undefined;
}

/** "Also known as": the alternate-name tags, split (`alt_name` is `;`-separated) and deduped. */
function collectAltNames(tags: Record<string, string>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const tag of ALT_NAME_TAGS) {
    for (const part of (tags[tag] ?? "").split(";")) {
      const name = part.trim().slice(0, ALT_NAME_MAX);
      // Dedupe case-insensitively and never repeat the primary name back as an alias.
      const key = name.toLowerCase();
      if (!name || seen.has(key) || key === tags["name"]?.trim().toLowerCase()) continue;
      seen.add(key);
      out.push(name);
      if (out.length >= MAX_ALT_NAMES) return out;
    }
  }
  return out;
}

/** Trim + default the scheme + validate; junk (or an over-long URL) is dropped, never guessed. */
function normalizeWebsite(raw: string | undefined): string | undefined {
  const trimmed = raw?.trim();
  if (!trimmed) return undefined;
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  if (withScheme.length > WEBSITE_MAX) return undefined;
  try {
    new URL(withScheme);
    return withScheme;
  } catch {
    return undefined;
  }
}

/**
 * Every OSM key/value the `osm` connector queries for — a curated "fun for a game" set, not a
 * gazetteer: each category is a distinct game lever (games only ever see the bucket + slug).
 * Standard place types, not game rules, so the server stays game-agnostic.
 *
 * Curation principle: **no sensitive locations** — schools, hospitals, places of worship and the
 * like stay out of the dataset by design; check any new tag against this before adding it.
 * Overlaps resolve by first-match order here — most-specific first, with `tourism=attraction`
 * (OSM's vaguest tag) dead last so it never shadows a specific type.
 */
export const OSM_TAG_MAP: readonly OsmTagMapping[] = [
  // Parks — the core outdoor play surface (real polygons for "you're inside it")
  { key: "leisure", value: "park", category: "park", subcategory: "park" },
  { key: "leisure", value: "garden", category: "park", subcategory: "park" },
  { key: "leisure", value: "playground", category: "park", subcategory: "play" },
  { key: "leisure", value: "dog_park", category: "park", subcategory: "pets" },
  { key: "leisure", value: "nature_reserve", category: "park", subcategory: "reserve" },
  // …and the sparse-area half of the same surface: out where there are no shops or public art, a
  // campground or a picnic site IS the landmark (`apps/atlas/doc/spec/sources.md` §6: remote and
  // dense are both first-class).
  { key: "tourism", value: "camp_site", category: "park", subcategory: "camp" },
  { key: "tourism", value: "picnic_site", category: "park", subcategory: "picnic" },
  // Nature — scenic physical features
  { key: "natural", value: "beach", category: "nature", subcategory: "water" },
  { key: "natural", value: "spring", category: "nature", subcategory: "water" },
  { key: "natural", value: "hot_spring", category: "nature", subcategory: "water" },
  { key: "natural", value: "geyser", category: "nature", subcategory: "water" },
  { key: "waterway", value: "waterfall", category: "nature", subcategory: "water" },
  { key: "natural", value: "peak", category: "nature", subcategory: "mountain" },
  { key: "natural", value: "volcano", category: "nature", subcategory: "mountain" },
  { key: "natural", value: "ridge", category: "nature", subcategory: "mountain" },
  { key: "natural", value: "glacier", category: "nature" },
  { key: "natural", value: "cave_entrance", category: "nature", subcategory: "cave" },
  { key: "leisure", value: "marina", category: "nature", subcategory: "harbor" },
  // History — historic sites
  { key: "historic", value: "castle", category: "history", subcategory: "fortification" },
  { key: "historic", value: "fort", category: "history", subcategory: "fortification" },
  { key: "historic", value: "monument", category: "history", subcategory: "memorial" },
  { key: "historic", value: "memorial", category: "history", subcategory: "memorial" },
  { key: "historic", value: "ruins", category: "history", subcategory: "ruins" },
  { key: "historic", value: "archaeological_site", category: "history", subcategory: "ruins" },
  // Culture — arts
  { key: "tourism", value: "museum", category: "culture" },
  { key: "tourism", value: "gallery", category: "culture", subcategory: "gallery" },
  { key: "tourism", value: "artwork", category: "culture", subcategory: "gallery" },
  // Wildlife — animal attractions
  { key: "tourism", value: "zoo", category: "wildlife", subcategory: "animals" },
  { key: "tourism", value: "aquarium", category: "wildlife", subcategory: "animals" },
  // Entertainment — theme parks, movies, plays, arcades
  { key: "amenity", value: "cinema", category: "entertainment", subcategory: "shows" },
  { key: "amenity", value: "theatre", category: "entertainment", subcategory: "shows" },
  { key: "tourism", value: "theme_park", category: "entertainment", subcategory: "rides" },
  { key: "leisure", value: "amusement_arcade", category: "entertainment", subcategory: "games" },
  // Music — venues and stores
  { key: "amenity", value: "concert_hall", category: "music", subcategory: "venue" },
  { key: "amenity", value: "music_venue", category: "music", subcategory: "venue" },
  { key: "shop", value: "music", category: "music", subcategory: "shop" },
  // Community — public gathering and civic places
  { key: "amenity", value: "library", category: "community", subcategory: "learning" },
  { key: "amenity", value: "public_bookcase", category: "community", subcategory: "learning" },
  { key: "amenity", value: "townhall", category: "community", subcategory: "civic" },
  { key: "amenity", value: "post_office", category: "community", subcategory: "civic" },
  { key: "amenity", value: "community_centre", category: "community", subcategory: "gathering" },
  { key: "amenity", value: "social_centre", category: "community", subcategory: "gathering" },
  // Sports — stadium keeps its own slug (the marquee-venue lever: an MLB park is not a rec
  // center); no leisure=pitch — every school ballfield, pure noise.
  { key: "leisure", value: "stadium", category: "sports" },
  { key: "leisure", value: "sports_centre", category: "sports", subcategory: "team" },
  { key: "leisure", value: "golf_course", category: "sports", subcategory: "individual" },
  { key: "leisure", value: "ice_rink", category: "sports", subcategory: "individual" },
  // Sweets — candy / bakery / ice cream
  { key: "shop", value: "bakery", category: "sweets", subcategory: "bakery" },
  { key: "shop", value: "pastry", category: "sweets", subcategory: "bakery" },
  { key: "shop", value: "chocolate", category: "sweets", subcategory: "treats" },
  { key: "shop", value: "confectionery", category: "sweets", subcategory: "treats" },
  { key: "shop", value: "ice_cream", category: "sweets", subcategory: "treats" },
  { key: "amenity", value: "ice_cream", category: "sweets", subcategory: "treats" },
  // Shopping — specialty retail
  { key: "shop", value: "art", category: "shopping", subcategory: "creative" },
  { key: "shop", value: "craft", category: "shopping", subcategory: "creative" },
  { key: "shop", value: "fabric", category: "shopping", subcategory: "creative" },
  { key: "shop", value: "books", category: "shopping", subcategory: "collectibles" },
  { key: "shop", value: "comics", category: "shopping", subcategory: "collectibles" },
  { key: "shop", value: "games", category: "shopping", subcategory: "collectibles" },
  { key: "shop", value: "toys", category: "shopping", subcategory: "collectibles" },
  { key: "shop", value: "florist", category: "shopping", subcategory: "gifts" },
  { key: "shop", value: "gift", category: "shopping", subcategory: "gifts" },
  { key: "shop", value: "antiques", category: "shopping", subcategory: "gifts" },
  // Transport — natural hubs people already walk through (no bus stops)
  { key: "railway", value: "station", category: "transport", subcategory: "rail" },
  { key: "amenity", value: "ferry_terminal", category: "transport", subcategory: "water" },
  // Surveillance — the only nameless-allowed entries (cameras are ~never named). Finer splits
  // (red-light / LPR under `traffic` vs `security`) live in SECONDARY tags
  // (surveillance:type=ALPR, surveillance:zone=traffic) — the expansion path is a per-entry
  // secondary-tag refiner, added when the game wants the distinction.
  {
    key: "highway",
    value: "speed_camera",
    category: "surveillance",
    subcategory: "traffic",
    nameless: true,
  },
  {
    key: "man_made",
    value: "surveillance",
    category: "surveillance",
    subcategory: "security",
    nameless: true,
  },
  // Landmark — recognizable points of interest. `attraction` stays LAST in the whole map: it's
  // OSM's vaguest tag, so anything more specific above must win the first-match classification.
  { key: "tourism", value: "viewpoint", category: "landmark", subcategory: "scenic" },
  { key: "man_made", value: "lighthouse", category: "landmark", subcategory: "structure" },
  { key: "man_made", value: "windmill", category: "landmark", subcategory: "structure" },
  { key: "amenity", value: "fountain", category: "landmark", subcategory: "structure" },
  { key: "tourism", value: "attraction", category: "landmark", subcategory: "structure" },
];

/**
 * The version of the vocabulary below: 14 categories, grouped subcategory slugs, sensitive
 * locations excluded (`apps/atlas/doc/spec/cartographer.md` §1.1).
 *
 * It exists because an **Atlas volume carries it in its manifest** and a consumer has to decide
 * whether it understands what it was handed: a reader on an older version may meet a category it
 * has no case for, and one on a newer version may expect subcategories the volume never had. That
 * is a warning and a documented behaviour (`apps/atlas/doc/spec/beacon-integration.md` §7), never a
 * silent coercion — which is only possible if both sides read the same number, so it lives beside
 * the vocabulary it describes rather than being spelled out at each end.
 *
 * **Bump it when the vocabulary changes meaning**, not when a slug is added: an additive slug degrades
 * to itself (see {@link PLACE_VOCABULARY}), whereas a renamed or re-parented category does not.
 */
export const TAXONOMY_VERSION = 3;

/**
 * The curated category → subcategory vocabulary, **derived** from {@link OSM_TAG_MAP} so the tag map
 * stays the single source of truth and this can never advertise a slug the connectors don't produce.
 *
 * It exists because a contributor has to *pick* a category and subcategory for a place they're
 * proposing (`doc/spec/place-proposals.md` §4.2), and `placeSubcategorySchema` is deliberately a
 * bounded slug rather than a second enum — which keeps the vocabulary server-side and growable by a
 * tag-map edit, but leaves a client with nothing to render. `GET /places/taxonomy` serves this.
 *
 * Slugs only: labels are a game concern (a client displays its own, falling back to the raw slug),
 * so a slug added here before an app release degrades to itself rather than breaking.
 */
export const PLACE_VOCABULARY: readonly { category: PlaceCategory; subcategories: string[] }[] =
  buildVocabulary();

function buildVocabulary(): { category: PlaceCategory; subcategories: string[] }[] {
  const byCategory = new Map<PlaceCategory, Set<string>>();
  for (const entry of OSM_TAG_MAP) {
    const slugs = byCategory.get(entry.category) ?? new Set<string>();
    slugs.add(subcategoryOf(entry));
    byCategory.set(entry.category, slugs);
  }
  // Alphabetical at both levels: insertion order would already be deterministic, but sorting means
  // reordering the tag map (a routine curation edit) doesn't churn a cached response.
  return [...byCategory.entries()]
    .map(([category, slugs]) => ({ category, subcategories: [...slugs].sort() }))
    .sort((a, b) => (a.category < b.category ? -1 : 1));
}

/**
 * Whether `subcategory` is a curated slug **of that category** — the pair is what's meaningful, since
 * slugs are namespaced per category (a `water` exists under both `nature` and `transport`). Player
 * submissions are fenced to this; admin writes deliberately are not (an operator may be adding a slug
 * ahead of the tag map).
 */
export function isVocabularyPair(category: PlaceCategory, subcategory: string): boolean {
  return (
    PLACE_VOCABULARY.find((v) => v.category === category)?.subcategories.includes(subcategory) ??
    false
  );
}

/**
 * The first mapping entry an element's tags match, or `undefined` when nothing maps — **the** OSM
 * classifier, shared by the v1 query parse and the v2 connectors so they never diverge.
 */
export function entryForTags(
  tags: Record<string, string>,
  entries: readonly OsmTagMapping[] = OSM_TAG_MAP,
): OsmTagMapping | undefined {
  return entries.find((e) => tags[e.key] === e.value);
}

/** The mapping entries for a category subset (a snapshot's category filter), or all when unset. */
export function entriesForCategories(
  categories: readonly PlaceCategory[] | undefined,
): readonly OsmTagMapping[] {
  if (!categories || categories.length === 0) return OSM_TAG_MAP;
  return OSM_TAG_MAP.filter((e) => categories.includes(e.category));
}
