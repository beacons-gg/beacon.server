import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { recordNode } from "../identity";
import {
  assembleQueue,
  canonicalDecision,
  parseDecisionBody,
  parseMediaVerdict,
  BadRequest,
} from "../review";
import {
  writeDecision,
  deleteDecision,
  deleteMediaDecision,
  writeMediaDecisions,
  type AmbiguousRow,
  type ReviewAsserter,
  type WikidataLabel,
} from "../store";

const asserter = (sourceId: string, over: Partial<ReviewAsserter> = {}): ReviewAsserter => ({
  source: "osm",
  sourceId,
  name: `Place ${sourceId}`,
  category: "landmark",
  lon: -122.3,
  lat: 47.6,
  ...over,
});

const refusal = (upstreamId: string, over: Partial<AmbiguousRow> = {}): AmbiguousRow => ({
  upstreamId,
  records: 2,
  reason: "span",
  spanM: 1000,
  seenAt: "2026-08-08T00:00:00.000Z",
  ...over,
});

describe("assembleQueue — the reviewer's ordering, and the node a verdict names", () => {
  it("puts span refusals first, widest first, then not-a-place by asserter count", () => {
    const queue = assembleQueue(
      [
        refusal("wd:Q1", { reason: "not-a-place", records: 3 }),
        refusal("osm:w/1", { spanM: 600 }),
        refusal("wd:Q2", { reason: "not-a-place", records: 54 }),
        refusal("osm:w/2", { spanM: 90_000 }),
      ],
      new Map(),
      new Map(),
      [],
    );
    expect(queue.map((entry) => entry.upstreamId)).toEqual([
      "osm:w/2",
      "osm:w/1",
      "wd:Q2",
      "wd:Q1",
    ]);
  });

  /**
   * The asserter's `node` is built by `recordNode`, never spelled — the decisions docblock forbids a
   * hand-written `record:` string, and the page only ever echoes what this queue handed it.
   */
  it("gives every asserter its graph node, through recordNode", () => {
    const queue = assembleQueue(
      [refusal("wd:Q5", { records: 1 })],
      new Map([["wd:Q5", [asserter("node/7")]]]),
      new Map(),
      [],
    );
    expect(queue[0]?.asserters).toEqual([
      { ...asserter("node/7"), node: recordNode({ source: "osm", sourceId: "node/7" }) },
    ]);
  });

  it("labels a wd: refusal from the concordance, including the answered-absent case", () => {
    const labels = new Map<string, WikidataLabel>([
      ["Q5", { enwikiTitle: "Flock Safety", absent: false }],
      ["Q6", { absent: true }],
    ]);
    const queue = assembleQueue(
      [refusal("wd:Q5"), refusal("wd:Q6", { spanM: 500 }), refusal("osm:w/9", { spanM: 100 })],
      new Map(),
      labels,
      [],
    );
    expect(queue[0]).toMatchObject({ upstreamId: "wd:Q5", label: "Flock Safety" });
    expect(queue[1]).toMatchObject({ upstreamId: "wd:Q6", labelAbsent: true });
    expect(queue[2]?.label).toBeUndefined();
  });

  /**
   * Which decisions touch a refusal is identity-contract knowledge, so it is matched here — the
   * exported, tested layer — and the page stays presentational. A decision touches an entry when it
   * names the refused id on either end, or sits between two of the entry's own asserters.
   */
  it("attaches the decisions that touch each refusal", () => {
    const decision = (a: string, b: string) => ({
      a,
      b,
      verdict: "distinct",
      decidedBy: "alice",
      decidedAt: "2026-08-08T00:00:00.000Z",
    });
    const byId = decision("record:osm/node/7", "wd:Q5");
    const betweenAsserters = decision("record:osm/node/7", "record:osm/node/8");
    const elsewhere = decision("record:osm/node/9", "wd:Q9");
    const queue = assembleQueue(
      [refusal("wd:Q5", { records: 2 })],
      new Map([["wd:Q5", [asserter("node/7"), asserter("node/8")]]]),
      new Map(),
      [byId, betweenAsserters, elsewhere],
    );
    expect(queue[0]?.decisions).toEqual([byId, betweenAsserters]);
  });
});

describe("canonicalDecision — one spelling per pair", () => {
  it("puts the asserter first on a distinct, whichever end the UI sent first", () => {
    expect(canonicalDecision("wd:Q1", "record:osm/w/1", "distinct")).toEqual({
      a: "record:osm/w/1",
      b: "wd:Q1",
    });
    expect(canonicalDecision("record:osm/w/1", "wd:Q1", "distinct")).toEqual({
      a: "record:osm/w/1",
      b: "wd:Q1",
    });
  });

  it("sorts a same pair, so the two send orders store one row", () => {
    expect(canonicalDecision("record:osm/w/2", "record:osm/w/1", "same")).toEqual(
      canonicalDecision("record:osm/w/1", "record:osm/w/2", "same"),
    );
  });
});

describe("parseDecisionBody", () => {
  it("accepts a verdict, with the queue context it was ruled under", () => {
    expect(
      parseDecisionBody({ a: "record:osm/w/1", b: "wd:Q1", verdict: "distinct", context: "wd:Q1" }),
    ).toEqual({ a: "record:osm/w/1", b: "wd:Q1", verdict: "distinct", context: "wd:Q1" });
  });

  it("refuses anything else, as a BadRequest the response carries", () => {
    expect(() => parseDecisionBody({ a: "x", verdict: "same" })).toThrow(BadRequest);
    expect(() => parseDecisionBody({ a: "x", b: "x", verdict: "same" })).toThrow(/same node/);
    expect(() => parseDecisionBody({ a: "x", b: "y", verdict: "pending" })).toThrow(/verdict/);
    expect(() => parseDecisionBody({ a: "", b: "y", verdict: "same" })).toThrow(BadRequest);
    expect(() => parseDecisionBody(null)).toThrow(BadRequest);
  });
});

describe("parseMediaVerdict — the scope IS the verdict's meaning", () => {
  it("takes a global verdict with no place, and an unlink with one", () => {
    expect(parseMediaVerdict({ fileKey: "commons:File:A.jpg", verdict: "reject" })).toEqual({
      fileKey: "commons:File:A.jpg",
      verdict: "reject",
    });
    expect(
      parseMediaVerdict({ fileKey: "k:1", verdict: "unlink", entityId: "01A", reason: "wrong" }),
    ).toEqual({ fileKey: "k:1", verdict: "unlink", entityId: "01A", reason: "wrong" });
  });

  /**
   * The two mismatches are the ones that would go wrong SILENTLY: an unlink with no place would be
   * stored as a global reject and pull the photo from every place; a reject carrying a place would
   * be stored under a scope nothing reads, so the photo would keep publishing.
   */
  it("refuses a scope that contradicts the verdict", () => {
    expect(() => parseMediaVerdict({ fileKey: "k:1", verdict: "unlink" })).toThrow(
      /names the place/,
    );
    expect(() => parseMediaVerdict({ fileKey: "k:1", verdict: "reject", entityId: "01A" })).toThrow(
      /whole file/,
    );
    expect(() => parseMediaVerdict({ verdict: "ok" })).toThrow(BadRequest);
    expect(() => parseMediaVerdict({ fileKey: "k:1", verdict: "delete" })).toThrow(/verdict/);
  });
});

describe("media verdict writes", () => {
  const capture = () => {
    const calls: { sql: string; params: unknown[] }[] = [];
    return {
      calls,
      db: {
        query: async (sql: string, params?: unknown[]): Promise<{ rows: unknown[] }> => {
          calls.push({ sql, params: params ?? [] });
          return { rows: [], rowCount: 1 } as { rows: unknown[] };
        },
      },
    };
  };

  /** One row per (file, scope) — the unique index is over `COALESCE(entity_id,'')`, so the upsert is too. */
  it("upserts against the file+scope index", async () => {
    const { calls, db } = capture();
    await writeMediaDecisions(
      db,
      [{ fileKey: "k:1", verdict: "ok", decidedBy: "alice" }],
      "2026-08-08T00:00:00.000Z",
    );
    expect(calls[0]?.sql).toContain("ON CONFLICT (file_key, COALESCE(entity_id, '')) DO UPDATE");
  });

  it("bulk-approves in ONE statement — the button that makes 54k photos finite", async () => {
    const { calls, db } = capture();
    const rows = Array.from({ length: 60 }, (_, i) => ({
      fileKey: `k:${i}`,
      verdict: "ok" as const,
      decidedBy: "alice",
    }));
    await writeMediaDecisions(db, rows, "2026-08-08T00:00:00.000Z");
    expect(calls).toHaveLength(1);
    expect(JSON.parse(String(calls[0]?.params[0]))).toHaveLength(60);
  });

  it("withdrawing matches the global scope by its stored NULL", async () => {
    const { calls, db } = capture();
    expect(await deleteMediaDecision(db, "k:1")).toBe(1);
    expect(calls[0]?.sql).toContain("COALESCE(entity_id, '') = COALESCE($2, '')");
    expect(calls[0]?.params).toEqual(["k:1", null]);
  });
});

describe("decision writes — one row per unordered pair", () => {
  /**
   * The invariant itself lives in the schema (`decisions_pair_idx` on `LEAST/GREATEST`); the writer's
   * job is to upsert against THAT index — conflicting on the ordered key instead would insert a second
   * row for the flipped spelling — and to let the new spelling win, so the canonical orientation
   * corrects a hand-written one.
   */
  it("upserts against the unordered-pair index, new spelling winning", async () => {
    const calls: { sql: string; params: unknown[] }[] = [];
    const db = {
      query: async (sql: string, params?: unknown[]): Promise<{ rows: unknown[] }> => {
        calls.push({ sql, params: params ?? [] });
        return { rows: [] };
      },
    };
    await writeDecision(
      db,
      { a: "record:osm/w/1", b: "wd:Q1", verdict: "distinct", evidence: null, decidedBy: "alice" },
      "2026-08-08T00:00:00.000Z",
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]?.sql).toContain("ON CONFLICT ((LEAST(a, b)), (GREATEST(a, b))) DO UPDATE");
    expect(calls[0]?.sql).toContain("a = EXCLUDED.a");
    expect(calls[0]?.params?.slice(0, 3)).toEqual(["record:osm/w/1", "wd:Q1", "distinct"]);
  });

  it("withdraws a verdict whichever way round it was stored", async () => {
    let seen: unknown[] | undefined;
    const db = {
      query: async (_sql: string, params?: unknown[]): Promise<{ rows: unknown[] }> => {
        seen = params;
        return { rows: [], rowCount: 1 } as { rows: unknown[] };
      },
    };
    expect(await deleteDecision(db, "a", "b")).toBe(1);
    expect(seen).toEqual(["a", "b"]);
  });
});

describe("review-page.html — the panels that hide by attribute", () => {
  /**
   * Every panel on the page is toggled with the `hidden` attribute, and three of them (`#modal`,
   * `#grid`, `#main`) carry an id rule that sets `display`. An id selector outranks the user agent's
   * `[hidden] { display: none }`, so `hidden` stopped hiding them and the modal's full-viewport scrim
   * covered the page from first paint — the console was unusable while every endpoint behind it
   * passed. This pins the one rule that makes the attribute authoritative again, because the next
   * `#panel { display: … }` would reintroduce it silently.
   */
  it("makes [hidden] outrank the id rules that set display", () => {
    const page = readFileSync(join(__dirname, "..", "review-page.html"), "utf8");
    const style = page.slice(page.indexOf("<style>"), page.indexOf("</style>"));
    expect(style).toMatch(/\[hidden\]\s*\{[^}]*display:\s*none\s*!important/);

    const toggled = [...page.matchAll(/\$\("([a-z-]+)"\)\.hidden\s*=/g)].map((m) => m[1]);
    expect(toggled).toContain("modal");
    for (const id of new Set(toggled)) {
      expect(page).toMatch(new RegExp(`id="${id}"`));
    }
  });
});
