import { canonicalJson, type PlaceEditableField } from "@beaconsgg/protocol-types";
import type { PlaceFields, PlaceSourceRecord } from "../stores/place-store";

/**
 * The field-priority merge — the pure heart of places-v2 curation (`doc/spec/places.md` §3.1).
 * Source records contribute partial {@link PlaceFields}; the canonical place takes, **per field**,
 * the value from the highest-priority live source that has it. `admin` always wins, so a manual
 * edit freezes exactly the fields it touched; everything else keeps flowing from connectors.
 *
 * Conflicts are the approval queue: a non-admin source bringing a *different* value for an
 * admin-held field is never applied — the collision is surfaced as a {@link FieldConflict} for
 * later review. Lower-priority collisions (e.g. `list` vs `osm`) resolve silently by priority —
 * only manual work is protected by approval.
 */

/** The admin source id — a place's manual-edit record (sourceId = the place unique). */
export const ADMIN_SOURCE = "admin";

/**
 * The community source id — a place's **approved player contributions**, merged into one record per
 * place (sourceId = the place unique, the {@link ADMIN_SOURCE} shape). Named `contrib`, not
 * `community`, because `community` is already a `PlaceCategory` — a `source` and a `category`
 * sharing a name makes provenance ambiguous in code and in the operator console.
 */
export const CONTRIB_SOURCE = "contrib";

/**
 * Source-name prefixes in priority order (first wins; `list:<name>` matches by prefix) — exactly
 * the three place inputs plus the operator's bulk mechanism
 * (`apps/atlas/doc/spec/beacon-integration.md` §6): an operator's manual edit wins; an operator's
 * curated `list:` import wins; **a player's approved contribution beats the bulk dataset**; the
 * Atlas volume is the floor. Prefix-matched, so every per-volume id — `atlas:us-west`,
 * `atlas:pacific-northwest` — lands at the one `atlas:` rank. In the common case there is no
 * contest at all, because the merge is per-field: a player description on a place the volume never
 * described simply fills a hole.
 *
 * **`osm` is unlisted deliberately.** The server's own OSM connectors are deleted, but a server
 * that ran them still holds live `osm` records, and those must keep contributing (they carry
 * geometry, which volumes don't ship yet) — just below every living input, which is precisely what
 * the unknown-source rule already does. They stay until the operator runs `places.source.retire`
 * (the migration path — see `snapshot.service.ts`). No tie lurks in that rank: `osm` is the only
 * source a server can hold that nothing here matches, because nothing can create records under any
 * other unlisted name any more.
 *
 * **Adding a source here is not optional.** `sourceRank` returns `SOURCE_PRIORITY.length` for anything
 * unlisted, so an absent `atlas:` would (a) rank below the legacy `osm` residue, letting a stale
 * connector value win every contested field, and (b) make two volumes *tie* — at which point
 * `mergeFields`' stable sort silently lets whichever record the store returned first win, which is the
 * same silent bug `canonical.ts`'s `splitSelfSource` documents. Neither is visible on a fresh
 * single-volume server, so it would ship.
 */
const SOURCE_PRIORITY = ["admin", "list:", CONTRIB_SOURCE, "atlas:"] as const;

/**
 * Sources whose presence keeps a place alive when nothing else can be merged into one — the
 * *second* source policy, independent of rank, and named here so adding a source forces the
 * retirement decision at the same site as the priority decision.
 *
 * Only `admin` qualifies: an operator who curated a place meant it to exist. `contrib` deliberately
 * does **not** — an approved contribution is a fact about a place, not a commitment to keep it once
 * every other source has dropped it.
 */
const RETIRE_PROTECTED = [ADMIN_SOURCE];

/** Whether a live record of this source protects its place from auto-retirement ({@link RETIRE_PROTECTED}). */
export function protectedFromAutoRetire(source: string): boolean {
  return RETIRE_PROTECTED.includes(source);
}

/** The merge priority of a source name (lower wins; unknown sources rank after all known ones). */
export function sourceRank(source: string): number {
  const rank = SOURCE_PRIORITY.findIndex((prefix) => source.startsWith(prefix));
  return rank === -1 ? SOURCE_PRIORITY.length : rank;
}

/**
 * Whether `source` is one of the living place inputs ({@link SOURCE_PRIORITY}) — the guard
 * `places.source.retire` refuses on, defined here so the refusal can never drift from the ranking:
 * a source this file ranks is one whose records arrive and retire through their own lifecycle.
 */
export function isInputSource(source: string): boolean {
  return sourceRank(source) !== SOURCE_PRIORITY.length;
}

/**
 * The mergeable canonical field keys, compile-pinned in **both** directions: the intersection type
 * fails on a `PlaceFields` key missing here (merge/conflicts could silently skip it) AND on a
 * wire-enum entry missing here (the field would be uneditable) — one vocabulary, three views.
 */
const MERGEABLE_FIELD_SET: Record<keyof PlaceFields, true> & Record<PlaceEditableField, true> = {
  category: true,
  subcategory: true,
  name: true,
  description: true,
  descriptionCredit: true,
  website: true,
  wikipedia: true,
  altNames: true,
  point: true,
  geometry: true,
  media: true,
};
export const MERGEABLE_FIELDS = Object.keys(MERGEABLE_FIELD_SET) as MergeableField[];
export type MergeableField = keyof PlaceFields;

/** Deep value equality via canonical JSON (key-order insensitive — JCS, same as signing). */
function sameValue(a: unknown, b: unknown): boolean {
  return canonicalJson(a) === canonicalJson(b);
}

/**
 * Fields that are not independent facts but **attributes of another field**, and so must come from
 * the same source record as the field they describe — never merged on their own rank.
 *
 * `descriptionCredit` is the case this exists for, and getting it wrong is a licensing bug rather
 * than a cosmetic one. Per-field merge would happily take the description from `admin` (an operator
 * rewrote it) and the credit from `osm` (a Wikipedia summary), producing an operator's own words
 * labelled CC BY-SA and attributed to an author who didn't write them. A credit belongs to the text
 * it credits, so it travels with it or not at all.
 */
const OWNED_BY: Partial<Record<MergeableField, MergeableField>> = {
  descriptionCredit: "description",
};

/**
 * Merge the live source records' fields by priority: per field, the highest-priority live source
 * that carries it wins. `gone` sources contribute nothing. Fields listed in {@link OWNED_BY} are the
 * exception — they are taken from whichever record won their owning field, so an attribute can never
 * be paired with a value from a different source.
 */
export function mergeFields(sources: readonly PlaceSourceRecord[]): PlaceFields {
  const live = sources
    .filter((s) => s.goneAt === undefined)
    .sort((a, b) => sourceRank(a.source) - sourceRank(b.source));
  const merged: Record<string, unknown> = {};
  const winner = new Map<MergeableField, PlaceSourceRecord>();

  for (const field of MERGEABLE_FIELDS) {
    if (OWNED_BY[field] !== undefined) continue; // resolved below, from its owner's winner
    for (const source of live) {
      const value = source.fields[field];
      if (value !== undefined) {
        merged[field] = value;
        winner.set(field, source);
        break;
      }
    }
  }

  for (const field of MERGEABLE_FIELDS) {
    const owner = OWNED_BY[field];
    if (owner === undefined) continue;
    const value = winner.get(owner)?.fields[field];
    if (value !== undefined) merged[field] = value;
  }
  return merged as PlaceFields;
}

/** One admin-held field an incoming (non-admin) value collided on. */
export interface FieldConflict {
  field: MergeableField;
  currentValue: unknown; // the admin-held value
  incomingValue: unknown; // what the connector brought
}

/**
 * The conflicts an incoming source record raises against the place's admin-held fields: for every
 * field the `admin` source holds, a *different* incoming value is a conflict (never applied — the
 * merge keeps the admin value; the conflict row is the review queue). An admin incoming record, an
 * identical value, or a field the admin doesn't hold raises nothing.
 *
 * {@link OWNED_BY} fields raise nothing **of their own**: a credit isn't independently reviewable, so
 * a differing one would only add a second row beside its description's — asking an operator to
 * adjudicate an attribute of a decision they're already being asked to make.
 */
export function adminConflicts(
  incoming: Pick<PlaceSourceRecord, "source" | "fields">,
  sources: readonly PlaceSourceRecord[],
): FieldConflict[] {
  if (incoming.source === ADMIN_SOURCE) return [];
  const admin = sources.find((s) => s.source === ADMIN_SOURCE && s.goneAt === undefined);
  if (!admin) return [];
  const conflicts: FieldConflict[] = [];
  for (const field of MERGEABLE_FIELDS) {
    if (OWNED_BY[field] !== undefined) continue;
    const held = admin.fields[field];
    const brought = incoming.fields[field];
    if (held === undefined || brought === undefined) continue;
    if (!sameValue(held, brought)) {
      conflicts.push({ field, currentValue: held, incomingValue: brought });
    }
  }
  return conflicts;
}
