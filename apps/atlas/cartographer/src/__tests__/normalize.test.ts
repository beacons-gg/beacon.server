import { describe, expect, it } from "vitest";
import { normalize } from "../normalize";
import type { OsmRow, Querier, StagedRow } from "../store";

const NOW = "2026-08-05T12:00:00.000Z";
const POINT = '{"type":"Point","coordinates":[-122.3,47.9]}';

const row = (id: number, tags: Record<string, string>): OsmRow => ({
  osm_type: "W",
  osm_id: String(id),
  name: tags["name"] ?? null,
  tags,
  point: POINT,
  geom: null,
});

/**
 * A fake `pg` querier answering the two statements stage 1 issues, and recording the writes.
 *
 * It honours the keyset cursor — without that, the paging loop would re-read page one forever, and a
 * test that didn't model it would pass while the real run never terminated.
 *
 * Writes arrive as one `jsonb` parameter holding the page, so the recorded rows are just the records
 * themselves. The earlier `unnest` form needed unpacking from 15 parallel arrays by index
 * (`const [, sourceIds, , , , , , , categories] = params`), which meant inserting a column silently
 * re-pointed the destructure at the wrong vector.
 */
function fakeDb(rows: readonly OsmRow[]) {
  const writes: { row: StagedRow; now: string }[] = [];
  const pages: number[] = [];
  const db: Querier = {
    query(sql: string, params: unknown[] = []) {
      if (sql.startsWith("CREATE")) return Promise.resolve({ rows: [] });
      if (sql.includes("FROM beacon_places")) {
        const limit = params[params.length - 1] as number;
        const after = sql.includes("beacon_places.osm_id) > (") ? (params[1] as string) : undefined;
        const page = (
          after === undefined ? rows : rows.filter((r) => Number(r.osm_id) > Number(after))
        ).slice(0, limit);
        pages.push(page.length);
        return Promise.resolve({ rows: page });
      }
      if (sql.startsWith("INSERT INTO source_records")) {
        const [payload, now] = params as [string, string];
        for (const row of JSON.parse(payload) as StagedRow[]) writes.push({ row, now });
        return Promise.resolve({ rows: [] });
      }
      throw new Error(`unexpected SQL: ${sql}`);
    },
  };
  return { db, writes, pages };
}

const opts = (over: Partial<Parameters<typeof normalize>[1]> = {}) => ({
  limit: Number.POSITIVE_INFINITY,
  dryRun: false,
  now: () => NOW,
  log: () => {},
  ...over,
});

describe("normalize", () => {
  it("pages by keyset to exhaustion and stages every classifiable row", async () => {
    // More rows than one page holds would need 2,000 fixtures; the cursor is exercised instead by
    // asserting the loop stops rather than re-reading — the failure mode a fixed LIMIT would produce.
    const rows = [
      row(1, { name: "Park", leisure: "park" }),
      row(2, { name: "Camp", tourism: "camp_site" }),
      row(3, { name: "Diner", amenity: "restaurant" }),
    ];
    const { db, writes, pages } = fakeDb(rows);

    const report = await normalize(db, opts());

    expect(report).toMatchObject({ rowsRead: 3, staged: 2 });
    expect(writes.map((w) => w.row.sourceId)).toEqual(["way/1", "way/2"]);
    // A short page ends the loop — the empty-page probe it used to need was a wasted round trip.
    expect(pages).toEqual([3]);
  });

  it("counts coverage per category, which is how sources.md §6 says to read it", async () => {
    const { db } = fakeDb([
      row(1, { name: "A", leisure: "park" }),
      row(2, { name: "B", tourism: "camp_site" }),
      row(3, { name: "C", natural: "glacier" }),
    ]);
    const report = await normalize(db, opts());
    expect(report.byCategory).toEqual({ park: 2, nature: 1 });
  });

  it("counts the fields the volume actually cares about", async () => {
    const withBoth: OsmRow = {
      ...row(1, {
        name: "L",
        man_made: "lighthouse",
        wikidata: "Q1",
        image: "https://e.org/a.jpg",
        description: "A paragraph.",
      }),
    };
    const { db } = fakeDb([withBoth, row(2, { name: "Plain", leisure: "park" })]);
    const report = await normalize(db, opts());
    expect(report).toMatchObject({
      staged: 2,
      withDescription: 1,
      withMedia: 1,
      // Row 2's only upstream id is its own, so it is no use to the concordance.
      withConcordance: 1,
    });
  });

  it("honours --limit as a page budget", async () => {
    const rows = [1, 2, 3, 4, 5].map((i) => row(i, { name: `P${i}`, leisure: "park" }));
    const { db, writes } = fakeDb(rows);
    const report = await normalize(db, opts({ limit: 2 }));
    expect(report.rowsRead).toBe(2);
    expect(writes).toHaveLength(2);
  });

  it("writes nothing under --dry-run, but still reports what it would have staged", async () => {
    const { db, writes } = fakeDb([row(1, { name: "Park", leisure: "park" })]);
    const report = await normalize(db, opts({ dryRun: true }));
    expect(report.staged).toBe(1);
    expect(writes).toEqual([]);
  });

  it("stamps every write with one timestamp per page", async () => {
    const { db, writes } = fakeDb([row(1, { name: "Park", leisure: "park" })]);
    await normalize(db, opts());
    expect(writes.every((w) => w.now === NOW)).toBe(true);
  });

  it("sends the page as one JSON payload the writer can round-trip", async () => {
    // The shape the SQL depends on: camelCase keys, absent keys simply absent (they become NULL), and
    // `altNames`/`upstreamIds` as JSON arrays that `jsonb_to_recordset` widens to `text[]`.
    const { db, writes } = fakeDb([
      row(1, { name: "L", man_made: "lighthouse", alt_name: "Old Light", wikidata: "Q1" }),
    ]);
    await normalize(db, opts());
    expect(writes[0]?.row).toMatchObject({
      source: "osm",
      sourceId: "way/1",
      altNames: ["Old Light"],
      upstreamIds: ["osm:w/1", "wd:Q1"],
      category: "landmark",
    });
    expect(writes[0]?.row).not.toHaveProperty("description");
  });
});
