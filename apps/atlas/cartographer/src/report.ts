/**
 * Every stage's end-of-run report, as lines for `main.ts` to print.
 *
 * One assembly point per stage, and pure, so the arithmetic and the wording are testable without a
 * run. A report built in two places prints in two styles and drifts — the shape `osm-enrich` arrived
 * at the hard way.
 */
import { GEO_AREA_CAP_M2, type CommonsGeoReport } from "./commons-geo";
import type { ConcordanceReport } from "./concordance";
import type { ContribReport } from "./contrib";
import { BEARING_TOLERANCE_DEG, KARTAVIEW_RADIUS_M, type KartaviewReport } from "./kartaview";
import type { GatedId } from "./identity";
import type { InputResult } from "./inputs";
import type { MediaReport, SkipReason } from "./media";
import type { MergeReport } from "./merge";
import type { NormalizeReport } from "./normalize";
import type { KeygenReport, PublishReport } from "./publish";
import type { PruneReport } from "./prune";
import type { ResolveReport } from "./resolve";
import type { NpsReport } from "./nps";
import type { RidbReport } from "./ridb";
import type { WikipediaReport } from "./wikipedia";
import type { GateReason } from "./store";
import type { VerifyReport } from "./verify";

/** `12041846868` → `12.0 GB`. Decimal units, matching what `ls -l --si` and download pages show. */
function humanBytes(bytes: number): string {
  const units = ["B", "kB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit += 1;
  }
  return `${unit === 0 ? value : value.toFixed(1)} ${units[unit]}`;
}

/**
 * Stage 0's report.
 *
 * Says nothing rather than nothing-at-all when there is nothing: an empty result is the state of a
 * build where no acquisition has happened yet, and it has to read as a *finding* — otherwise the
 * operator sees a clean exit and assumes the inputs were recorded.
 *
 * `via` is printed because the two paths mean different things about trust: an adopted record was
 * written by the step that actually read the bytes, a hashed one by Cartographer opening the file
 * itself.
 */
export function inputLines(results: readonly InputResult[]): string[] {
  if (results.length === 0) {
    return [
      "no build inputs recorded — nothing has been acquired yet.",
      "  Run the import first (it records what it consumed), or name an artifact",
      "  cartographer should read itself with --input <source>=<path>.",
    ];
  }
  return [
    `recorded ${results.length} build input${results.length === 1 ? "" : "s"}:`,
    ...results.map(
      (r) =>
        `  ${r.source}  ${r.artifact}  ${humanBytes(r.bytes)}  ${r.hash}` +
        `  [${r.via}${r.skipped ? ", unchanged" : ""}]`,
    ),
  ];
}

/**
 * The stage-1 report.
 *
 * The per-category breakdown is the point, not decoration: `apps/atlas/doc/spec/sources.md` §6 says
 * coverage has to be measured per category, because one global percentage hides a park pipeline
 * that works behind a `community` pipeline that doesn't. This is the first stage that can report
 * it.
 *
 * Dropped rows are stated plainly rather than warned about. At extract scale most rows classify to
 * nothing — the Lua filter is key-level — so a scary-sounding number here is the expected shape, and
 * dressing it as a problem would train the operator to ignore the line that matters.
 */
export function normalizeLines(report: NormalizeReport): string[] {
  // Derived, not carried: every row either stages or doesn't, so a second counter would only be a
  // second thing to keep consistent — including in the fixture a test writes by hand.
  const dropped = report.rowsRead - report.staged;
  const lines = [
    `done — ${report.staged} of ${report.rowsRead} rows staged ` +
      `(${dropped} matched no taxonomy entry, which is expected: the import filter is ` +
      `key-level and admits far more than the taxonomy classifies)`,
    `  ${report.withDescription} carry a description · ${report.withMedia} carry a photo reference ` +
      `· ${report.withConcordance} carry an upstream id to concord on`,
  ];
  const categories = Object.entries(report.byCategory).sort((a, b) => b[1] - a[1]);
  if (categories.length > 0) {
    const width = Math.max(...categories.map(([name]) => name.length));
    lines.push("staged by category:");
    for (const [name, count] of categories) {
      lines.push(`  ${name.padEnd(width)}  ${count}`);
    }
  }
  return lines;
}

/**
 * Stage 2a's report.
 *
 * `unanswered` is printed as an instruction, not a statistic. Those QIDs are deliberately unrecorded so
 * the next run asks again, and an operator who reads the line as "29,000 done, 400 have nothing" would
 * publish a volume missing every cross-reference those 400 carried.
 */
export function concordanceLines(report: ConcordanceReport): string[] {
  if (report.wanted === 0) {
    return [
      "concordance already covers every QID staging asserts — nothing to fetch.",
      "  Use --refresh to re-ask anyway (after changing the property set), or run normalize first",
      "  if staging is empty.",
    ];
  }
  const lines = [
    `done — ${report.fetched} entities and ${report.absent} confirmed absent, ` +
      `of ${report.wanted} QIDs asked about in ${report.requests} requests`,
  ];
  if (report.unanswered > 0) {
    lines.push(
      `  ${report.unanswered} QIDs went unanswered (throttled or lagging) and were NOT recorded —`,
      "  re-run to pick them up. Until then those places have no concordance, which is not the",
      "  same as having no cross-references.",
    );
  }
  return lines;
}

/**
 * The Wikipedia source's report.
 *
 * Three outcomes kept apart, because only one of them is ours to fix: a record that **names no article**
 * (nothing to ask), a title Wikipedia says has **no article** (asked, answered, recorded so we never
 * re-ask), and a title Wikipedia **never answered for** (unrecorded, so the next run asks again). The last
 * is printed as an instruction rather than a statistic — it is the same distinction `concordanceLines`
 * makes, and the reason the job this replaced kept its own negative cache.
 */
export function wikipediaLines(report: WikipediaReport): string[] {
  if (report.candidates === 0) {
    return [
      "no staged records name a Wikipedia article — nothing to resolve.",
      "  Run normalize first, and concordance if you expect QIDs to supply the sitelinks.",
    ];
  }
  const lines = [
    `done — ${report.staged} record(s) staged as \`wikipedia\` from ${report.titles} article(s) ` +
      `(${report.fetched} fetched, ${report.known} already known), over ${report.candidates} candidates`,
    `  ${report.fillsDescription} place(s) gain a description they had none for · ` +
      `${report.withPhoto} bring a photo reference`,
  ];

  if (report.unanswered > 0) {
    lines.push(
      `  ${report.unanswered} title(s) went UNANSWERED (throttled or lagging) and were NOT recorded —`,
      "  re-run to pick them up. Until then those places have no description *yet*, which is not the",
      "  same as having none.",
    );
  }
  if (report.absent > 0) {
    lines.push(`  ${report.absent} title(s) have no article — answered, recorded, never re-asked`);
  }
  if (report.noArticle > 0) {
    lines.push(`  ${report.noArticle} candidate(s) name no article at all — nothing to ask about`);
  }
  if (report.emptyArticle > 0) {
    lines.push(
      `  ${report.emptyArticle} article(s) exist but carry neither a summary nor a lead image`,
    );
  }
  return lines;
}

/**
 * The NPS source's report.
 *
 * The zero-candidates case names its likeliest cause by hand: the park-code claim landed in the
 * concordance with this stage, so a concordance built before it holds every entity **without** the
 * claim — and re-fetching is the operator's call (`concordance --refresh`), not something a source
 * stage may quietly spend ~600 requests doing.
 */
export function npsLines(report: NpsReport): string[] {
  if (report.candidates === 0) {
    return [
      `no staged records match a park unit (corpus: ${report.units} unit(s); ` +
        `${report.codes} entities claim a code).`,
      "  Run normalize and concordance first — and if concordance last ran before the nps stage",
      "  existed, run `cartographer concordance --refresh` so the Park Alpha Code claims land.",
    ];
  }
  const lines = [
    `done — ${report.staged} record(s) staged as \`nps\` from ${report.units} unit(s), ` +
      `over ${report.candidates} candidate(s) (${report.requests} listing request(s))`,
    `  ${report.fillsDescription} place(s) gain a description they had none for · ` +
      `${report.withPhoto} bring a public-domain photo reference`,
  ];
  if (report.noPdPhoto > 0) {
    lines.push(
      `  ${report.noPdPhoto} staged unit(s) have only third-party-credited images — no photo claimed`,
    );
  }
  if (report.unknownUnit > 0) {
    lines.push(
      `  ${report.unknownUnit} candidate(s) name a code the API no longer serves ` +
        "(former/affiliated units) — a fact about the data, nothing to fix",
    );
  }
  if (report.emptyUnit > 0) {
    lines.push(`  ${report.emptyUnit} unit(s) had nothing to contribute`);
  }
  return lines;
}

/** The ridb stage's operator summary — `npsLines`' sibling, with the text gate's effect visible. */
export function ridbLines(report: RidbReport): string[] {
  if (report.candidates === 0) {
    return [
      `no staged records name an RIDB facility (${report.claims} entities claim a facility id).`,
      "  Run normalize and concordance first — and if concordance last ran before the ridb stage",
      "  existed, run `cartographer concordance --refresh` so the P6747 claims land.",
    ];
  }
  const lines = [
    `done — ${report.staged} record(s) staged as \`ridb\` from ${report.facilities} facility(ies), ` +
      `over ${report.candidates} candidate(s) (${report.requests} request(s))`,
    `  ${report.fillsDescription} place(s) gain a description they had none for · ` +
      `${report.withPhoto} bring a federally-credited photo reference`,
  ];
  if (report.nonFederal > 0) {
    lines.push(
      `  ${report.nonFederal} staged facility(ies) are not federally managed — description withheld ` +
        "(no licence to publish under)",
    );
  }
  if (report.noPdPhoto > 0) {
    lines.push(
      `  ${report.noPdPhoto} staged facility(ies) have only non-federal-credited images — no photo claimed`,
    );
  }
  if (report.unknownFacility > 0) {
    lines.push(
      `  ${report.unknownFacility} candidate(s) name a facility the API no longer serves — ` +
        "delisted, a fact about the data",
    );
  }
  return lines;
}

/**
 * The commons-geo stage's report — the containment join's honesty lines: what was walked, what the
 * area cap excluded, and the two cache populations' three states.
 */
export function commonsGeoLines(report: CommonsGeoReport): string[] {
  const lines: string[] = [];
  if (report.loaded) {
    lines.push(
      `geo index loaded — ${report.loaded.rows} coordinate(s) kept, ` +
        `${report.loaded.skipped} dump row(s) dropped (other globes, unparseable coordinates)`,
    );
  }
  if (report.polygons === 0 && report.categories === 0) {
    return [
      ...lines,
      "no candidate polygons and no category references — run normalize first, and pass --dump",
      "  once so the geo index has something to contain.",
    ];
  }
  lines.push(
    `done — ${report.staged} record(s) staged as \`commons\` carrying ${report.refs} photo ref(s), ` +
      `from ${report.withHits} of ${report.polygons} polygon(s) with a contained file`,
    `  ${report.overCap} polygon(s) sit above the ${GEO_AREA_CAP_M2 / 1e6} km² cap and were not searched — ` +
      "past it, 'inside' stops meaning 'of the place'",
    `  categories: ${report.categories} referenced · ${report.categoriesFetched} fetched · ` +
      `${report.categoriesKnown} known · ${report.categoriesAbsent} absent`,
    `  page ids: ${report.pagesFetched} resolved · ${report.pagesKnown} known · ` +
      `${report.pagesAbsent} deleted or not files`,
  );
  const unanswered = report.categoriesUnanswered + report.pagesUnanswered;
  if (unanswered > 0) {
    lines.push(
      `  ${unanswered} lookup(s) went UNANSWERED and were NOT recorded — re-run to pick them up`,
    );
  }
  return lines;
}

/**
 * The kartaview stage's report — the sweep's resumability is the part an operator must be able to
 * see: a `--limit` run that left sequences unfetched has to say so, or a partial catalog reads as
 * thin coverage.
 */
export function kartaviewLines(report: KartaviewReport): string[] {
  const lines: string[] = [];
  if (report.listPages > 0) {
    lines.push(
      `swept — ${report.sequencesListed} sequence(s) listed, ${report.sequencesFetched} fetched ` +
        `this run (${report.photosFetched} photo(s))`,
    );
    if (report.tilesSkipped > 0) {
      lines.push(
        `  ${report.tilesSkipped} cell(s) declined by the API (probably empty — its timeout is how` +
          " it says so); the next --sweep re-asks them",
      );
    }
  }
  if (report.photosTotal === 0) {
    return [
      ...lines,
      "the street catalog is empty — run `kartaview --sweep` first (bound it with --limit N; it resumes).",
    ];
  }
  if (report.joinSkipped) {
    return [
      ...lines,
      `join skipped — ${report.sequencesTotal - report.sequencesHeld} sequence(s) still unfetched, ` +
        "and a partial join would be overwritten by the next drain. Keep running --sweep --limit N;",
      "  the final run (or any run without --sweep) joins what is held.",
    ];
  }
  lines.push(
    `done — ${report.staged} record(s) staged as \`kartaview\` carrying ${report.refs} photo ref(s), ` +
      `from ${report.withNearby} of ${report.candidates} record(s) with a frame within ${KARTAVIEW_RADIUS_M} m`,
    `  catalog: ${report.photosTotal} photo(s) across ${report.sequencesHeld}/${report.sequencesTotal} sequence(s)`,
    `  the aim gate keeps only frames whose heading points within ±${BEARING_TOLERANCE_DEG}° of the place`,
  );
  const remaining = report.sequencesTotal - report.sequencesHeld;
  if (remaining > 0) {
    lines.push(
      `  ${remaining} sequence(s) not yet fetched — re-run \`kartaview --sweep\` to continue; the join` +
        " above only saw what is held",
    );
  }
  return lines;
}

/** The contribution source's report — the join is what an operator is actually reading for. */
export function contribLines(report: ContribReport): string[] {
  const lines = [
    `${report.dryRun ? "dry-run" : "done"} — ${report.features} feature(s) read, ` +
      `${report.improvements + report.newPlaces} staged: ${report.improvements} improvement(s), ` +
      `${report.newPlaces} new place(s)`,
  ];
  if (report.photos > 0) lines.push(`  ${report.photos} photo(s) referenced`);
  if (report.unlicensedPhotos > 0) {
    lines.push(`  ${report.unlicensedPhotos} photo(s) skipped — no licence stated`);
  }
  // The number that says whether the export and the extract describe the same region. A handful is
  // a server whose coverage runs past this build's; a wall of them means the join found nothing and
  // every improvement quietly became a duplicate pin.
  if (report.unresolvedParent > 0) {
    lines.push(
      `  ${report.unresolvedParent} improvement(s) named a place this build does not hold — ` +
        "staged as new places",
    );
  }
  if (report.skipped > 0) lines.push(`  ${report.skipped} feature(s) refused (no contribution id)`);
  return lines;
}

/**
 * Why a reference yielded no photo, in the operator's words.
 *
 * A `Record` keyed by the reason so adding a skip reason is a **compile error** here rather than a line
 * that prints `undefined`. The wording separates *the data has no photo* from *we failed to get one*, which
 * is the distinction `osm-enrich`'s report established and the only one a re-run can act on.
 */
const NO_PHOTO: Record<SkipReason, string> = {
  notAsked:
    "no concordance row for the QID, or no listing for the category — never asked, NOT 'no photo'; " +
    "run concordance / commons-geo",
  noP18: "QID answered for, and has no image claim",
  noLead: "category answered for, and its listing yields nothing publishable",
  noLogo: "brand answered for, and has no logo claim (no P18 fallback — that is usually the HQ)",
  foreignHost: "an image URL on a host that states no per-file licence",
  unrankedSource: "claimed by a source with no rank in the photo order",
};

export function mediaLines(report: MediaReport): string[] {
  if (report.files === 0) {
    return [
      "no media references to chase — nothing staged claims a photo.",
      "  Run normalize first, or check that the extract carries image tags.",
    ];
  }
  const lines = [
    `done — ${report.fetched} file(s) fetched and stored (${humanBytes(report.bytes)}), ` +
      `${report.known} already known, of ${report.files} referenced`,
    `  ${report.placesWithMedia} place(s) now carry at least one photo`,
  ];

  // The recoverable bucket, first and unmissable: this is the number the whole stage exists to keep honest.
  if (report.unanswered > 0) {
    lines.push(
      `  ${report.unanswered} file(s) went UNANSWERED (throttled or lagging) and are scheduled, not`,
      "  recorded as absent. Run `media --retry` to pick them up — until then those places have no",
      "  photo *yet*, which is not the same as having none.",
    );
  }

  const refused = Object.entries(report.refused).sort((a, b) => b[1] - a[1]);
  if (refused.length > 0) {
    lines.push("  refused (an answer — not re-asked):");
    for (const [reason, count] of refused) lines.push(`    ${count} ${reason}`);
  }

  const skipped = (Object.entries(report.skipped) as [SkipReason, number][])
    .filter(([, count]) => count > 0)
    .sort((a, b) => b[1] - a[1]);
  if (skipped.length > 0) {
    lines.push("  references that yielded no file:");
    for (const [why, count] of skipped) lines.push(`    ${count} — ${NO_PHOTO[why]}`);
  }

  // Per category, because a single percentage hides a working pipeline behind a broken one — the number
  // `sources.md` calls "the metric that tells you which source to add next".
  const covered = report.byCategory.filter((row) => row.places > 0);
  if (covered.length > 0) {
    lines.push("  photo coverage by category:");
    for (const row of [...covered].sort(
      (a, b) => a.withMedia / a.places - b.withMedia / b.places,
    )) {
      const pct = ((row.withMedia / row.places) * 100).toFixed(1);
      lines.push(`    ${row.category.padEnd(16)} ${row.withMedia}/${row.places} (${pct}%)`);
    }
  }
  return lines;
}

/**
 * Why each gate reason refused an identifier, in the reviewer's words.
 *
 * A `Record` keyed by the reason, not a chain of `if`s: adding a gate reason is then a **compile error**
 * here rather than a line that prints the new reason as a span with `undefined` metres.
 */
const WHY: Record<GateReason, (entry: GatedId) => string> = {
  "not-a-place": () => "names an entity with no coordinates, so it is not an identity claim",
  span: (entry) => `records span ${entry.spanM} m`,
};

/**
 * Stage 2b's report.
 *
 * Three of these lines are **findings** rather than counters, and they read that way on purpose:
 *
 * - the gate's refusals, because a gate nobody can see is a silent policy — "these 54 cameras are 54
 *   places" is indistinguishable from "nothing shared an identifier" unless something says otherwise;
 * - QIDs with no concordance, because that is a stage that hasn't run, not a dataset without links;
 * - ineffective vetoes, because a human made a decision and it did nothing, and they should know.
 */
export function resolveLines(report: ResolveReport, gated: readonly GatedId[] = []): string[] {
  const lines = [
    `done — ${report.entities} entities from ${report.records} records ` +
      `(${report.minted} new, ${report.reused} kept their id, ${report.merged} merged)`,
    `  ${report.tier1Records} records share an identifier; ` +
      `${report.tier2Records} more join only via the concordance`,
  ];
  // Reported apart from the two tiers because it is not evidence of anything: these records joined by
  // naming the record they were built from.
  if (report.derivedRecords > 0) {
    lines.push(
      `  ${report.derivedRecords} more were derived from a record and joined whatever entity it did`,
    );
  }
  if (report.aliased > 0 || report.split > 0) {
    lines.push(
      `  ${report.aliased} ids retired into aliases · ${report.split} entities split ` +
        "(the larger part kept the id; the rest are new places, not replacements)",
    );
  }
  // Two facts, said separately: one is about entities this build, the other about rows the last build
  // left behind. Gluing them into one sentence read as though they were the same number.
  if (report.withdrawn.length > 0) {
    lines.push(
      `  ${report.withdrawn.length} entities hold no record any more — their ids are kept, never ` +
        "reused, and never turned into an alias",
    );
  }
  if (report.pruned > 0) {
    lines.push(`  ${report.pruned} memberships dropped: their staged record is gone`);
  }

  if (report.awaitingEvidence > 0) {
    lines.push(
      `${report.awaitingEvidence} identifiers have no concordance entry yet, so they could not be merged on.`,
      "  Run `cartographer concordance` — until then this is a build with the bridge switched off,",
      "  not a dataset whose places don't cross-reference.",
    );
  }

  if (gated.length > 0) {
    lines.push(
      `${gated.length} identifiers were refused as merge keys (they are still carried, and every one` +
        " is in ambiguous_ids):",
    );
    // Worst first — the ones that would have done the most damage are the ones worth eyeballing.
    for (const entry of [...gated].sort((a, b) => b.records - a.records).slice(0, 5)) {
      lines.push(`  ${entry.upstreamId}  ${entry.records} records — ${WHY[entry.reason](entry)}`);
    }
    if (gated.length > 5) lines.push(`  … and ${gated.length - 5} more`);
  }

  for (const veto of report.ineffectiveVetoes) {
    lines.push(
      `warning: the 'distinct' verdict on ${veto.a} / ${veto.b} changed nothing — still one place.`,
      veto.alsoVia.length > 0
        ? `  ${veto.a} also claims ${veto.alsoVia.join(", ")}, which reach the same place. ` +
            "Veto those too, or the verdict has no effect."
        : "  Something else in the graph connects them; the verdict has no effect as written.",
    );
  }
  return lines;
}

/**
 * The prune's report — and the two "kept" numbers are the point, not the deletion count.
 *
 * An operator running a destructive sweep needs to see what it decided **not** to touch, and by
 * whose authority: a run that reported only "removed 648" would look identical whether it had
 * protected the published volume or was about to make it unverifiable.
 */
export function pruneLines(report: PruneReport): string[] {
  const lines = [
    `${report.dryRun ? "dry-run" : "done"} — ${report.onDisk} blob(s) on disk: ` +
      `${report.removed} ${report.dryRun ? "would be removed" : "removed"} ` +
      `(${humanBytes(report.bytes)}), ` +
      `${report.keptByVolume} kept by a published version, ${report.keptByDatabase} still claimed`,
  ];
  if (report.versions.length > 0) {
    lines.push(`  versions protected: ${report.versions.join(", ")}`);
  } else {
    // Worth saying out loud rather than leaving as a silent zero: with no version on disk the only
    // thing standing between a blob and deletion is the database's claim.
    lines.push("  no published version on disk — the database's claim is the only protection");
  }
  if (!report.includeUnlinked) {
    lines.push("  photos with no place link were kept (pass --unlinked to sweep those too)");
  }
  if (report.strays > 0) {
    lines.push(`  ${report.strays} non-blob file(s) under media/ left alone`);
  }
  return lines;
}

/**
 * Stage 3's report.
 *
 * `credited` is the number worth printing even though it sounds like trivia: it is the only external
 * evidence that `OWNED_BY` works. A description whose credit was ranked separately would still count as a
 * description, so "how many places carry a credit" is what distinguishes a working licensing rule from a
 * silently broken one — and `verify` fails a credit with no description, closing the other direction.
 */
export function mergeLines(report: MergeReport): string[] {
  if (report.entities === 0) {
    return [
      "no entities hold members — nothing to merge.",
      "  Run `cartographer resolve` first: merging reads the entity graph, and an empty",
      "  graph is a stage that hasn't run rather than a dataset with no places.",
    ];
  }
  const lines = [
    `done — ${report.merged} places merged from ${report.entities} entities`,
    `  ${report.multiSource} places take fields from more than one source; ` +
      `${report.credited} carry a description credit`,
  ];
  if (report.unmergeable > 0) {
    lines.push(
      `  ${report.unmergeable} entities produced no place — no category or no point, so a consumer` +
        " would reject them",
    );
  }
  return lines;
}

/**
 * Stage 5's report.
 *
 * The clamp lines are **findings**. Stage 1 stores what the source said and this is the only stage that
 * shortens anything, so a truncated description that nobody counted is indistinguishable from a source
 * that was always that short — and the bytes are immutable once published.
 */
export function publishLines(report: PublishReport): string[] {
  const lines = [
    `done — ${report.volume}@${report.version} rev ${report.revision}: ` +
      `${report.places} places in ${report.cells} cells, ${humanBytes(report.bytes)}`,
    `  signed by ${report.publisher}`,
    `  manifest ${report.manifestHash}`,
    `  dictionary: ${report.dictionary.categories} categories, ` +
      `${report.dictionary.subcategories} subcategories, ${report.dictionary.credits} credits, ` +
      `${report.dictionary.sources} sources`,
  ];
  if (report.geometryCells > 0) {
    lines.push(`  ${report.geometryCells} cells also carry a geometry tile`);
  }
  if (report.media > 0) {
    lines.push(`  ${report.media} photos referenced, ${humanBytes(report.mediaBytes)} of media`);
  }
  // Why this volume holds fewer places (or photos) than the database does — see `PublishReport.withheld`.
  const { places, files, pairs } = report.withheld;
  if (places + files + pairs > 0) {
    lines.push(
      `  withheld by review: ${places} place(s), ${files} photo(s), ${pairs} photo-place link(s)`,
    );
  }
  // Should be zero. Non-zero says the crawl's records and the blob tree have parted company, which is a
  // real operator problem — those places silently lost their photos from this version onward.
  // The instruction is `media --retry` and **only** once the rows have actually been demoted: the crawl's
  // walk asks about nothing already `published`, so `--retry` is the one door in, and it is empty until
  // `demoteMissingBlobs` has opened it. A dry run finds the divergence and changes nothing, so it gets the
  // other half of the sentence — printing the same advice there would be a second no-op in the place an
  // operator diagnoses from. See `demoteMissingBlobs`.
  if (report.missingBlobs > 0) {
    lines.push(
      `  ${report.missingBlobs} photo reference(s) had no blob on disk and were dropped —`,
      "  media_files and <out>/media have diverged (check --out is the tree the crawl wrote to).",
      ...(report.demotedFiles > 0
        ? [
            `  ${report.demotedFiles} file(s) were put back on the retry ledger.`,
            "  Now run `cartographer media --retry` to refetch them, then publish again.",
          ]
        : [
            "  Nothing was demoted, so there is nothing for `media --retry` to pick up yet —",
            "  a real publish is what puts these files back on the ledger.",
          ]),
    );
  }

  const clamped = Object.entries(report.clamps).filter(([, n]) => n > 0);
  if (clamped.length > 0) {
    lines.push(
      "fields the publisher had to shorten or drop to fit the wire's limits:",
      ...clamped.map(([field, n]) => `  ${field}: ${n}`),
      "  Descriptions and names are truncated; URLs and over-large geometry are dropped,",
      "  because a shortened URL is wrong rather than shorter.",
    );
  }
  return lines;
}

/**
 * The keygen report — both outcomes end with the did, because the did is what the operator came for.
 *
 * The instruction points at where the did is confirmed (the console import preview): a key
 * whose public identity nobody wires up signs volumes no server will read, and this is the one moment
 * the operator is certainly looking.
 */
export function keygenLines(report: KeygenReport): string[] {
  if (!report.created) {
    return [
      `${report.path} already exists — refusing to overwrite a signing key.`,
      `  its public identity: ${report.did}`,
      "  Consumers pin that did, so rotating the key strands every volume it signed —",
      "  delete the file yourself if that is what you mean to do.",
    ];
  }
  return [
    `wrote ${report.path} (mode 600) — back it up; it cannot be regenerated.`,
    `  public identity: ${report.did}`,
    "  Server operators confirm this did on the admin console's import preview —",
    "  their first import pins it, and every later version must be signed by it.",
  ];
}

/**
 * Stage 6's report.
 *
 * Two things are said out loud that a green build would otherwise hide. **A skipped continuity check is
 * not a passed one** — without a previous version there is nothing to compare, and that has to read
 * differently from "no place was lost". And every failure is listed rather than counted, because the
 * operator's next action is to look one up.
 */
export function verifyLines(report: VerifyReport): string[] {
  const label = `${report.volume}@${report.version} rev ${report.revision}`;
  const lines = [
    report.failures.length === 0
      ? `done — ${label} verifies`
      : `FAILED — ${label}: ${report.failures.length} problem(s)`,
    `  ${report.found} places across ${report.cells} cells, ${report.aliases} aliases, ` +
      `signed by ${report.publisher}`,
  ];
  if (report.geometryTiles > 0) lines.push(`  ${report.geometryTiles} geometry tiles checked`);
  if (report.mediaSkipped) {
    // Said out loud, because "0 failures" beside a remote media base would otherwise read as a pass on
    // photos nothing looked at.
    lines.push(
      "media bytes were NOT checked — media.base is remote, and this reads the tree from disk.",
      "  The hashes in the tiles are still signed; nothing confirmed the files behind them exist.",
    );
  } else if (report.mediaChecked > 0) {
    lines.push(
      `  ${report.mediaChecked} media files re-hashed (${humanBytes(report.mediaBytes)}) — ` +
        "each one's bytes hash to the name the signed tile filed it under",
    );
  }

  if (report.continuity === "checked") {
    lines.push(`  place-id continuity checked against ${report.previousIds} previous ids`);
  } else {
    lines.push(
      "place-id continuity was NOT checked — no previous version was given.",
      "  Pass --previous <version>. A place that vanishes between versions is retired on every",
      "  server that imported the last one, taking its operator's edits with it, and this is the",
      "  only check that catches it.",
    );
  }

  for (const failure of report.failures) lines.push(`  ${failure.check}: ${failure.detail}`);
  return lines;
}
