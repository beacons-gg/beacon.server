/**
 * Stage 3's rules — one entity's staged records become the one set of fields a volume publishes.
 *
 * **Pure.** No database, no clock, no I/O, so every priority and gap-fill decision is testable directly.
 * Stage 2 decided *which records are one place*; this decides *what that place says*, and the two are
 * separable because identity never depends on a field's value.
 *
 * The same shape as the server's `mergeFields` (`apps/server/src/places/merge.ts`) and deliberately not
 * an import of it: an app never imports an app, and more to the point the two rank different
 * vocabularies. The server ranks *who edited* — `admin > list: > contrib > osm`. Atlas ranks *which
 * corpus said it* — see {@link FIELD_PRIORITY}. What is carried over is the pair of rules that were bugs
 * there first, both preserved with their reasons.
 */
import type { SourceTerms } from "@beaconsgg/atlas-volume";
import { ODBL_URL, OSM_ATTRIBUTION, WIKIPEDIA_CREDIT } from "@beaconsgg/place-taxonomy";
import type { MediaCredit, PlaceCategory, PlaceSubcategory } from "@beaconsgg/protocol-types";

/**
 * One staged record as the merge reads it — the subset of `source_records` that contributes a field.
 *
 * Narrower than `StagedRow` on purpose: `mediaRefs`, `upstreamIds` and `raw` are stage 4's and stage 2's
 * business, and a merge that could see them could accidentally rank on them.
 */
export interface MergeInput {
  source: string;
  category: PlaceCategory;
  subcategory?: PlaceSubcategory;
  name?: string;
  altNames?: string[];
  description?: string;
  descriptionCredit?: MediaCredit;
  website?: string;
  wikipedia?: string;
  /** GeoJSON text, as PostGIS emitted it. Rounding to the published precision is stage 5's job. */
  point: string;
  geometry?: string;
}

/**
 * What one place carries after merging — `apps/atlas/doc/spec/volume-format.md` §4's record minus
 * the parts other stages own (`id`/`upstream`/`aliases` from stage 2, `media` from stage 4).
 */
export interface MergedPlace {
  category: PlaceCategory;
  subcategory?: PlaceSubcategory;
  name?: string;
  altNames?: string[];
  description?: string;
  descriptionCredit?: MediaCredit;
  website?: string;
  wikipedia?: string;
  point: string;
  geometry?: string;
  /** Every source that won at least one field — what makes per-place attribution derivable (§7). */
  sources: string[];
}

/** The fields the merge ranks. Keyed off {@link MergedPlace} so the two cannot drift apart. */
type MergedField = Exclude<keyof MergedPlace, "sources">;

/**
 * What lands in `merged_places.fields` — everything except the parts the row stores as columns.
 *
 * Named so it survives the round trip through `jsonb` as a *type*. Widening it to
 * `Record<string, unknown>` on the way out is what forced `volume.ts` to re-probe every field with
 * hand-written `typeof` guards that validated nothing and counted nothing.
 */
export type MergedFields = Omit<MergedPlace, "sources" | "point" | "geometry">;

/**
 * Fields that are not independent facts but **attributes of another field**, taken from whichever record
 * won the field they describe rather than ranked on their own.
 *
 * `descriptionCredit` is the case this exists for, and getting it wrong is a licensing bug rather than a
 * cosmetic one: ranking it separately would happily pair an NPS narrative (public domain) with
 * Wikipedia's CC BY-SA credit, attributing words to authors who did not write them. A credit belongs to
 * the text it credits, so it travels with it or not at all.
 */
const OWNED_BY = { descriptionCredit: "description" } as const satisfies Partial<
  Record<MergedField, MergedField>
>;

/** A field ranked on its own merit — everything {@link OWNED_BY} does not resolve. */
type IndependentField = Exclude<MergedField, keyof typeof OWNED_BY>;

/**
 * **The mapper knows best.** What a place is called locally, what kind of thing it is, and where
 * its boundary runs are all things an OSM contributor standing in front of it got right, and a
 * national dataset describing the same place generalizes (`apps/atlas/doc/spec/sources.md` §5: "OSM
 * wins outright").
 */
const MAPPER_FIRST = [
  "osm",
  // A contributor stood in front of the place too, and unlike a national dataset they were looking
  // at this one — but a mapper's name for it is the one the neighbourhood uses, and OSM's is
  // reviewed by everyone who passes. Second, not first. (In practice a contribution only reaches
  // these fields on a place nothing else knows: an improvement may not move, rename the kind of, or
  // reshape someone else's place at all, so it has no name/point/category to offer.)
  "contrib",
  "nps",
  "ridb",
  "nrhp",
  "wikipedia",
  "wikivoyage",
] as const satisfies readonly FieldSourceId[];

/**
 * **The owner describes best.** The Park Service on Olympic National Park beats Wikipedia on
 * Olympic National Park, and both beat a mapper's one-line `description=` —
 * `apps/atlas/doc/spec/sources.md` §5's first principle, and the one open disagreement it records
 * (whether a short specific mapper note really loses to a well-written NRHP narrative; probably
 * per-category, so this is the place that would learn to split).
 */
const OWNER_FIRST = [
  "nps",
  "ridb",
  // Above the mapper, below the owner. A reviewed human who walked to the place and wrote about it
  // beats a mapper's one-line `description=` tag, and loses to the Park Service describing its own
  // park. This is the ordering `apps/atlas/doc/spec/sources.md` §5 predicts would eventually want
  // splitting per category; it is one line, and this is the line.
  "contrib",
  "osm",
  "nrhp",
  "wikipedia",
  "wikivoyage",
] as const satisfies readonly FieldSourceId[];

/**
 * Which corpus wins which field, `apps/atlas/doc/spec/sources.md` §5 as a table.
 *
 * **Per field, not one global order** — that is the whole difference from the server's single
 * `SOURCE_PRIORITY`, and it is what §5 actually specifies. Exhaustive over {@link IndependentField}, so
 * adding a field to {@link MergedPlace} without deciding its ordering is a compile error rather than a
 * field that silently takes whichever record happened to sort first.
 *
 * Every list names **every** source, in order. A source absent from a list would contribute nothing to
 * that field even when it is the only source that has one, which is a gap-fill failure disguised as a
 * ranking.
 */
const FIELD_PRIORITY: Record<IndependentField, readonly string[]> = {
  category: MAPPER_FIRST,
  subcategory: MAPPER_FIRST,
  name: MAPPER_FIRST,
  altNames: MAPPER_FIRST,
  point: MAPPER_FIRST,
  geometry: MAPPER_FIRST,
  website: MAPPER_FIRST,
  wikipedia: MAPPER_FIRST,
  description: OWNER_FIRST,
};

/** The independent fields, derived so a new entry in {@link FIELD_PRIORITY} is picked up for free. */
const INDEPENDENT_FIELDS = Object.keys(FIELD_PRIORITY) as IndependentField[];

/** US federal works. Named so "no licence url" reads as a fact rather than a missing field. */
const PUBLIC_DOMAIN = "Public domain";

/**
 * What a volume must say about a corpus for a consumer to redistribute its data lawfully —
 * `apps/atlas/doc/spec/volume-format.md` §7's `dict.sources` entry.
 *
 * Here rather than in `volume.ts` so **a new source is declared in exactly one file**: its rank
 * above and its terms below. Splitting them is how a corpus ends up ranked, merged, published, and
 * credited to nobody — and an unattributed CC BY-SA field is the one publishing mistake that cannot
 * be fixed after the fact, because a volume's bytes never change
 * (`apps/atlas/doc/spec/volume-format.md` §10).
 *
 * That promise is kept by a type, not by discipline: {@link SourceId} is derived from these keys and the
 * priority orders above `satisfies readonly SourceId[]`, so **ranking a source with no declared terms is a
 * compile error**. It had to be — the first cut ranked six sources and declared two, which meant the day
 * NPS landed in staging `publish` would have thrown at place 40,000 with 30,000 tiles already written, and
 * the test guarding it iterated the declarations so it could never have failed.
 *
 * The credit strings themselves come from `@beaconsgg/place-taxonomy`, which is where the server keeps them
 * too: an attribution fact with two copies is one stale copy away from crediting the wrong licence.
 */
const FIELD_SOURCE_TERMS = {
  osm: {
    name: "OpenStreetMap",
    attribution: OSM_ATTRIBUTION,
    license: "ODbL 1.0",
    licenseUrl: ODBL_URL,
  },
  /**
   * Player contributions exported from a Beacon server (`apps/atlas/doc/spec/beacon-integration.md`
   * §9).
   *
   * **The one source that is in this half and supplies media too** — a contribution brings words
   * and photos in the same submission, so splitting it across the two tables would be declaring one
   * corpus twice. It lives here because that is the half that decides which source wins a *field*,
   * and media publishability keys off {@link SOURCE_TERMS} either way.
   *
   * Terms follow the Commons precedent, for the same reason: not a corpus with terms but a stream
   * of individually-granted items (CC0 or CC BY 4.0, chosen per submission). Claiming one licence
   * for all of them would be a fabrication in bytes that never change.
   */
  contrib: {
    name: "Beacon contributions",
    // Named for the shape of the thing rather than for any one server: a volume may carry
    // contributions from several, and every field states its own per-item credit anyway.
    attribution: "Contributed by players on Beacon servers — see each field's credit",
    // Both, spelled out, rather than "various, per submission — see each field's credit": a
    // description and a photo carry their own exact terms, but a contributed *name* or *website*
    // has no credit slot to carry one, so pointing a redistributor at a per-field credit those
    // fields do not have would leave them with nothing to act on. Naming the two possibilities
    // does: the strictest is CC BY 4.0, and attributing accordingly is always sufficient.
    license: "CC0 1.0 or CC BY 4.0, per submission",
  },
  wikipedia: {
    name: "English Wikipedia",
    attribution: WIKIPEDIA_CREDIT.author,
    license: WIKIPEDIA_CREDIT.license,
    licenseUrl: WIKIPEDIA_CREDIT.licenseUrl,
  },
  wikivoyage: {
    name: "Wikivoyage",
    attribution: "Wikivoyage contributors",
    license: WIKIPEDIA_CREDIT.license,
    licenseUrl: WIKIPEDIA_CREDIT.licenseUrl,
  },
  // US federal works: public domain, with **no attribution obligation**
  // (`apps/atlas/doc/spec/sources.md` §2). The credit line is courtesy rather than a licence term,
  // and `licenseUrl` is absent because there is no licence to link — which is the whole reason
  // these rank above an encyclopedia in `apps/atlas/doc/spec/sources.md` §5.
  nps: {
    name: "US National Park Service",
    attribution: "Courtesy of the National Park Service",
    license: PUBLIC_DOMAIN,
  },
  ridb: {
    name: "Recreation.gov (RIDB)",
    attribution: "Courtesy of Recreation.gov",
    license: PUBLIC_DOMAIN,
  },
  nrhp: {
    name: "National Register of Historic Places",
    attribution: "Courtesy of the National Register of Historic Places",
    license: PUBLIC_DOMAIN,
  },
} as const satisfies Record<string, SourceTerms>;

/**
 * Corpora that supply **photos and no fields**, declared separately from the field sources above.
 *
 * Split for a reason that would otherwise bite silently. `dict.sources` has to declare terms for everything
 * a volume publishes, media included — but the priority orders `satisfies readonly SourceId[]`, and
 * `satisfies` checks that every listed member is valid, **not** that every valid member is listed. So folding
 * a media-only source into one flat table would widen the ranking vocabulary, compile cleanly, and quietly
 * break the invariant three docblocks up ("Every list names every source, in order") — leaving a source that
 * could rank a field it has none of. `fields.test.ts` checks each order is a permutation of the field
 * sources, which is the half `satisfies` cannot express.
 *
 * A media source does **not** join a place's `sources` array:
 * `apps/atlas/doc/spec/volume-format.md` §4 defines that as the sources that contributed a *field*,
 * and the attribution a photo actually needs rides in its own `Media.credit`, per file, because
 * Commons licences are per file rather than per corpus.
 */
const MEDIA_SOURCE_TERMS = {
  commons: {
    name: "Wikimedia Commons",
    // Deliberately not a licence name. Commons is a repository, not a corpus with terms: each file
    // carries its own, which is exactly why `apps/atlas/doc/spec/sources.md` §3 admits it at all
    // ("verifiable per file"). Claiming a single licence here would be a fabrication in immutable
    // bytes.
    attribution: "Wikimedia Commons contributors — see each photo's credit",
    license: "Various, per file — stated in each photo's credit",
  },
  // One licence for the whole corpus, unlike Commons: KartaView's own terms grant CC BY-SA 4.0
  // across the imagery (verified 2026-08-07 — the platform states it, not us). The API exposes no
  // per-photo author name, so attribution is to the contributors collectively, with each published
  // photo's credit linking its own KartaView page — where the uploader is shown.
  // `apps/atlas/doc/spec/sources.md` §3.
  kartaview: {
    name: "KartaView",
    attribution: "KartaView contributors",
    license: "CC BY-SA 4.0",
    licenseUrl: "https://creativecommons.org/licenses/by-sa/4.0/",
  },
} as const satisfies Record<string, SourceTerms>;

/**
 * Every corpus a volume may declare — field sources and media sources together, which is what
 * `dict.sources` publishes.
 */
export const SOURCE_TERMS = { ...FIELD_SOURCE_TERMS, ...MEDIA_SOURCE_TERMS } as const;

/** A source that {@link SOURCE_TERMS} declares terms for — the only kind that may be published at all. */
export type SourceId = keyof typeof SOURCE_TERMS;

/** A source that may **win a field**. Narrower than {@link SourceId}: media sources describe no place. */
export type FieldSourceId = keyof typeof FIELD_SOURCE_TERMS;

/** The field sources, for the permutation check `satisfies` cannot make. */
export const FIELD_SOURCES = Object.keys(FIELD_SOURCE_TERMS) as FieldSourceId[];

/** The priority orders, exposed so the same check can read them. */
export const FIELD_ORDERS = { MAPPER_FIRST, OWNER_FIRST } as const;

/**
 * One corpus's redistribution terms — **the format's own type**, imported rather than restated.
 *
 * It used to be declared here as well, and `volume.ts` read this table through a cast, so nothing checked
 * that the two declarations still matched: a field added here would publish into `dict.sources` with no
 * compile error on the consumer side. This is the one table where a fabrication becomes an immutable
 * published claim.
 */
export type { SourceTerms };

/**
 * A source's rank for one field — lower wins; an unknown source ranks **after** every known one.
 *
 * Unknown-ranks-last rather than unknown-is-rejected: a source added to staging before this table knows
 * about it should still fill an empty field, which is strictly better than the place having none. It just
 * never outranks a corpus we have actually reasoned about.
 */
export function sourceRank(field: IndependentField, source: string): number {
  const order = FIELD_PRIORITY[field];
  const rank = order.indexOf(source);
  return rank === -1 ? order.length : rank;
}

/**
 * Merge one entity's staged records into the fields a volume publishes.
 *
 * Returns `undefined` when the result would not be a servable place — no `category` or no `point`. That
 * mirrors the server's own `canonicalPlace` gate rather than publishing a record every consumer would
 * reject, and the caller counts it. In practice both columns are `NOT NULL` in staging, so this fires
 * only for an entity whose members have all vanished.
 *
 * **Gap-fill, never overwrite.** A lower-priority source fills a field the winner left empty; it cannot
 * replace one the winner filled. That is what makes adding a source monotonic — a new corpus can only
 * ever add detail to a place, never quietly restate it.
 */
export function mergePlace(records: readonly MergeInput[]): MergedPlace | undefined {
  if (records.length === 0) return undefined;

  const merged: Record<string, unknown> = {};
  // Which record won each field, kept so OWNED_BY can follow its owner to the same source.
  const winner = new Map<IndependentField, MergeInput>();

  for (const field of INDEPENDENT_FIELDS) {
    // Sorted per field, because the ordering is per field. `sort` is stable in every runtime we target,
    // so records of equally-ranked sources keep the caller's order — which the caller makes
    // deterministic with an ORDER BY, so the merge is reproducible.
    const ranked = [...records].sort(
      (a, b) => sourceRank(field, a.source) - sourceRank(field, b.source),
    );
    for (const record of ranked) {
      const value = record[field];
      // `null` counts as absent, not as a value. Every column this reads is `NOT NULL` in staging, so
      // this cannot fire today — but the gate below decides whether a place is publishable, and a gate
      // that accepts `null` as "present" reports a servable place and then fails somewhere less obvious.
      if (value !== undefined && value !== null) {
        merged[field] = value;
        winner.set(field, record);
        break;
      }
    }
  }

  for (const [field, owner] of Object.entries(OWNED_BY) as [
    keyof typeof OWNED_BY,
    IndependentField,
  ][]) {
    const value = winner.get(owner)?.[field];
    if (value !== undefined) merged[field] = value;
  }

  if (merged["category"] === undefined || merged["point"] === undefined) return undefined;

  // Only the sources that actually won something. A record whose every field lost contributed nothing,
  // and listing it would attach an attribution obligation to a place it did not describe.
  const sources = [...new Set([...winner.values()].map((r) => r.source))].sort();
  return { ...(merged as Omit<MergedPlace, "sources">), sources };
}
