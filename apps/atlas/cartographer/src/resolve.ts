/**
 * Stage 2b — turn staged records into entities, in the database.
 *
 * The thin half of stage 2: every rule lives in `identity.ts`, which is pure, and this file reads the
 * inputs, mints ids, and writes the result. The split matters because identity is the part of the
 * pipeline whose correctness cannot be checked by looking at the output — 225,084 entities from 225,501
 * records looks exactly the same whether the 400 merges were the right 400 or not — so the rules have to
 * be testable directly rather than through a database.
 *
 * **Everything is read at once, and it has to be.** A component is only correct when every record
 * sharing an identifier is in view, which is also why `resolve` takes no `--limit`: a partial pass
 * produces *wrong* entities, not fewer, and mints ids for them. Only the identity columns are read, which
 * is what makes the whole set holdable — 225k records at ~100 bytes each is tens of megabytes.
 */
import { evidenceMap } from "./concordance";
import { resolveIdentity, type GatedId, type IdentityReport } from "./identity";
import type { EntityWrite, Querier, Transactor } from "./store";
import {
  fetchStagedIdentities,
  fetchUpstreamSpans,
  pruneVanishedMembers,
  readConcordance,
  readDecisions,
  readPriorEntities,
  writeAmbiguousIds,
  writeEntities,
} from "./store";

/** Entities per write statement. Same order of magnitude stage 1 settled on for its pages. */
const WRITE_BATCH = 2_000;

export interface ResolveReport extends IdentityReport {
  /** Memberships dropped because their staged record is gone. */
  pruned: number;
}

/**
 * The refused identifiers travel **beside** the report rather than as a count inside it: the report is
 * arithmetic, and these are evidence. `resolveLines` names the worst of them, and a number alone would
 * be the silent-gate failure this stage exists to avoid.
 */
export interface ResolveOutcome {
  report: ResolveReport;
  gated: GatedId[];
}

export async function resolve(
  db: Querier,
  tx: Transactor,
  opts: {
    dryRun: boolean;
    mintId: () => string;
    now: () => string;
    log: (message: string) => void;
  },
): Promise<ResolveOutcome> {
  // All five reads concurrently. The identity read is the biggest and the span query is the slowest
  // single statement, so leaving either out of this serialized them behind each other for no gain.
  //
  // The concordance is translated to evidence *inside* the read, so the raw rows — 29k of them, each
  // holding a full claims payload — become garbage immediately instead of being pinned for the whole run.
  const [records, spans, decisions, prior, evidence] = await Promise.all([
    fetchStagedIdentities(db),
    fetchUpstreamSpans(db),
    readDecisions(db),
    readPriorEntities(db),
    readConcordance(db).then(evidenceMap),
  ]);

  opts.log(
    `resolving ${records.length} records against ${evidence.size} concordance entries, ` +
      `${prior.length} existing entities`,
  );

  const result = resolveIdentity(
    { records, evidence, spans, decisions, prior },
    { mintId: opts.mintId },
  );

  if (opts.dryRun) {
    return { report: { ...result.report, pruned: 0 }, gated: result.gated };
  }

  // One timestamp for the whole run, not one per batch: every entity minted here was minted by the same
  // resolve, and 113 different `created_at` values inside one transaction would say otherwise.
  const now = opts.now();
  // One transaction. A run interrupted halfway through rewriting the graph must leave the *previous*
  // graph intact: a merge key belonging to no entity reads to the next run as "this place is new", and
  // it would mint a fresh id for a place every downstream server is already holding.
  const pruned = await tx.transaction(async (write) => {
    for (let start = 0; start < result.entities.length; start += WRITE_BATCH) {
      const batch: EntityWrite[] = result.entities.slice(start, start + WRITE_BATCH);
      await writeEntities(write, batch, now);
      opts.log(`wrote ${Math.min(start + batch.length, result.entities.length)} entities`);
    }
    await writeAmbiguousIds(write, result.gated, now);
    return pruneVanishedMembers(write);
  });

  return { report: { ...result.report, pruned }, gated: result.gated };
}
