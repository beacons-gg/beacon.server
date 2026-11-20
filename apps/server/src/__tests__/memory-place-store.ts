import { createHash } from "node:crypto";
import type { PlaceCategory } from "@beaconsgg/protocol-types";
import {
  type AtlasPinRecord,
  type ApprovedContribution,
  type CreditedContribution,
  type PlaceCommitEntry,
  type PlaceConflictRecord,
  type PlaceProposalFilter,
  type PlaceProposalRecord,
  type PlaceProposalReview,
  type PlaceQueryResult,
  type PlaceRecord,
  type PlaceSnapshotRecord,
  type PlaceSourceRecord,
  type PlaceStats,
  type PlaceStore,
  type SourceIdOwner,
  spreadLength,
  validCellPrefixes,
} from "../stores/place-store";
import { byteCompare as cmp } from "../common/byte-order";

/**
 * In-memory {@link PlaceStore}: the places suites' fake, held to the place-store parity suite.
 * Structural-clone on write/read keeps callers from
 * mutating stored records (mirrors what the Postgres store gets from JSON round-tripping).
 */
export class MemoryPlaceStore implements PlaceStore {
  private readonly places = new Map<string, PlaceRecord>();
  private readonly sources = new Map<string, PlaceSourceRecord>(); // `${source}\n${sourceId}`
  private readonly cells = new Map<string, string[]>(); // placeUnique -> cells
  private readonly snapshots = new Map<string, PlaceSnapshotRecord>();
  private readonly conflicts: PlaceConflictRecord[] = [];
  private readonly proposals = new Map<string, PlaceProposalRecord>();

  private static sourceKey(source: string, sourceId: string): string {
    return `${source}\n${sourceId}`;
  }

  /** Upsert the canonical row (createdAt is write-once — parity with the Postgres store) + cells. */
  private writePlace(place: PlaceRecord, cells: string[]): void {
    const prior = this.places.get(place.unique);
    this.places.set(
      place.unique,
      structuredClone(prior ? { ...place, createdAt: prior.createdAt } : place),
    );
    this.cells.set(place.unique, [...new Set(cells)]);
  }

  commitPlace(
    place: PlaceRecord,
    source: PlaceSourceRecord,
    cells: string[],
    conflicts: PlaceConflictRecord[],
  ): Promise<void> {
    return this.commitPlaces([{ place, sources: [source], cells, conflicts }]);
  }

  commitPlaces(entries: readonly PlaceCommitEntry[]): Promise<void> {
    for (const e of entries) {
      this.writePlace(e.place, e.cells);
      for (const s of e.sources) {
        this.sources.set(MemoryPlaceStore.sourceKey(s.source, s.sourceId), structuredClone(s));
      }
      for (const c of e.conflicts) this.conflicts.push(structuredClone(c));
    }
    return Promise.resolve();
  }

  updatePlace(place: PlaceRecord, cells: string[]): Promise<void> {
    // The batched commit with nothing but the canonical row — `sources: []` writes none.
    return this.commitPlaces([{ place, sources: [], cells, conflicts: [] }]);
  }

  retirePlace(unique: string, at: string): Promise<void> {
    const place = this.places.get(unique);
    if (place) {
      this.places.set(unique, { ...place, status: "retired", updatedAt: at });
      this.cells.set(unique, []);
    }
    return Promise.resolve();
  }

  getPlace(unique: string): Promise<PlaceRecord | undefined> {
    const place = this.places.get(unique);
    return Promise.resolve(place ? structuredClone(place) : undefined);
  }

  async getSource(source: string, sourceId: string): Promise<PlaceSourceRecord | undefined> {
    return (await this.getSources(source, [sourceId]))[0];
  }

  getSources(source: string, sourceIds: readonly string[]): Promise<PlaceSourceRecord[]> {
    const out: PlaceSourceRecord[] = [];
    for (const id of sourceIds) {
      const rec = this.sources.get(MemoryPlaceStore.sourceKey(source, id));
      if (rec) out.push(structuredClone(rec));
    }
    return Promise.resolve(out);
  }

  /**
   * Each id's owning place — see the interface for why this exists. Live only, and each winner
   * deterministically ordered so two runs over the same data agree.
   */
  placeUniquesForSourceIds(sourceIds: readonly string[]): Promise<SourceIdOwner[]> {
    const wanted = new Set(sourceIds);
    const best = new Map<string, PlaceSourceRecord>();
    for (const s of this.sources.values()) {
      if (s.goneAt !== undefined || !wanted.has(s.sourceId)) continue;
      const cur = best.get(s.sourceId);
      // Byte order, as every comparison in this file (./byte-order). `localeCompare` is ICU, which
      // can order names containing `:` differently and would let the parity suite pass while the
      // twins disagreed, on the one method whose contract is determinism.
      if (!cur || cmp(s.source, cur.source) < 0) best.set(s.sourceId, s);
    }
    return Promise.resolve(
      [...best.values()].map((s) => ({
        sourceId: s.sourceId,
        placeUnique: s.placeUnique,
        source: s.source,
      })),
    );
  }

  sourcesForPlace(placeUnique: string): Promise<PlaceSourceRecord[]> {
    return Promise.resolve(
      [...this.sources.values()]
        .filter((s) => s.placeUnique === placeUnique)
        .map((s) => structuredClone(s)),
    );
  }

  sourcesForPlaces(placeUniques: readonly string[]): Promise<PlaceSourceRecord[]> {
    const wanted = new Set(placeUniques);
    return Promise.resolve(
      [...this.sources.values()]
        .filter((s) => wanted.has(s.placeUnique))
        .map((s) => {
          // Parity with the Postgres store's slim column list: the batched read never sees `raw`.
          const clone = structuredClone(s);
          delete clone.raw;
          return clone;
        }),
    );
  }

  liveSourceKeysBySource(
    source: string,
  ): Promise<Array<Pick<PlaceSourceRecord, "sourceId" | "placeUnique">>> {
    // Keys only — parity with the Postgres store's two-column projection.
    return Promise.resolve(
      [...this.sources.values()]
        .filter((s) => s.source === source && s.goneAt === undefined)
        .map((s) => ({ sourceId: s.sourceId, placeUnique: s.placeUnique })),
    );
  }

  liveSourcesBySource(
    source: string,
    cellPrefixes?: readonly string[],
  ): Promise<PlaceSourceRecord[]> {
    const prefixes = cellPrefixes === undefined ? undefined : validCellPrefixes(cellPrefixes);
    const inScope = (placeUnique: string): boolean => {
      if (prefixes === undefined) return true;
      const placeCells = this.cells.get(placeUnique) ?? [];
      return prefixes.some((p) => placeCells.some((c) => c.startsWith(p)));
    };
    return Promise.resolve(
      [...this.sources.values()]
        .filter((s) => s.source === source && s.goneAt === undefined && inScope(s.placeUnique))
        .map((s) => {
          // Parity with the Postgres store's slim column list: the sweep never sees `raw`.
          const clone = structuredClone(s);
          delete clone.raw;
          return clone;
        }),
    );
  }

  attributionsForPlaces(placeUniques: readonly string[]): Promise<string[]> {
    const uniques = new Set(placeUniques);
    const out = new Set<string>();
    for (const s of this.sources.values()) {
      if (s.goneAt === undefined && s.attribution !== undefined && uniques.has(s.placeUnique)) {
        out.add(s.attribution);
      }
    }
    return Promise.resolve([...out].sort(cmp));
  }

  setSourceGone(source: string, sourceId: string, at: string): Promise<void> {
    const key = MemoryPlaceStore.sourceKey(source, sourceId);
    const rec = this.sources.get(key);
    if (rec) this.sources.set(key, { ...rec, goneAt: at });
    return Promise.resolve();
  }

  queryByCells(
    cellPrefixes: string[],
    categories: PlaceCategory[] | undefined,
    limit: number,
    after?: string,
    spread?: boolean,
  ): Promise<PlaceQueryResult> {
    const prefixes = validCellPrefixes(cellPrefixes);
    const cursor = spread ? undefined : after; // a spread page never pages
    let matched: PlaceRecord[] = [];
    for (const place of this.places.values()) {
      if (place.status !== "active") continue;
      if (categories && categories.length > 0 && !categories.includes(place.category)) continue;
      if (cursor !== undefined && cmp(place.unique, cursor) <= 0) continue; // keyset: past this page only
      const placeCells = this.cells.get(place.unique) ?? [];
      if (!prefixes.some((p) => placeCells.some((c) => c.startsWith(p)))) continue;
      matched.push(place);
    }
    if (spread && prefixes.length > 0) {
      // Parity with the Postgres store: rank within each sub-cell (a place's first matching cell,
      // cut to the spread length) in md5(unique) order, then take every sub-cell's rank 1, rank 2.
      // The sort is stable, so places of one rank stay in md5 order.
      const length = spreadLength(prefixes, limit);
      const mixed = matched
        .map((place) => ({ place, mix: createHash("md5").update(place.unique).digest("hex") }))
        .sort((a, b) => cmp(a.mix, b.mix));
      const perSub = new Map<string, number>();
      const ranked = mixed.map(({ place }) => {
        const cell = (this.cells.get(place.unique) ?? [])
          .filter((c) => prefixes.some((p) => c.startsWith(p)))
          .sort(cmp)[0]!;
        const sub = cell.slice(0, length);
        const rank = (perSub.get(sub) ?? 0) + 1;
        perSub.set(sub, rank);
        return { place, rank };
      });
      matched = ranked.sort((a, b) => a.rank - b.rank).map((r) => r.place);
    } else {
      matched.sort((a, b) => cmp(a.unique, b.unique));
    }
    return Promise.resolve({
      // The summary projection (parity with the Postgres store): geometry never rides the list path.
      places: matched.slice(0, limit).map((p) => {
        const { geometry, description, descriptionCredit: _credit, ...rest } = p;
        return structuredClone({
          ...rest,
          hasGeometry: geometry !== undefined,
          hasDescription: description !== undefined,
        });
      }),
      truncated: matched.length > limit,
    });
  }

  createSnapshot(snapshot: PlaceSnapshotRecord): Promise<void> {
    this.snapshots.set(snapshot.id, structuredClone(snapshot));
    return Promise.resolve();
  }

  updateSnapshot(
    id: string,
    patch: Partial<
      Pick<PlaceSnapshotRecord, "status" | "stats" | "error" | "startedAt" | "finishedAt">
    >,
  ): Promise<void> {
    const snap = this.snapshots.get(id);
    if (snap) this.snapshots.set(id, { ...snap, ...structuredClone(patch) });
    return Promise.resolve();
  }

  getSnapshot(id: string): Promise<PlaceSnapshotRecord | undefined> {
    const snap = this.snapshots.get(id);
    return Promise.resolve(snap ? structuredClone(snap) : undefined);
  }

  listSnapshots(limit: number): Promise<PlaceSnapshotRecord[]> {
    return Promise.resolve(
      [...this.snapshots.values()]
        .sort((a, b) => cmp(b.id, a.id))
        .slice(0, limit)
        .map((s) => structuredClone(s)),
    );
  }

  failSnapshots(error: string, at: string, id?: string): Promise<number> {
    let flipped = 0;
    for (const [snapId, snap] of this.snapshots) {
      if (id !== undefined && snapId !== id) continue;
      if (snap.status === "queued" || snap.status === "running") {
        this.snapshots.set(snapId, { ...snap, status: "failed", error, finishedAt: at });
        flipped += 1;
      }
    }
    return Promise.resolve(flipped);
  }

  private readonly atlasPins = new Map<string, AtlasPinRecord>();

  getAtlasPublisher(volume: string): Promise<string | undefined> {
    return Promise.resolve(this.atlasPins.get(volume)?.publisher);
  }

  pinAtlasPublisher(volume: string, publisher: string, at: string, by: string): Promise<boolean> {
    const current = this.atlasPins.get(volume);
    if (current !== undefined && current.publisher !== publisher) return Promise.resolve(false);
    // An idempotent re-pin keeps the ORIGINAL stamp — parity with the Postgres store, whose conditional
    // DO UPDATE rewrites only `publisher` and leaves `pinned_at`/`pinned_by` as first written.
    this.atlasPins.set(volume, current ?? { volume, publisher, pinnedAt: at, pinnedBy: by });
    return Promise.resolve(true);
  }

  unpinAtlasPublisher(volume: string): Promise<boolean> {
    return Promise.resolve(this.atlasPins.delete(volume));
  }

  listAtlasPublishers(): Promise<AtlasPinRecord[]> {
    return Promise.resolve(
      [...this.atlasPins.values()]
        // Code-unit order, matching the Postgres store's ORDER BY (the placeUniquesForSourceIds note).
        .sort((a, b) => cmp(a.volume, b.volume))
        .map((pin) => structuredClone(pin)),
    );
  }

  listConflicts(placeUnique: string | undefined, limit: number): Promise<PlaceConflictRecord[]> {
    return Promise.resolve(
      this.conflicts
        .filter((c) => placeUnique === undefined || c.placeUnique === placeUnique)
        .sort((a, b) => {
          const ar = a.resolvedAt !== undefined ? 1 : 0;
          const br = b.resolvedAt !== undefined ? 1 : 0;
          if (ar !== br) return ar - br; // unresolved first
          return cmp(b.id, a.id); // then newest first
        })
        .slice(0, limit)
        .map((c) => structuredClone(c)),
    );
  }

  resolveConflicts(ids: readonly string[], at: string): Promise<number> {
    const wanted = new Set(ids);
    let n = 0;
    for (let i = 0; i < this.conflicts.length; i++) {
      const c = this.conflicts[i];
      if (c && wanted.has(c.id) && c.resolvedAt === undefined) {
        this.conflicts[i] = { ...c, resolvedAt: at };
        n += 1;
      }
    }
    return Promise.resolve(n);
  }

  createProposal(proposal: PlaceProposalRecord): Promise<void> {
    this.proposals.set(proposal.id, structuredClone(proposal));
    return Promise.resolve();
  }

  getProposal(id: string): Promise<PlaceProposalRecord | undefined> {
    const proposal = this.proposals.get(id);
    return Promise.resolve(proposal ? structuredClone(proposal) : undefined);
  }

  listProposals(
    filter: PlaceProposalFilter,
    limit: number,
    after?: string,
  ): Promise<PlaceProposalRecord[]> {
    return Promise.resolve(
      [...this.proposals.values()]
        .filter(
          (p) =>
            (filter.status === undefined || p.status === filter.status) &&
            (filter.proposedBy === undefined || p.proposedBy === filter.proposedBy) &&
            // Keyset: `id DESC`, so the next page is everything strictly below the cursor.
            (after === undefined || cmp(p.id, after) < 0),
        )
        .sort((a, b) => cmp(b.id, a.id))
        .slice(0, limit)
        .map((p) => structuredClone(p)),
    );
  }

  countPendingByDid(did: string): Promise<number> {
    let n = 0;
    for (const p of this.proposals.values()) {
      if (p.proposedBy === did && p.status === "pending") n += 1;
    }
    return Promise.resolve(n);
  }

  approvedContributionsForPlaces(placeUniques: readonly string[]): Promise<ApprovedContribution[]> {
    const wanted = new Set(placeUniques);
    const found: ApprovedContribution[] = [];
    for (const p of this.proposals.values()) {
      if (p.appliedPlace === undefined || !wanted.has(p.appliedPlace)) continue;
      if (p.status !== "approved") continue;
      found.push({
        did: p.proposedBy,
        ...(p.license ? { license: p.license } : {}),
        placeUnique: p.appliedPlace,
        credited: p.credit,
      });
    }
    // Sorted to match the Postgres store's ORDER BY — the parity suite compares these directly.
    return Promise.resolve(found.sort((a, b) => cmp(a.did, b.did)));
  }

  creditedContributionsFor(placeUnique: string): Promise<CreditedContribution[]> {
    const found: CreditedContribution[] = [];
    for (const p of this.proposals.values()) {
      if (p.appliedPlace === placeUnique && p.status === "approved" && p.credit) {
        found.push({ did: p.proposedBy, ...(p.license ? { license: p.license } : {}) });
      }
    }
    // Sorted to match the Postgres store's ORDER BY — the parity suite compares these directly.
    return Promise.resolve(found.sort((a, b) => cmp(a.did, b.did)));
  }

  updateProposal(id: string, review: PlaceProposalReview): Promise<number> {
    const proposal = this.proposals.get(id);
    if (!proposal || proposal.status !== "pending") return Promise.resolve(0);
    this.proposals.set(id, { ...proposal, ...structuredClone(review) });
    return Promise.resolve(1);
  }

  countActive(): Promise<number> {
    return Promise.resolve([...this.places.values()].filter((p) => p.status === "active").length);
  }

  stats(): Promise<PlaceStats> {
    const all = [...this.places.values()];
    return Promise.resolve({
      places: all.filter((p) => p.status === "active").length,
      placesRetired: all.filter((p) => p.status === "retired").length,
      conflictsPending: this.conflicts.filter((c) => c.resolvedAt === undefined).length,
      snapshots: this.snapshots.size,
    });
  }
}
