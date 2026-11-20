/**
 * Stage 1's rules for the OSM source: one `beacon_places` row → one staging record, or nothing.
 *
 * **Pure.** No database, no network, no clock — so every classification decision, id form and media
 * reference is testable directly, and the paged loop in `normalize.ts` holds no rules of its own.
 * These are Cartographer's rules about *its* staging shape; the rule both Cartographer and the beacon
 * server must agree on — the taxonomy — is imported, not restated (`@beaconsgg/place-taxonomy`).
 */
import {
  commonsFileTitle,
  enrichmentForTags,
  entryForTags,
  IMAGE_TAGS,
  isCommonsCategory,
  osmSourceId,
  subcategoryOf,
} from "@beaconsgg/place-taxonomy";
import type { PlaceCategory } from "@beaconsgg/protocol-types";
import { IMAGERY_EXCLUDED_CATEGORY } from "./commons-geo";
import { OSM_SOURCE, type MediaRef, type OsmRow, type StagedRow } from "./store";
import { upstreamId, type UpstreamNamespace } from "./upstream";

/** The one-letter form the namespaced `upstream_ids` use (`osm:w/123`) — Wikidata's own convention. */
const OSM_TYPE_LETTER = { N: "n", W: "w", R: "r" } as const;

/**
 * One staged place, before the source it came from is attached (that is the writer's business).
 *
 * Derived from the row the writer inserts rather than declared twice: the two had already drifted
 * once — `subcategory` required here and optional there, `mediaRefs` typed and there not — and the
 * looser of the two belonged to the writer, so a field added to the staging shape would have compiled
 * with the writer silently dropping it.
 */
export type StagedRecord = Omit<StagedRow, "source">;

/**
 * Stage one row, or `undefined` when it can't be staged.
 *
 * Two reasons to drop a row, and both are ordinary rather than errors: the tags match no taxonomy
 * entry (the Lua import filter is key-level and coarse, so most of what it admitted classifies to
 * nothing), or PostGIS returned no representative point. The caller counts drops; it does not log
 * them individually, because at 860k rows "most rows don't classify" is the expected shape.
 *
 * Unlike the server's connector this applies **no wire caps and no schema validation**. Staging holds
 * what the source said; the volume publisher is where a field meets a length limit, and clamping this
 * early would mean the volume could never carry a longer one without a re-normalize.
 */
export function stageOsmRow(row: OsmRow): StagedRecord | undefined {
  const sourceId = osmSourceId(row.osm_type, row.osm_id);
  if (!sourceId || !row.point) return undefined;
  const tags = row.tags ?? {};
  const entry = entryForTags(tags);
  if (!entry) return undefined;

  const extra = enrichmentForTags(tags, entry);
  const name = row.name ?? extra.name;
  // No Wikipedia here any more. An article's summary and lead image now arrive as their own staged
  // `wikipedia` source (`wikipedia.ts`), so per-field merge decides what they win and the place's
  // `sources` array names whoever actually wrote the words — which folding them onto this record could
  // not do. The gap-fill rule survives the move for free: `OWNER_FIRST` already ranks `osm` above
  // `wikipedia` for `description`, which is exactly what the branch here used to enforce by hand.

  return {
    sourceId,
    category: entry.category,
    subcategory: subcategoryOf(entry),
    point: row.point,
    ...(name ? { name } : {}),
    ...(extra.altNames ? { altNames: extra.altNames } : {}),
    ...(extra.description ? { description: extra.description } : {}),
    ...(extra.website ? { website: extra.website } : {}),
    ...(extra.wikipedia ? { wikipedia: extra.wikipedia } : {}),
    ...(row.geom ? { geometry: row.geom } : {}),
    mediaRefs: mediaRefsFor(row, entry.category),
    upstreamIds: upstreamIdsFor(row),
    raw: tags,
  };
}

/**
 * The upstream identifiers this row **asserts** — for stage 2's concordance, never invented.
 *
 * `apps/atlas/doc/spec/place-identity.md` §1: an id here means "a source said this record is that
 * entity". A guessed id would be worse than a missing one, because stage 2 treats a shared upstream
 * id as tier-1 evidence and merges on it — and a wrong merge is a parking lot wearing a
 * lighthouse's description.
 *
 * Note the two deliberately different forms. `sourceId` keeps the **existing** `way/586464226` shape
 * so a Beacon server can match a record its own `osm` connector already wrote (`upsert` resolves
 * identity on `(source, sourceId)`); `upstream_ids` uses the **namespaced** `osm:w/586464226` form,
 * because there it sits in one array beside `wd:`, `nrhp:` and `commons:` ids and has to say which
 * namespace it belongs to.
 */
export function upstreamIdsFor(row: OsmRow): string[] {
  const tags = row.tags ?? {};
  const out: string[] = [];
  const add = (namespace: UpstreamNamespace, raw: string | undefined): void => {
    const id = raw === undefined ? undefined : upstreamId(namespace, raw);
    if (id) out.push(id);
  };

  add("osm", `${OSM_TYPE_LETTER[row.osm_type]}/${row.osm_id}`);

  // `brand:wikidata` is deliberately not read here: it names the chain, not the place. Treating it as
  // this entity's QID would concord every branch of a coffee shop into one place.
  add("wd", qidOf(tags));

  // `;`-separated, per OSM's list convention — a building can be listed on the register twice, and
  // measured on us-west, 9 of 1,861 `ref:nrhp` values are lists.
  for (const ref of splitList(tags["ref:nrhp"])) add("nrhp", ref);
  for (const ref of splitList(tags["gnis:feature_id"])) add("gnis", ref);

  add("commons", commonsCategoryOf(tags));

  return out;
}

/**
 * Every photo reference this row carries, for stage 4 to resolve — collected, not chosen.
 *
 * Ranking is stage 4's job (`apps/atlas/doc/spec/sources.md` §5 orders them), so all of them are
 * recorded rather than the best one. That also means a later ranking change costs a re-run of stage
 * 4 alone, not of this stage.
 *
 * `Category:` is recorded as its own kind rather than dropped, which is the gap
 * `apps/atlas/doc/spec/sources.md` §3 names: a category is a *set* of photos of exactly this place
 * — a better signal than an article's hero shot — and the beacon server's retired image ingestor
 * rejected it outright.
 */
export function mediaRefsFor(row: OsmRow, category: PlaceCategory): MediaRef[] {
  const tags = row.tags ?? {};
  const out: MediaRef[] = [];
  const add = (
    kind: MediaRef["kind"],
    value: string | null | undefined,
    claimedBy: string,
  ): void => {
    const trimmed = value?.trim();
    if (trimmed) out.push({ kind, value: trimmed, claimedBy });
  };

  // Walked in `IMAGE_TAGS` order — the shared list, so a tag the server's (since retired) ingestor
  // could resolve couldn't quietly be one Atlas never records. That happened to `brand:wikidata` in
  // the first cut of this function, which would have left every branded place with a photo on the
  // snapshot path and no media reference at all in a volume: strictly worse than what Atlas
  // replaces, and visible only by diffing the two paths. It is the one tag where the concordance
  // rule above and this one differ — a chain's QID is the wrong *identity* for a branch and the
  // right *logo* for it.
  //
  // `brand:wikidata` is its own kind, not folded into `wikidata`, because the two resolve through
  // different claims: a place's QID may carry a photo of the place (P18), while a brand's QID
  // carries the chain's logo (P154) — and its P18 is typically the company headquarters, exactly
  // the wrong image for a local branch. Surveillance places collect no brand ref at all: a vendor's
  // logo as a camera's place photo is the same waste `apps/atlas/doc/spec/sources.md` §3's category
  // exclusion names, and this is the one collection site that knows the category.
  for (const tag of IMAGE_TAGS) {
    const value = tags[tag]?.trim();
    if (!value) continue;
    if (tag === "image") add("url", value, OSM_SOURCE);
    else if (tag === "wikimedia_commons") {
      if (isCommonsCategory(value)) add("commons-category", value, OSM_SOURCE);
      else add("commons-file", commonsFileTitle(value), OSM_SOURCE);
    } else if (tag === "brand:wikidata") {
      if (category !== IMAGERY_EXCLUDED_CATEGORY && upstreamId("wd", value)) {
        add("brand-wikidata", value, OSM_SOURCE);
      }
    } else if (upstreamId("wd", value)) add("wikidata", value, OSM_SOURCE);
  }

  return out;
}

/**
 * This entity's own Wikidata QID, or nothing. **Not** `brand:wikidata` — see `upstreamIdsFor`.
 *
 * One reading, two callers: the QID feeds both the concordance and the media refs, and stage 2 merges
 * on the first of those. If one copy's validity rule loosened, the id array and the media array would
 * disagree about the same tag, and a wrong merge is a parking lot wearing a lighthouse's description.
 */
function qidOf(tags: Record<string, string>): string | undefined {
  const qid = tags["wikidata"]?.trim();
  // Validity judged by `upstream.ts`, the one owner of the form — the bare value is what a media ref
  // wants, so this returns that rather than the namespaced id.
  return qid && upstreamId("wd", qid) ? qid : undefined;
}

/** The `Category:…` this row names on Commons, or nothing — a `File:` value is a photo, not an id. */
function commonsCategoryOf(tags: Record<string, string>): string | undefined {
  const value = tags["wikimedia_commons"]?.trim();
  return value && isCommonsCategory(value) ? value : undefined;
}

/**
 * An OSM `;`-separated tag value, as its parts.
 *
 * Validity is `upstream.ts`'s business, not this function's — it returns the parts and lets the
 * namespace's own form reject what it doesn't recognize. Measured on the us-west extract,
 * `ref:nrhp` is a plain 8-digit reference 1,810 times out of 1,861 — and, more interestingly, **6
 * rows put a URL there instead**, Mukilteo Lighthouse (the worked example in
 * `apps/atlas/doc/spec/place-identity.md` §8) among them: its `ref:nrhp` is
 * `https://catalog.archives.gov/id/75613230`, while the actual register number `77001360` sits in
 * the generic `source_ref` tag.
 *
 * We deliberately do not chase that. `source_ref` names *a* source and says nothing about being an
 * NRHP reference, so reading one out of it would be inventing an identifier — and stage 2 merges on
 * these. A missing id costs one unmatched record; a wrong one corrupts a place.
 */
function splitList(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean);
}
