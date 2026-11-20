/**
 * The Wikipedia source — an article's intro extract and lead image, as a staged source of its own.
 *
 * **It replaces `apps/atlas/osm-enrich`, and the difference is not only where the code lives.** That job
 * ran before the taxonomy had classified anything, so it walked 862,992 imported rows for 53,486
 * candidates and took hours. Here the input is already staging, which is filtered to the 225,501 places
 * that can actually be published — 9,631 candidates over 9,348 distinct articles, about 470 batched
 * requests. It never asks about a place that will never ship.
 *
 * **A separate source, not a column on the OSM record.** The old shape folded the summary onto the
 * OSM record, which kept the licence honest (`descriptionCredit` carried CC BY-SA) but made
 * `merged_places.sources` name `osm` as the contributor of prose Wikipedia wrote — and
 * `apps/atlas/doc/spec/volume-format.md` §4 defines that array as who contributed a field. Now
 * per-field merge decides, and the gap-fill rule survives the move for free: `OWNER_FIRST` already
 * ranks `osm` above `wikipedia` for `description`, which is exactly what stage 1 used to enforce by
 * hand.
 *
 * **One record per enriched *place*, never per article, and it asserts no identifiers of its own.** It
 * names the record it was built out of — `derived_from` — and stage 2 joins it to that record's entity from
 * there; `StagedIdentity.derivedFrom` carries the reasoning, and the short version is that an id in
 * `upstreamIds` means *a source said this record is that entity*, which Wikipedia never said about an OSM
 * way. Two consequences worth having:
 *
 * - The fusion hazard is gone **by shape**. A record per article would have carried every `osm:` id
 *   that cited it, and `apps/atlas/doc/spec/place-identity.md`'s "an identifier node has exactly
 *   one root" would have fused those places — the parent-tag hazard `upstream.ts` documents for
 *   Commons categories, where the escape was making the namespace non-merge-key, an escape `osm:`
 *   cannot have. A derivation names exactly one parent, so a record spanning several is no longer a
 *   rule the stager must remember not to break.
 * - Nothing here can gate an identifier or be gated by one. A derived record adds no asserter to
 *   `fetchUpstreamSpans` and needs no usable merge key of its own, so it cannot fail to join.
 *
 * The article cache is keyed by title, so an article twenty places cite is fetched once. That is a
 * different granularity from the records, and deliberately so.
 */
import { commonsFileTitle, enwikiArticleUrl, WIKIPEDIA_CREDIT } from "@beaconsgg/place-taxonomy";
import type { MediaCredit } from "@beaconsgg/protocol-types";
import { BATCH, type WikimediaClient } from "@beaconsgg/wikimedia";
import {
  collapseWhitespace,
  fetchArticleCandidates,
  WIKIPEDIA_SOURCE,
  readArticles,
  recordRef,
  writeArticles,
  writeStaged,
  type ArticleCandidate,
  type ArticleRow,
  type Querier,
  type RecordRef,
  type StagedRow,
} from "./store";

/**
 * Who a photo found through an article is claimed by.
 *
 * Named because stage 4 **ranks on it**: `apps/atlas/doc/spec/sources.md` §5 puts a
 * Commons-verified article lead above a mapper's raw `wikimedia_commons=` tag, and the two are the
 * same `kind`, so `claimedBy` is the only thing telling them apart. A bare literal here and a bare
 * literal in the rank table would drift silently — every ref would fall to `unrankedSource`, which
 * the report counts and which publishes no photos.
 */
export const WIKI_CLAIMER = WIKIPEDIA_SOURCE;

export { WIKIPEDIA_SOURCE };

/** Candidate records per read. Smaller than stage 1's: each page does paced network work. */
const PAGE_SIZE = 500;

export interface WikipediaReport {
  /** Candidate records walked. */
  candidates: number;
  /** Distinct article titles seen. */
  titles: number;
  /** Titles fetched this run. */
  fetched: number;
  /** Titles already answered for by an earlier run. */
  known: number;
  /**
   * Titles Wikipedia answered about **this run** and has no article for — a fact, recorded so we never
   * re-ask. Per-run like every other counter here; the running total lives in `wiki_articles`.
   */
  absent: number;
  /**
   * Titles Wikipedia never answered for. **Deliberately unrecorded**, so the next run asks again, and the
   * only bucket a re-run can fix.
   */
  unanswered: number;
  /** Records staged as a `wikipedia` source. */
  staged: number;
  /** Records that named no article at all — nothing to ask, not a failure. */
  noArticle: number;
  /** Records whose article exists but carries neither a summary nor a lead image — nothing to stage. */
  emptyArticle: number;
  /** Of the staged records, how many bring a description to a place that had none. */
  fillsDescription: number;
  /** Of the staged records, how many bring a photo reference. */
  withPhoto: number;
}

const emptyReport = (): WikipediaReport => ({
  candidates: 0,
  titles: 0,
  fetched: 0,
  known: 0,
  absent: 0,
  unanswered: 0,
  staged: 0,
  noArticle: 0,
  emptyArticle: 0,
  fillsDescription: 0,
  withPhoto: 0,
});

export interface WikipediaOptions {
  /** A budget on **titles asked about**, not records walked — the cost here is paced requests. */
  limit: number;
  /** Re-ask about titles already answered for — see {@link WikipediaFlags.refresh}. */
  refresh: boolean;
  dryRun: boolean;
  client: WikimediaClient;
  now: () => string;
  log: (message: string) => void;
}

/**
 * The credit for a description taken from a Wikipedia article extract.
 *
 * The link goes through the shared `enwikiArticleUrl`, not a raw title, for the reason that helper exists:
 * a place's own `wikipedia` field and its credit's `sourceUrl` point at the same article from different
 * directions, and built separately they drifted immediately — one applied the URL length cap and the other
 * didn't. An over-long title yields no `sourceUrl` rather than an invalid one, and `MediaCredit` is the
 * shape the wire will eventually check, so a field it does not carry fails here rather than being silently
 * stripped at publication.
 */
export function wikipediaCredit(title: string): MediaCredit {
  const sourceUrl = enwikiArticleUrl(title);
  return { ...WIKIPEDIA_CREDIT, ...(sourceUrl ? { sourceUrl } : {}) };
}

/**
 * Why a candidate produced no staged record. Returned *with* the answer rather than re-derived by the
 * caller: an earlier cut re-tested one condition and inferred the other by elimination, so a third reason
 * would have been silently reported as the second. The deleted job's docblock named this exact regression as
 * one a cleanup pass had already fixed once.
 *
 * Both reasons are the **data's** — there is no such article, or it says nothing. A record can no longer be
 * skipped for anything of ours: it joins its entity by naming its parent, so there is no id for it to lack.
 */
export type SkipReason = "absent" | "emptyArticle";

/**
 * The staged record one candidate becomes, or the reason it did not.
 *
 * `category`, `subcategory` and `point` are the candidate's own, for the reason {@link ArticleCandidate}
 * gives. No `name`: an article title is not what a place is called. And no `upstreamIds`: identity comes from
 * `derivedFrom`, per this file's header.
 */
export function stagedFromArticle(
  candidate: ArticleCandidate,
  article: ArticleRow,
): { row: StagedRow } | { skipped: SkipReason } {
  if (article.absent) return { skipped: "absent" };
  if (!article.summary && !article.imageFile) return { skipped: "emptyArticle" };

  const row: StagedRow = {
    source: WIKIPEDIA_SOURCE,
    sourceId: candidate.sourceId,
    category: candidate.category,
    ...(candidate.subcategory ? { subcategory: candidate.subcategory } : {}),
    point: candidate.point,
    ...(article.summary
      ? // A description and its credit are never separable — `OWNED_BY` enforces it downstream, and this
        // is the side that must not emit one without the other.
        {
          description: collapseWhitespace(article.summary),
          descriptionCredit: wikipediaCredit(article.title),
        }
      : {}),
    mediaRefs: article.imageFile
      ? // Canonicalized to a `File:…` title, the one form staging holds for this kind — the API answers
        // `pageimage` as a bare underscored file name, and the OSM path stores the canonical form. Both
        // resolve identically because stage 4 normalizes anyway, but two spellings of one kind in one
        // column is a trap for the next reader that forgets to.
        //
        // Unverified on purpose: stage 4 does the authoritative Commons licence lookup now, so verifying
        // here would ask Commons the same question twice — which is what the two programs used to do.
        [
          {
            kind: "commons-file",
            value: commonsFileTitle(article.imageFile),
            claimedBy: WIKI_CLAIMER,
          },
        ]
      : [],
    upstreamIds: [],
    derivedFrom: recordRef(candidate),
    // Build-side provenance: what the article said, so a human can ask why a place says that. Nothing
    // downstream selects `raw` and no volume carries it.
    raw: { title: article.title, ...(article.summary ? { extract: article.summary } : {}) },
  };
  return { row };
}

/**
 * Resolve the articles staging names, and stage what they say.
 *
 * Keyset-paged over candidate records, batched to `BATCH.extracts` for the fetch, and **durable per
 * page** — an interrupted run keeps its work, which `apps/atlas/doc/spec/cartographer.md` §0 calls
 * non-negotiable.
 */
export async function stageWikipedia(
  db: Querier,
  opts: WikipediaOptions,
): Promise<WikipediaReport> {
  const report = emptyReport();
  /** Every title this run has resolved → what Wikipedia said, or `undefined` for never-answered. */
  const seen = new Map<string, ArticleRow | undefined>();
  let budget = opts.limit;
  let cursor: RecordRef | undefined;

  for (;;) {
    const page = await fetchArticleCandidates(db, {
      limit: PAGE_SIZE,
      ...(cursor ? { after: cursor } : {}),
    });
    if (page.length === 0) break;
    cursor = recordRef(page[page.length - 1]!);
    report.candidates += page.length;

    const wanted = page.filter((candidate) => candidate.title !== "");
    report.noArticle += page.length - wanted.length;

    // Ask only about titles this run has not already resolved — one article can be cited by many places,
    // and that ratio (9,631 records over 9,348 titles here, far higher on branded places) is the point of
    // caching by title rather than by place.
    const fresh = [...new Set(wanted.map((c) => c.title))].filter((t) => !seen.has(t));
    // `--refresh` skips the cache read, so every title in the page is asked again. The rows are upserted, so
    // an answer that has changed replaces the old one rather than accumulating beside it.
    if (!opts.refresh)
      for (const [title, row] of await readArticles(db, fresh)) seen.set(title, row);
    report.known += fresh.filter((title) => seen.has(title)).length;
    report.titles += fresh.length;

    const todo = fresh.filter((title) => !seen.has(title));
    for (let at = 0; at < todo.length && budget > 0; at += BATCH.extracts) {
      const slice = todo.slice(at, at + BATCH.extracts);
      budget -= slice.length;
      const rows = await fetchBatch(db, slice, report, opts);
      for (const row of rows) seen.set(row.title, row);
      // A title Wikipedia never answered for is remembered as *unanswered* — the `undefined` the map's
      // type promises. Without it a later page citing the same title re-asks it inside one run, spending
      // budget twice and making `titles`/`unanswered` counts of attempts rather than of titles. Nothing
      // durable is written for it, so the next run still asks.
      for (const title of slice) if (!seen.has(title)) seen.set(title, undefined);
    }

    const staged: StagedRow[] = [];
    for (const candidate of wanted) {
      const article = seen.get(candidate.title);
      if (!article) continue;
      const outcome = stagedFromArticle(candidate, article);
      if ("skipped" in outcome) {
        // `absent` is already counted where it is learned — per *title*, which is the granularity it is a
        // fact at. Counting it again per record would double-report one answer.
        if (outcome.skipped === "emptyArticle") report.emptyArticle += 1;
        continue;
      }
      staged.push(outcome.row);
      if (outcome.row.description && !candidate.hasDescription) report.fillsDescription += 1;
      if (outcome.row.mediaRefs.length > 0) report.withPhoto += 1;
    }
    report.staged += staged.length;
    if (!opts.dryRun) await writeStaged(db, staged, opts.now());

    opts.log(
      `${report.candidates} candidates · ${report.titles} titles · ${report.fetched} fetched · ` +
        `${report.staged} staged` +
        (budget <= 0 ? " — title budget reached" : ""),
    );
    if (budget <= 0) break;
    if (page.length < PAGE_SIZE) break;
  }

  return report;
}

/** One batched article request, written durably. Returns the rows it wrote. */
async function fetchBatch(
  db: Querier,
  titles: readonly string[],
  report: WikipediaReport,
  opts: WikipediaOptions,
): Promise<ArticleRow[]> {
  // No local `.catch()`: `@beaconsgg/wikimedia` owns this — a socket that never opened comes back as
  // `unavailable`, the same as a throttle, because both mean the same thing to a caller.
  const answer = await opts.client.articles(titles);
  if (answer.unavailable) {
    // Nothing written. A batch Wikipedia never answered is not knowledge about any of these titles, and a
    // row for it would turn "we never asked successfully" into "this place has no article" — permanently,
    // since the next run's `readArticles` would then skip it.
    report.unanswered += titles.length;
    return [];
  }

  // The API normalizes *and* follows redirects, so a title can move **twice** — `Mukilteo_Light` →
  // `Mukilteo Light` → `Mukilteo Lighthouse`. `resolved` holds both hops as separate entries, so a
  // single lookup lands on the intermediate name, finds nothing, and records the article as absent —
  // permanently, since a negative row is never re-asked. Chased to the end instead, with a bound because
  // the map is upstream data and a cycle in it must not hang the crawl.
  const byTitle = new Map(answer.articles.map((a) => [a.title, a]));
  const endOfChain = (from: string): string => {
    let at = from;
    for (let hop = 0; hop < 4; hop++) {
      const next = answer.resolved.get(at);
      if (next === undefined || next === at) break;
      at = next;
    }
    return at;
  };
  const rows: ArticleRow[] = titles.map((asked) => {
    const article = byTitle.get(endOfChain(asked)) ?? byTitle.get(asked);
    if (!article) return { title: asked, absent: true };
    return {
      title: asked,
      absent: false,
      ...(article.extract ? { summary: article.extract } : {}),
      ...(article.imageFile ? { imageFile: article.imageFile } : {}),
    };
  });
  report.fetched += rows.filter((row) => !row.absent).length;
  report.absent += rows.filter((row) => row.absent).length;
  if (!opts.dryRun) await writeArticles(db, rows, opts.now());
  return rows;
}
