import { describe, expect, it } from "vitest";
import { resolve } from "../resolve";
import type { Querier, Transactor } from "../store";

const NOW = "2026-08-05T12:00:00.000Z";

interface Row {
  source: string;
  source_id: string;
  upstream_ids: string[];
}

/**
 * A fake querier answering the statements stage 2b issues, and recording the writes.
 *
 * It honours the keyset cursor, because the paging loop is real: a fake that ignored it would let the
 * loop re-read page one forever and still pass.
 */
function fakeDb(rows: readonly Row[], over: { prior?: unknown[]; decisions?: unknown[] } = {}) {
  const writes: { sql: string; payload: unknown }[] = [];
  const seen: string[] = [];
  const db: Querier = {
    query(sql: string, params: unknown[] = []) {
      seen.push(sql.slice(0, 40));
      if (sql.startsWith("BEGIN") || sql.startsWith("COMMIT")) return Promise.resolve({ rows: [] });
      if (sql.startsWith("SELECT source, source_id, upstream_ids")) {
        const limit = params[params.length - 1] as number;
        const after = sql.includes("(source, source_id) > (") ? (params[1] as string) : undefined;
        const page = (after === undefined ? rows : rows.filter((r) => r.source_id > after)).slice(
          0,
          limit,
        );
        return Promise.resolve({ rows: page });
      }
      if (sql.startsWith("WITH dup AS")) return Promise.resolve({ rows: [] });
      // The membership prune counts inside a CTE rather than shipping every deleted row back.
      if (sql.startsWith("WITH gone AS")) {
        writes.push({ sql: "DELETE FROM entity_members", payload: undefined });
        return Promise.resolve({ rows: [{ n: 0 }] });
      }
      if (sql.includes("FROM decisions")) return Promise.resolve({ rows: over.decisions ?? [] });
      if (sql.includes("FROM entities e")) return Promise.resolve({ rows: over.prior ?? [] });
      if (sql.startsWith("SELECT qid, claims")) return Promise.resolve({ rows: [] });
      if (sql.startsWith("INSERT") || sql.startsWith("DELETE")) {
        writes.push({ sql: sql.split(" ").slice(0, 3).join(" "), payload: params[0] });
        return Promise.resolve({ rows: [] });
      }
      throw new Error(`unexpected SQL: ${sql}`);
    },
  };
  // The real one checks out a single connection; a fake that just forwards is enough to assert that
  // every write went through it, which is what the transaction is for.
  const inTransaction: string[] = [];
  const tx: Transactor = {
    transaction: (fn) =>
      fn({
        query(sql: string, params?: unknown[]) {
          inTransaction.push(sql.split(" ").slice(0, 3).join(" "));
          return db.query(sql, params);
        },
      }),
  };
  return { db, tx, writes, seen, inTransaction };
}

const row = (sourceId: string, ...upstreamIds: string[]): Row => ({
  source: "osm",
  source_id: sourceId,
  upstream_ids: upstreamIds,
});

const opts = (over: Partial<Parameters<typeof resolve>[2]> = {}) => {
  let n = 0;
  return {
    dryRun: false,
    mintId: () => `E${++n}`,
    now: () => NOW,
    log: () => {},
    ...over,
  };
};

describe("resolve", () => {
  it("reads staging, resolves, and writes every table an entity needs", async () => {
    const { db, tx, writes, inTransaction } = fakeDb([row("way/1", "osm:w/1")]);
    const outcome = await resolve(db, tx, opts());

    expect(outcome.report).toMatchObject({ records: 1, entities: 1, minted: 1 });
    expect(writes.map((w) => w.sql)).toEqual([
      "INSERT INTO entities",
      "INSERT INTO entity_members",
      "INSERT INTO entity_upstream",
      "DELETE FROM entity_upstream",
      "DELETE FROM ambiguous_ids",
      "DELETE FROM entity_members",
    ]);
    // Every mutation is inside the transaction. A run interrupted halfway through must leave the
    // previous graph, not half of each — a merge key belonging to no entity reads as "new place" and
    // re-mints an id every downstream server is already holding.
    expect(inTransaction).toEqual([
      "INSERT INTO entities",
      "INSERT INTO entity_members",
      "INSERT INTO entity_upstream",
      "DELETE FROM entity_upstream",
      "DELETE FROM ambiguous_ids",
      "WITH gone AS",
    ]);
  });

  it("writes nothing under --dry-run but still reports what it would have done", async () => {
    const { db, tx, writes } = fakeDb([row("way/1", "osm:w/1"), row("way/2", "osm:w/2")]);
    const outcome = await resolve(db, tx, opts({ dryRun: true }));
    expect(outcome.report).toMatchObject({ entities: 2, minted: 2, pruned: 0 });
    expect(writes).toEqual([]);
  });

  it("pages to exhaustion rather than stopping at the first page", async () => {
    const rows = Array.from({ length: 5 }, (_, i) => row(`way/${i + 1}`, `osm:w/${i + 1}`));
    const { db, tx } = fakeDb(rows);
    const outcome = await resolve(db, tx, opts());
    expect(outcome.report.records).toBe(5);
  });

  it("carries the prior build's ids through, and mints only for what is new", async () => {
    const { db, tx } = fakeDb([row("way/1", "osm:w/1"), row("way/2", "osm:w/2")], {
      prior: [
        { id: "01OLD", upstream: [{ id: "osm:w/1", mergeKey: true }], members: 1, aliases: [] },
      ],
    });
    const outcome = await resolve(db, tx, opts());
    expect(outcome.report).toMatchObject({ reused: 1, minted: 1 });
  });

  /** The gate's refusals reach the report as evidence, not as a count — a silent gate is a policy. */
  it("passes the refused identifiers out alongside the report", async () => {
    const { db, tx } = fakeDb([row("node/1", "osm:n/1", "wd:Q108485435")]);
    const outcome = await resolve(db, tx, opts());
    // With no concordance row, the QID is pending rather than refused — and that distinction is the
    // whole point of reporting them separately.
    expect(outcome.gated).toEqual([]);
    expect(outcome.report.awaitingEvidence).toBe(1);
  });
});
