/**
 * Stage 1 — **the OSM source** becomes rows in the staging table.
 *
 * Not every source: `wikipedia.ts` stages a second one, from its own stage, because it needs the
 * concordance's sitelinks to know which article a place is about. What they share is the destination
 * (`source_records`) and `writeStaged`; the loops differ in cursor shape, page size, budget unit, and
 * whether paced third-party work happens between the read and the write — four parameters for a dozen
 * shared lines, which is why there is no common seam yet. A third source is when to revisit that.
 *
 * The loop is the shape `apps/atlas/osm-enrich` proved before it was absorbed: read a page by keyset
 * cursor, transform it in memory, write it durably, advance.
 *
 * That makes an interrupted run **safe to repeat, not cheap to repeat** — a distinction worth being
 * precise about. A stamp column would advance the candidate window so a re-run skipped what was done;
 * here the cursor starts empty every time and the read has no filter, so a re-run re-reads all 862k rows
 * and upserts them to the same values. Idempotent, in other words, and at ~a minute the difference
 * doesn't yet pay for an anti-join against `source_records`.
 *
 * All the rules live in `osm.ts` and are pure; this file owns paging, counting and the durable write.
 */
import { stageOsmRow } from "./osm";
import { fetchOsmRows, OSM_SOURCE, writeStaged, type RowCursor, type StagedRow } from "./store";
import type { Querier } from "./store";

/**
 * Rows per page: one database read, one transform, one durable write.
 *
 * Larger than `osm-enrich`'s 500 because nothing here is paced by a third party — the cost is a round
 * trip and the memory one page holds, and the table is millions of rows. It bounds how much work an
 * interrupt discards, which for a purely local pass is cheap either way.
 */
const PAGE_SIZE = 2_000;

export interface NormalizeOptions {
  /** Max rows to read this run. `Infinity` (the default) means "until the table is exhausted". */
  limit: number;
  dryRun: boolean;
  now: () => string;
  log: (message: string) => void;
}

/** What a stage-1 pass did. */
export interface NormalizeReport {
  /** Rows read out of `beacon_places`. */
  rowsRead: number;
  /**
   * Rows that classified and staged. What did **not** stage is `rowsRead - staged` — derived where it
   * is reported rather than counted here, so the two can't disagree. Those are rows that matched no
   * taxonomy entry or had no representative point, and they are **expected in bulk**, not errors: the
   * Lua import filter is key-level, so most of what it admits matches no taxonomy entry.
   */
  staged: number;
  /** Staged records carrying at least one photo reference for stage 4. */
  withMedia: number;
  /** Staged records carrying a description — a mapper's own tag, since this stage reads only OSM. */
  withDescription: number;
  /** Staged records carrying an upstream id beyond their own OSM id — stage 2's concordance fuel. */
  withConcordance: number;
  /** Per-category counts, so coverage can be read where `apps/atlas/doc/spec/sources.md` §6 says it matters. */
  byCategory: Record<string, number>;
}

export async function normalize(db: Querier, opts: NormalizeOptions): Promise<NormalizeReport> {
  const report: NormalizeReport = {
    rowsRead: 0,
    staged: 0,
    withMedia: 0,
    withDescription: 0,
    withConcordance: 0,
    byCategory: {},
  };

  let cursor: RowCursor | undefined;
  let budget = opts.limit;

  while (budget > 0) {
    const pageSize = Math.min(PAGE_SIZE, budget);
    const rows = await fetchOsmRows(db, { limit: pageSize, ...(cursor ? { after: cursor } : {}) });
    if (rows.length === 0) break;

    const last = rows[rows.length - 1]!;
    cursor = { osmType: last.osm_type, osmId: last.osm_id };
    budget -= rows.length;
    report.rowsRead += rows.length;

    const staged: StagedRow[] = [];
    for (const row of rows) {
      const record = stageOsmRow(row);
      if (!record) continue;
      report.staged += 1;
      if (record.mediaRefs.length > 0) report.withMedia += 1;
      if (record.description) report.withDescription += 1;
      if (record.upstreamIds.length > 1) report.withConcordance += 1;
      report.byCategory[record.category] = (report.byCategory[record.category] ?? 0) + 1;
      staged.push({ source: OSM_SOURCE, ...record });
    }

    opts.log(
      `${report.rowsRead} rows read · ${report.staged} staged · ${report.withDescription} with a ` +
        `description · ${report.withMedia} with a photo reference`,
    );
    if (!opts.dryRun) await writeStaged(db, staged, opts.now());
    // A short page means the keyset scan reached the end — no need to spend a round trip proving it.
    if (rows.length < pageSize) break;
  }

  if (opts.dryRun) opts.log("dry run — nothing written");
  return report;
}
