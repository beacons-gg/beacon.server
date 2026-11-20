import { describe, expect, it } from "vitest";
import {
  stageWikipedia,
  stagedFromArticle,
  wikipediaCredit,
  WIKIPEDIA_SOURCE,
  type WikipediaOptions,
} from "../wikipedia";
import type { ArticleCandidate, ArticleRow, Querier, StagedRow } from "../store";

/**
 * The Wikipedia source's decisions, tested without a network or a database.
 *
 * One of these guards a property nothing else can: a record per *place* rather than per article, and joined
 * to that place by **naming** it rather than by restating its identifiers. The other way round fuses places
 * and pollutes the evidence the merge gate rules on, both silently.
 */

const POINT = '{"type":"Point","coordinates":[-122.3,47.9]}';

const candidate = (over: Partial<ArticleCandidate> = {}): ArticleCandidate => ({
  source: "osm",
  sourceId: "way/586464226",
  title: "Mukilteo Light",
  category: "landmark",
  subcategory: "structure",
  point: POINT,
  hasDescription: false,
  ...over,
});

/** The staged row, or `undefined` — the shape these assertions read. */
const staged = (c: ArticleCandidate, a: ArticleRow): StagedRow | undefined => {
  const out = stagedFromArticle(c, a);
  return "row" in out ? out.row : undefined;
};

/** Why nothing was staged, for the cases that are about the reason. */
const why = (c: ArticleCandidate, a: ArticleRow): string | undefined => {
  const out = stagedFromArticle(c, a);
  return "skipped" in out ? out.skipped : undefined;
};

const article = (over: Partial<ArticleRow> = {}): ArticleRow => ({
  title: "Mukilteo Light",
  summary: "An operational navigation aid.",
  absent: false,
  ...over,
});

describe("stagedFromArticle — what an article becomes", () => {
  it("stages a wikipedia record under the enriched record's own source id", () => {
    const row = staged(candidate(), article());
    expect(row?.source).toBe(WIKIPEDIA_SOURCE);
    // The same `source_id`, a different `source` — so `(source, source_id)` keeps them distinct rows.
    expect(row?.sourceId).toBe("way/586464226");
    expect(row?.description).toBe("An operational navigation aid.");
  });

  /**
   * The credit and the text are never separable — `OWNED_BY` enforces it downstream, and this is the side
   * that must not emit one without the other.
   */
  it("credits the article it took the words from", () => {
    expect(staged(candidate(), article())?.descriptionCredit).toEqual({
      license: "CC BY-SA 4.0",
      licenseUrl: "https://creativecommons.org/licenses/by-sa/4.0/",
      author: "Wikipedia contributors",
      sourceUrl: "https://en.wikipedia.org/wiki/Mukilteo_Light",
    });
  });

  /**
   * **The identity join, and the whole reason this record exists as its own row.** It names the record it
   * was built from and asserts *nothing* about who that place is — an id in `upstreamIds` means a source
   * said this record is that entity, and Wikipedia never said `osm:w/586464226`. Copying them there instead
   * made every one of the parent's ids look shared, which is the population the merge gate rules on.
   */
  it("names the record it was derived from, and asserts no identifiers of its own", () => {
    const row = staged(candidate(), article());
    expect(row?.derivedFrom).toEqual({ source: "osm", sourceId: "way/586464226" });
    expect(row?.upstreamIds).toEqual([]);
  });

  /**
   * Copied because `point` is `NOT NULL` and nothing here knows better — it loses to OSM in `MAPPER_FIRST`,
   * so it never reaches a tile. It used to be load-bearing for the span measurement; now no derived record
   * is measured at all.
   */
  it("copies the point verbatim", () => {
    expect(staged(candidate(), article())?.point).toBe(POINT);
  });

  it("stages nothing when Wikipedia says there is no such article", () => {
    expect(why(candidate(), { title: "X", absent: true })).toBe("absent");
  });

  it("stages nothing for an article with neither a summary nor a lead image", () => {
    expect(why(candidate(), { title: "X", absent: false })).toBe("emptyArticle");
  });

  /**
   * The lead image rides as an unverified `commons-file` ref claimed by `wikipedia` — rank 1 in stage 4's
   * order. Unverified on purpose: stage 4 does the authoritative Commons licence lookup, and verifying here
   * would ask Commons the same question twice, which is what the two programs used to do.
   */
  it("emits the lead image as a wikipedia-claimed ref, unverified and canonicalized", () => {
    // The API answers `pageimage` as a bare underscored file name; staging holds one form per kind, and
    // for `commons-file` that form is a `File:…` title — the same one the OSM path writes.
    const row = staged(candidate(), article({ imageFile: "Mukilteo_Light_2026.jpg" }));
    expect(row?.mediaRefs).toEqual([
      { kind: "commons-file", value: "File:Mukilteo Light 2026.jpg", claimedBy: "wikipedia" },
    ]);
  });

  it("stages a photo-only article, with no description", () => {
    const bare: ArticleRow = { title: "Mukilteo Light", absent: false, imageFile: "A.jpg" };
    const row = staged(candidate(), bare);
    expect(row?.description).toBeUndefined();
    expect(row?.descriptionCredit).toBeUndefined();
    expect(row?.mediaRefs).toHaveLength(1);
  });

  /**
   * An article title is not what a place is called — `MAPPER_FIRST` would let it win the name on any place
   * OSM left nameless, which is how a lighthouse ends up called "Mukilteo Light (Washington)".
   */
  it("never supplies a name", () => {
    expect(staged(candidate(), article())).not.toHaveProperty("name");
  });

  /**
   * The fields the `NOT NULL` columns demand, and nothing more. All three lose to OSM in `MAPPER_FIRST`,
   * so none of them reaches a tile and none puts `wikipedia` in the place's `sources`.
   */
  it("carries category, subcategory and point only because the columns require them", () => {
    const row = staged(candidate(), article());
    expect(row?.category).toBe("landmark");
    expect(row?.subcategory).toBe("structure");
    // A candidate with no subcategory of its own omits the key rather than sending an explicit undefined —
    // which `canonicalJson` would treat differently from an absent one at publication.
    const { subcategory, ...bare } = candidate();
    void subcategory;
    expect(staged(bare as ArticleCandidate, article())).not.toHaveProperty("subcategory");
  });

  /**
   * Moved here from `osm.test.ts` with the source it was about: staging holds what the source said. Stage 5
   * clamps to the wire's limit; doing it here would mean a volume could never carry a longer field without
   * re-resolving every article.
   */
  it("applies no wire caps — staging holds what the article said", () => {
    const long = "x".repeat(3_000);
    expect(staged(candidate(), article({ summary: long }))?.description).toHaveLength(3_000);
  });

  it("keeps the article as build-side provenance", () => {
    expect(staged(candidate(), article())?.raw).toEqual({
      title: "Mukilteo Light",
      extract: "An operational navigation aid.",
    });
  });
});

describe("wikipediaCredit", () => {
  /**
   * Through the shared `enwikiArticleUrl`, so a place's own `wikipedia` field and its credit's `sourceUrl`
   * agree about the length cap. Built separately they drifted immediately — one applied it, one did not.
   */
  it("omits sourceUrl rather than emitting an over-long one", () => {
    const credit = wikipediaCredit("x".repeat(400));
    expect(credit).not.toHaveProperty("sourceUrl");
    expect(credit).toMatchObject({ license: "CC BY-SA 4.0" });
  });
});

/**
 * The loop, over a fake database and a fake client.
 *
 * The pure function above is the easy half. Everything that actually bit during review lives here: whether a
 * throttled batch is recorded, whether a title is asked twice in one run, and whether the budget is spent on
 * work that happened.
 */
describe("stageWikipedia — the loop", () => {
  const NOW = "2026-08-06T00:00:00.000Z";

  const candidateRow = (n: number, title: string) => ({
    source: "osm",
    source_id: `way/${n}`,
    title,
    category: "landmark",
    subcategory: null,
    point: POINT,
    has_description: false,
  });

  function fakeDb(pages: ReturnType<typeof candidateRow>[][], cached: ArticleRow[] = []) {
    const staged: StagedRow[] = [];
    const articles: ArticleRow[] = [];
    let page = 0;
    const db: Querier = {
      query(sql: string, params: unknown[] = []) {
        if (sql.includes("FROM source_records s WHERE s.source <>")) {
          return Promise.resolve({ rows: pages[page++] ?? [] });
        }
        if (sql.startsWith("SELECT title, summary, image_file, absent FROM wiki_articles")) {
          const want = new Set(params[0] as string[]);
          return Promise.resolve({
            rows: cached
              .filter((a) => want.has(a.title))
              .map((a) => ({
                title: a.title,
                summary: a.summary ?? null,
                image_file: a.imageFile ?? null,
                absent: a.absent,
              })),
          });
        }
        if (sql.startsWith("INSERT INTO wiki_articles")) {
          articles.push(...(JSON.parse(params[0] as string) as ArticleRow[]));
          return Promise.resolve({ rows: [] });
        }
        if (sql.startsWith("INSERT INTO source_records")) {
          staged.push(...(JSON.parse(params[0] as string) as StagedRow[]));
          return Promise.resolve({ rows: [] });
        }
        throw new Error(`unexpected SQL: ${sql}`);
      },
    };
    return { db, staged, articles };
  }

  /** A client that answers, or reports it never did. Records what it was asked. */
  const client = (opts: {
    unavailable?: boolean;
    articles?: { title: string; extract?: string }[];
    resolved?: [string, string][];
    asked?: string[][];
  }) =>
    ({
      articles: (titles: readonly string[]) => {
        opts.asked?.push([...titles]);
        return Promise.resolve({
          unavailable: opts.unavailable ?? false,
          articles: opts.articles ?? [],
          resolved: new Map(opts.resolved ?? []),
        });
      },
    }) as never;

  const run = (db: Querier, c: never, over: Partial<WikipediaOptions> = {}) =>
    stageWikipedia(db, {
      limit: Number.POSITIVE_INFINITY,
      refresh: false,
      dryRun: false,
      client: c,
      now: () => NOW,
      log: () => {},
      ...over,
    });

  it("stages a record per candidate and records the article once", async () => {
    const { db, staged, articles } = fakeDb([
      [candidateRow(1, "Alpha"), candidateRow(2, "Alpha")],
      [],
    ]);
    const report = await run(db, client({ articles: [{ title: "Alpha", extract: "A." }] }));
    // One article, two places — the two granularities the file's header separates. Each staged row names
    // its *own* parent, which is what keeps the shared article from fusing them: a single record citing
    // both would put one identifier node on two entities.
    expect(articles).toHaveLength(1);
    expect(staged.map((r) => r.sourceId)).toEqual(["way/1", "way/2"]);
    expect(staged.map((r) => r.derivedFrom)).toEqual([
      { source: "osm", sourceId: "way/1" },
      { source: "osm", sourceId: "way/2" },
    ]);
    expect(report).toMatchObject({ titles: 1, fetched: 1, staged: 2, candidates: 2 });
  });

  /**
   * The property the whole stage exists for. A batch Wikipedia never answered must leave **no row**, or the
   * next run's cache read skips it and the place is permanently described as having no article.
   */
  it("writes nothing for a batch Wikipedia never answered", async () => {
    const { db, staged, articles } = fakeDb([[candidateRow(1, "Alpha")], []]);
    const report = await run(db, client({ unavailable: true }));
    expect(articles).toEqual([]);
    expect(staged).toEqual([]);
    expect(report).toMatchObject({ unanswered: 1, fetched: 0, absent: 0 });
  });

  /** Answered-and-there-is-none is a *fact*, so it is recorded — the other side of the same distinction. */
  it("records a title Wikipedia says has no article", async () => {
    const { db, staged, articles } = fakeDb([[candidateRow(1, "Nope")], []]);
    const report = await run(db, client({ articles: [] }));
    expect(articles).toEqual([{ title: "Nope", absent: true }]);
    expect(staged).toEqual([]);
    expect(report).toMatchObject({ absent: 1, unanswered: 0 });
  });

  /** An unanswered title must not be re-asked inside one run — it would spend the budget twice. */
  it("asks an unanswered title once per run, not once per page citing it", async () => {
    const asked: string[][] = [];
    const { db } = fakeDb([[candidateRow(1, "Alpha")], [candidateRow(2, "Alpha")], []]);
    const report = await run(db, client({ unavailable: true, asked }));
    expect(asked).toHaveLength(1);
    expect(report.titles).toBe(1);
  });

  it("asks nothing about a title an earlier run already answered", async () => {
    const asked: string[][] = [];
    const { db, staged } = fakeDb(
      [[candidateRow(1, "Alpha")], []],
      [{ title: "Alpha", absent: false, summary: "Cached." }],
    );
    const report = await run(db, client({ asked }));
    expect(asked).toEqual([]);
    expect(report).toMatchObject({ known: 1, fetched: 0 });
    expect(staged[0]?.description).toBe("Cached.");
  });

  it("--refresh asks again even about a title already answered", async () => {
    const asked: string[][] = [];
    const { db } = fakeDb([[candidateRow(1, "Alpha")], []], [{ title: "Alpha", absent: true }]);
    await run(db, client({ articles: [{ title: "Alpha", extract: "Now it exists." }], asked }), {
      refresh: true,
    });
    expect(asked).toEqual([["Alpha"]]);
  });

  /**
   * MediaWiki can move a title **twice** — normalize, then redirect. A single-hop lookup lands on the
   * intermediate name, finds nothing, and records the article absent forever.
   */
  it("follows a normalize→redirect chain to the end", async () => {
    const { db, staged } = fakeDb([[candidateRow(1, "Mukilteo_Light")], []]);
    await run(
      db,
      client({
        articles: [{ title: "Mukilteo Lighthouse", extract: "An aid." }],
        resolved: [
          ["Mukilteo_Light", "Mukilteo Light"],
          ["Mukilteo Light", "Mukilteo Lighthouse"],
        ],
      }),
    );
    expect(staged[0]?.description).toBe("An aid.");
  });

  it("spends the budget on titles asked about, and stops", async () => {
    const asked: string[][] = [];
    const { db } = fakeDb([
      [candidateRow(1, "A"), candidateRow(2, "B")],
      [candidateRow(3, "C")],
      [],
    ]);
    const report = await run(db, client({ articles: [], asked }), { limit: 2 });
    expect(asked.flat()).toEqual(["A", "B"]);
    expect(report.titles).toBe(2);
  });

  it("collapses the paragraph breaks an intro extract arrives with", async () => {
    const { db, staged } = fakeDb([[candidateRow(1, "Alpha")], []]);
    await run(db, client({ articles: [{ title: "Alpha", extract: "One.\n\nTwo.  Three." }] }));
    expect(staged[0]?.description).toBe("One. Two. Three.");
  });

  it("--dry-run writes nothing at all", async () => {
    const { db, staged, articles } = fakeDb([[candidateRow(1, "Alpha")], []]);
    await run(db, client({ articles: [{ title: "Alpha", extract: "A." }] }), { dryRun: true });
    expect(articles).toEqual([]);
    expect(staged).toEqual([]);
  });
});
