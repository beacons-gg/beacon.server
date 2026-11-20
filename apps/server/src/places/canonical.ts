import { coveringCells, encode, geometryBBox } from "@beaconsgg/geo";
import type {
  PlaceFields,
  PlaceRecord,
  PlaceSourceRecord,
  PlaceStore,
} from "../stores/place-store";
import { mergeFields, protectedFromAutoRetire } from "./merge";

/**
 * The canonical-row assembly shared by every write path (snapshot upserts, retirement re-merges,
 * admin edits): a merge result becomes a servable place, or `undefined` when it lacks the two
 * load-bearing fields. `createdAt` is always "now" — the store's write-once contract preserves the
 * original on upsert (`doc/spec/places.md` §3).
 */
export function canonicalPlace(
  unique: string,
  merged: PlaceFields,
  at: string,
): PlaceRecord | undefined {
  if (!merged.category || !merged.point) return undefined;
  return {
    unique,
    category: merged.category,
    ...(merged.subcategory !== undefined ? { subcategory: merged.subcategory } : {}),
    ...(merged.name !== undefined ? { name: merged.name } : {}),
    ...(merged.description !== undefined ? { description: merged.description } : {}),
    ...(merged.descriptionCredit !== undefined
      ? { descriptionCredit: merged.descriptionCredit }
      : {}),
    ...(merged.website !== undefined ? { website: merged.website } : {}),
    ...(merged.wikipedia !== undefined ? { wikipedia: merged.wikipedia } : {}),
    ...(merged.altNames !== undefined ? { altNames: merged.altNames } : {}),
    point: merged.point,
    ...(merged.geometry !== undefined ? { geometry: merged.geometry } : {}),
    ...(merged.media !== undefined ? { media: merged.media } : {}),
    status: "active",
    createdAt: at,
    updatedAt: at,
  };
}

/** A place's cell index: the point's cell, plus the polygon's cover when it has an area. */
export function cellsForPlace(place: PlaceRecord, cellPrecision: number): string[] {
  const cells = new Set<string>([encode(place.point, cellPrecision)]);
  if (place.geometry) {
    for (const cell of coveringCells(geometryBBox(place.geometry), cellPrecision)) {
      cells.add(cell);
    }
  }
  return [...cells];
}

/**
 * An arbitrary field bag as {@link PlaceFields}, dropping explicit `undefined`s. Every curated write
 * needs this: zod's optional shape permits an explicit `undefined`, `exactOptionalPropertyTypes`
 * forbids assigning one to an optional field, and semantically an `undefined` override would be a
 * value the merge has to reason about rather than an absent one.
 */
export function definedFields(source: Record<string, unknown>): PlaceFields {
  const fields: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined) fields[key] = value;
  }
  return fields as PlaceFields;
}

/**
 * A place's source records split into **the one this curator owns** and everything else. Curated
 * sources (`admin`, `contrib`) key their record on the place unique, one per place, so a writer
 * folds into its own record and merges against the rest.
 *
 * The split is a named operation because getting it wrong is silent: hand {@link commitCuratedRecord}
 * an `others` list that still contains the writer's own record and the merge sees two records at
 * equal rank, where a stable sort quietly lets the *older* one win every field it holds — an update
 * that appears to succeed and changes nothing.
 */
export async function splitSelfSource(
  store: PlaceStore,
  source: string,
  placeUnique: string,
): Promise<{ self: PlaceSourceRecord | undefined; others: PlaceSourceRecord[] }> {
  const sources = await store.sourcesForPlace(placeUnique);
  return {
    self: sources.find((s) => s.source === source && s.goneAt === undefined),
    // mergeFields owns the live-filter, so `others` deliberately keeps gone records too.
    others: sources.filter((s) => s.source !== source),
  };
}

/** One curated write: which source, which place, the record's full field set, and its siblings. */
export interface CuratedWrite {
  /** `admin` (operator edits) or `contrib` (approved contributions) — the merge rank differs. */
  source: string;
  unique: string;
  /** The record's complete fields, not a patch — the caller folds its own prior values in first. */
  fields: PlaceFields;
  /** Every source record that is NOT this one ({@link splitSelfSource}). */
  others: readonly PlaceSourceRecord[];
  /** The DID being credited with the write (`editedBy` on the record). */
  actor: string;
  nowIso: string;
  /** Keeps an existing canonical row when the merge isn't servable; absent ⇒ return `undefined`. */
  fallback?: PlaceRecord;
}

/**
 * The one write path for a curated source record: build it, recompute the canonical row from it
 * plus the place's other live sources, and commit both with a fresh cell index. Shared by the
 * operator's create/edit and the contribution-approval path (`doc/spec/place-proposals.md` §6) —
 * the flows differ only in which source name they write under and what the merge then ranks it
 * against.
 */
export async function commitCuratedRecord(
  store: PlaceStore,
  cellPrecision: number,
  write: CuratedWrite,
): Promise<PlaceRecord | undefined> {
  const record: PlaceSourceRecord = {
    source: write.source,
    sourceId: write.unique,
    placeUnique: write.unique,
    fields: write.fields,
    editedBy: write.actor,
    editedAt: write.nowIso,
    syncedAt: write.nowIso,
    // goneAt unset — a re-write revives a previously cleared record
  };
  const merged = canonicalPlace(write.unique, mergeFields([...write.others, record]), write.nowIso);
  const next = merged ?? write.fallback;
  if (!next) return undefined;
  await store.commitPlace(next, record, cellsForPlace(next, cellPrecision), []);
  return next;
}

/**
 * The shared "a source went gone" tail (`doc/spec/places.md` §3.3): re-merge the survivors and
 * update the canonical row, retire it (no live sources, or unservable without admin protection), or
 * keep it as-is (admin-touched but unservable). Used by the snapshot retirement sweep and the admin
 * clear-override path — one copy of the retire-vs-remerge rule.
 */
export async function remergeOrRetire(
  store: PlaceStore,
  placeUnique: string,
  nowIso: string,
  cellPrecision: number,
): Promise<void> {
  const remaining = (await store.sourcesForPlace(placeUnique)).filter(
    (s) => s.goneAt === undefined,
  );
  if (remaining.length === 0) {
    // No live sources at all — an admin record would still be live, so this is admin-free.
    await store.retirePlace(placeUnique, nowIso);
    return;
  }
  const merged = canonicalPlace(placeUnique, mergeFields(remaining), nowIso);
  if (!merged) {
    // What's left doesn't amount to a servable place. A place held by a retire-protected source
    // never auto-retires (its canonical row just stays as last merged); anything else retires.
    // Which sources protect is `merge.ts`'s call — it owns the source vocabulary.
    if (!remaining.some((s) => protectedFromAutoRetire(s.source))) {
      await store.retirePlace(placeUnique, nowIso);
    }
    return;
  }
  await store.updatePlace(merged, cellsForPlace(merged, cellPrecision));
}
