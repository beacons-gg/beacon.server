import { describe, expect, it } from "vitest";
import { merge } from "../merge";
import type { Querier } from "../store";

/** Stage 3's impure half: the paging loop, the cell assignment, and what a `--dry-run` must not write. */

const NOW = "2026-08-06T12:00:00.000Z";

interface Row {
  entity_id: string;
  source: string;
  source_id: string;
  category: string;
  point: string;
  name?: string | null;
  description?: string | null;
  description_credit?: unknown;
}

const row = (entityId: string, over: Partial<Row> = {}): Row => ({
  entity_id: entityId,
  source: "osm",
  source_id: `way/${entityId}`,
  category: "landmark",
  point: '{"type":"Point","coordinates":[-122.30474,47.94766]}',
  ...over,
});

/**
 * A fake that honours the keyset cursor, because the paging loop is real: one that ignored `after` would
 * let the loop re-read page one forever and still pass.
 */
function fakeDb(rows: readonly Row[]): {
  db: Querier;
  writes: { sql: string; payload: unknown }[];
} {
  const writes: { sql: string; payload: unknown }[] = [];
  const db: Querier = {
    query(sql: string, params: unknown[] = []) {
      if (sql.startsWith("WITH page AS")) {
        const limit = Number(params[0]);
        const after = params[1] as string | null;
        const ids = [...new Set(rows.map((r) => r.entity_id))]
          .sort()
          .filter((id) => after === null || id > after)
          .slice(0, limit);
        return Promise.resolve({ rows: rows.filter((r) => ids.includes(r.entity_id)) });
      }
      if (sql.startsWith("INSERT INTO merged_places")) {
        writes.push({ sql: "INSERT INTO merged_places", payload: params[0] });
        return Promise.resolve({ rows: [] });
      }
      throw new Error(`unexpected SQL: ${sql}`);
    },
  };
  return { db, writes };
}

const run = (rows: readonly Row[], over: { limit?: number; dryRun?: boolean } = {}) => {
  const { db, writes } = fakeDb(rows);
  return merge(db, {
    limit: over.limit ?? Number.POSITIVE_INFINITY,
    dryRun: over.dryRun ?? false,
    now: () => NOW,
    log: () => {},
  }).then((report) => ({ report, writes }));
};

const written = (writes: { payload: unknown }[]): Record<string, unknown>[] =>
  writes.flatMap((w) => JSON.parse(String(w.payload)) as Record<string, unknown>[]);

describe("merge", () => {
  it("writes one place per entity, with the cell a consumer will look in", async () => {
    const { report, writes } = await run([row("A"), row("B")]);
    expect(report).toMatchObject({ entities: 2, merged: 2, unmergeable: 0 });
    const places = written(writes);
    expect(places).toHaveLength(2);
    // Computed by `@beaconsgg/geo` at precision 5 — the same implementation the server indexes with, so a
    // place cannot be filed under a cell the server would compute differently.
    expect(places[0]).toMatchObject({ entityId: "A", cell: "c290b", sources: ["osm"] });
  });

  /**
   * A regression, and one only a real run could find: 31 of 225,084 us-west places sit close enough to a
   * cell edge that rounding to the published 5 decimals moves them across it. This is the real coordinate
   * that failed — `39.0673834` is just inside `9wfy3` (minLat `39.0673828125`) and `39.06738` is not.
   *
   * Filing it under the full-precision cell publishes a tile whose own contents fall outside it, and the
   * whole partial-import model rests on point-in-cell holding: a consumer filtering by cell drops exactly
   * these places, silently.
   */
  it("files a place under the cell its PUBLISHED coordinate falls in, not its full-precision one", async () => {
    const { writes } = await run([
      row("A", { point: '{"type":"Point","coordinates":[-108.5647319,39.0673834]}' }),
    ]);
    expect(written(writes)[0]).toMatchObject({ cell: "9wfy1" });
  });

  it("carries the merged fields and leaves point and geometry as columns", async () => {
    const { writes } = await run([row("A", { name: "Mukilteo Lighthouse" })]);
    const place = written(writes)[0];
    expect(place?.["fields"]).toEqual({ category: "landmark", name: "Mukilteo Lighthouse" });
    // `point` is its own column so stage 6 can ask PostGIS whether it really is in its cell.
    expect(place?.["point"]).toContain("Point");
  });

  it("pages without re-reading, and stops when a page comes back short", async () => {
    const rows = Array.from({ length: 5 }, (_, i) => row(`E${i}`));
    const { report } = await run(rows);
    expect(report.entities).toBe(5);
    expect(report.merged).toBe(5);
  });

  /**
   * The opposite of `resolve`, and deliberately: merging one entity needs only that entity's records, so a
   * bound produces fewer places rather than wrong ones. What it produces is an unpublishable database,
   * which `publish` refuses rather than trusting.
   */
  it("honours --limit", async () => {
    const rows = Array.from({ length: 10 }, (_, i) => row(`E${i}`));
    const { report } = await run(rows, { limit: 3 });
    expect(report.entities).toBe(3);
    expect(report.merged).toBe(3);
  });

  it("writes nothing on --dry-run but still reports what it would have written", async () => {
    const { report, writes } = await run([row("A")], { dryRun: true });
    expect(report.merged).toBe(1);
    expect(writes).toEqual([]);
  });

  /**
   * Not reachable through the current schema — `category` and `point` are both `NOT NULL` — so this pins
   * the gate rather than a live failure mode. It is kept because `MergeInput` is the seam a *new* source
   * arrives through, and the counter is what would tell an operator that source is producing nothing.
   */
  it("counts an entity whose records cannot make a servable place", async () => {
    const { report, writes } = await run([{ ...row("A"), point: undefined } as unknown as Row]);
    expect(report).toMatchObject({ entities: 1, merged: 0, unmergeable: 1 });
    expect(writes).toEqual([]);
  });

  /** The only external evidence that `OWNED_BY` works — see `mergeLines`. */
  it("counts credits and multi-source places", async () => {
    const { report } = await run([
      row("A", {
        description: "An operational aid.",
        description_credit: { license: "CC BY-SA 4.0" },
      }),
      row("B", { source: "wikipedia", source_id: "Mukilteo_Light", description: "Prose." }),
      row("B", { name: "Mukilteo Lighthouse" }),
    ]);
    expect(report.credited).toBe(1);
    expect(report.multiSource).toBe(1);
  });
});
