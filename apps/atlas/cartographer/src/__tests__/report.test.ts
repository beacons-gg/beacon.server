import { describe, expect, it } from "vitest";
import type { GatedId } from "../identity";
import type { MediaReport } from "../media";
import {
  concordanceLines,
  inputLines,
  mediaLines,
  mergeLines,
  normalizeLines,
  publishLines,
  resolveLines,
  verifyLines,
} from "../report";
import type { ResolveReport } from "../resolve";

describe("inputLines", () => {
  it("names each artifact with a human size and its digest", () => {
    const lines = inputLines([
      {
        source: "osm",
        artifact: "us-west-260724.osm.pbf",
        hash: "A6Yrxg4DWGqLm_XKdKDPKRcoWTovmQXdLkbKxuAKWfQ",
        bytes: 3_373_438_358,
        mtimeMs: 0,
        via: "adopted",
        skipped: false,
      },
    ]);
    expect(lines[0]).toBe("recorded 1 build input:");
    expect(lines[1]).toContain("us-west-260724.osm.pbf");
    expect(lines[1]).toContain("3.4 GB");
    expect(lines[1]).toContain("[adopted]");
  });

  it("distinguishes how a record was arrived at, and whether anything was re-read", () => {
    // The two paths mean different things about trust: an adopted record was written by the step that
    // actually read the bytes; a hashed one by cartographer opening the file itself.
    const base = { source: "osm", artifact: "a.pbf", hash: "h", bytes: 12, mtimeMs: 0 } as const;
    expect(inputLines([{ ...base, via: "adopted", skipped: true }])[1]).toContain(
      "[adopted, unchanged]",
    );
    expect(inputLines([{ ...base, via: "hashed", skipped: false }])[1]).toContain("[hashed]");
  });

  it("reports an empty result as a finding, not as success", () => {
    // A clean exit with no output would let the operator believe the inputs were recorded.
    const lines = inputLines([]);
    expect(lines[0]).toContain("no build inputs recorded");
    expect(lines.join(" ")).toContain("Run the import first");
  });
});

describe("normalizeLines", () => {
  const report = {
    rowsRead: 862_992,
    staged: 47_101,
    withMedia: 7_092,
    withDescription: 18_700,
    withConcordance: 7_122,
    byCategory: { park: 21_949, nature: 8_733, community: 3_068 },
  };

  it("derives the drop count and states it as expected rather than as a problem", () => {
    const [headline] = normalizeLines(report);
    expect(headline).toContain("47101 of 862992 rows staged");
    expect(headline).toContain("815891 matched no taxonomy entry");
    expect(headline).toContain("expected");
  });

  it("breaks coverage down per category, largest first", () => {
    const lines = normalizeLines(report);
    const categories = lines.slice(lines.indexOf("staged by category:") + 1);
    expect(categories.map((l) => l.trim().split(/\s+/)[0])).toEqual([
      "park",
      "nature",
      "community",
    ]);
  });

  it("omits the category block when nothing staged", () => {
    const lines = normalizeLines({ ...report, staged: 0, byCategory: {} });
    expect(lines).toHaveLength(2);
  });
});

describe("concordanceLines", () => {
  const report = { wanted: 28_877, fetched: 28_400, absent: 77, unanswered: 0, requests: 578 };

  it("states what was learned, including that an entity does not exist", () => {
    const [headline] = concordanceLines(report);
    expect(headline).toContain("28400 entities and 77 confirmed absent");
    expect(headline).toContain("of 28877 QIDs");
  });

  /**
   * Unanswered QIDs are printed as an instruction, not a statistic. An operator who read them as "those
   * places have nothing" would publish a volume missing every cross-reference they carried.
   */
  it("tells the operator to re-run when a batch went unanswered", () => {
    const lines = concordanceLines({ ...report, unanswered: 400 }).join(" ");
    expect(lines).toContain("400 QIDs went unanswered");
    expect(lines).toContain("NOT recorded");
    expect(lines).toContain("re-run");
  });

  it("reads nothing-to-do as a finding rather than as a silent success", () => {
    const lines = concordanceLines({ ...report, wanted: 0 });
    expect(lines[0]).toContain("already covers every QID");
    expect(lines.join(" ")).toContain("--refresh");
  });
});

describe("resolveLines", () => {
  const report: ResolveReport = {
    records: 225_501,
    entities: 225_201,
    minted: 225_000,
    reused: 200,
    merged: 1,
    aliased: 1,
    split: 0,
    withdrawn: [],
    tier1Records: 600,
    tier2Records: 12,
    derivedRecords: 0,
    awaitingEvidence: 0,
    ineffectiveVetoes: [],
    pruned: 0,
  };

  it("separates what tier 1 did from what the concordance added", () => {
    const lines = resolveLines(report);
    expect(lines[0]).toContain("225201 entities from 225501 records");
    expect(lines[1]).toContain("600 records share an identifier");
    expect(lines[1]).toContain("12 more join only via the concordance");
  });

  /** Its own line, because a derived record is not a second source agreeing — see `joinedRecords`. */
  it("reports derived records apart from the two tiers", () => {
    const lines = resolveLines({ ...report, derivedRecords: 9_631 });
    expect(lines[1]).toContain("600 records share an identifier");
    expect(lines[2]).toContain("9631 more were derived from a record");
    // Absent entirely when nothing was derived, rather than printing a zero.
    expect(resolveLines(report).join(" ")).not.toContain("derived");
  });

  /** A gate nobody can see is a silent policy, so the worst refusals are named, not just counted. */
  it("names the refused identifiers, worst first, with the reason", () => {
    const gated: GatedId[] = [
      { upstreamId: "gnis:5", records: 2, spanM: 40_000, reason: "span" },
      { upstreamId: "wd:Q108485435", records: 54, reason: "not-a-place" },
    ];
    const lines = resolveLines(report, gated).join("\n");
    expect(lines).toContain("2 identifiers were refused");
    expect(lines).toContain("still carried");
    // 54 records beats 2, so Flock Safety is listed first whatever order it arrived in.
    expect(lines.indexOf("wd:Q108485435")).toBeLessThan(lines.indexOf("gnis:5"));
    expect(lines).toContain("no coordinates");
    expect(lines).toContain("span 40000 m");
  });

  it("says an unrun concordance is a switch that is off, not a dataset without links", () => {
    const lines = resolveLines({ ...report, awaitingEvidence: 28_877 }).join(" ");
    expect(lines).toContain("28877 identifiers have no concordance entry yet");
    expect(lines).toContain("cartographer concordance");
    expect(lines).toContain("not a dataset whose places don't cross-reference");
  });

  /**
   * A bare "that changed nothing" is a dead end. On the real extract two records sharing an NRHP number
   * usually share a QID too, so one veto leaves them merged — and the reviewer needs to know what else
   * to veto, not just that they failed.
   */
  it("turns an ineffective verdict into the next thing to do", () => {
    const lines = resolveLines({
      ...report,
      ineffectiveVetoes: [{ a: "record:osm/way/2", b: "nrhp:03000113", alsoVia: ["wd:Q5000469"] }],
    }).join(" ");
    expect(lines).toContain("changed nothing");
    expect(lines).toContain("also claims wd:Q5000469");
    expect(lines).toContain("Veto those too");
  });

  /** Withdrawals need saying out loud: a downstream server retires those places on its next import. */
  it("reports withdrawals with the promise that their ids are kept", () => {
    const lines = resolveLines({ ...report, withdrawn: ["01A", "01B"], pruned: 3 }).join(" ");
    expect(lines).toContain("2 entities hold no record any more");
    expect(lines).toContain("never reused");
  });

  it("stays quiet about the things that did not happen", () => {
    // Zero merges, zero splits, zero withdrawals, no vetoes: two lines, no noise to scroll past.
    expect(resolveLines({ ...report, aliased: 0, merged: 0 })).toHaveLength(2);
  });
});

describe("mergeLines", () => {
  const report = { entities: 10, merged: 9, unmergeable: 1, multiSource: 2, credited: 4 };

  it("names the credited count, which is the only outside evidence OWNED_BY works", () => {
    const lines = mergeLines(report).join(" ");
    expect(lines).toContain("9 places merged from 10 entities");
    expect(lines).toContain("4 carry a description credit");
  });

  it("says what produced no place, and why a consumer would have rejected it", () => {
    expect(mergeLines(report).join(" ")).toContain("no category or no point");
  });

  /** An empty graph is a stage that has not run, not a dataset with no places. */
  it("reads an empty result as a finding with the command to run", () => {
    const lines = mergeLines({ ...report, entities: 0, merged: 0 });
    expect(lines.join(" ")).toContain("cartographer resolve");
    expect(lines.length).toBeGreaterThan(1);
  });
});

describe("publishLines", () => {
  const report = {
    volume: "us-west",
    version: "2026-08",
    revision: 7,
    publisher: "did:key:z6Mk",
    places: 225084,
    cells: 15012,
    geometryCells: 900,
    bytes: 51_000_000,
    media: 0,
    mediaBytes: 0,
    missingBlobs: 0,
    demotedFiles: 0,
    withheld: { places: 0, files: 0, pairs: 0 },
    manifestHash: "sha256:abc",
    clamps: {
      description: 0,
      name: 0,
      altNames: 0,
      website: 0,
      wikipedia: 0,
      geometry: 0,
      media: 0,
    },
    dictionary: { categories: 14, subcategories: 60, credits: 2, sources: 1 },
  };

  it("leads with the published identity and what signed it", () => {
    const lines = publishLines(report).join(" ");
    expect(lines).toContain("us-west@2026-08 rev 7");
    expect(lines).toContain("225084 places in 15012 cells");
    expect(lines).toContain("51.0 MB");
    expect(lines).toContain("signed by did:key:z6Mk");
  });

  /**
   * A clamp nobody counted is indistinguishable from a source that was always that short — and the bytes
   * are immutable once published, so this is the last chance to notice.
   */
  it("reports clamps as a finding, and says which way each field goes", () => {
    const lines = publishLines({
      ...report,
      clamps: { ...report.clamps, description: 12, website: 3 },
    }).join(" ");
    expect(lines).toContain("description: 12");
    expect(lines).toContain("website: 3");
    expect(lines).toContain("a shortened URL is wrong rather than shorter");
  });

  it("says nothing about clamps when nothing was clamped", () => {
    expect(publishLines(report).join(" ")).not.toContain("shorten");
  });

  /**
   * A suppression makes the volume smaller than `merged_places`, and the completeness gate stays
   * silent about it by design — so the report is the only place that difference gets explained.
   */
  it("says what review withheld, and stays quiet when review withheld nothing", () => {
    const lines = publishLines({
      ...report,
      withheld: { places: 2, files: 5, pairs: 1 },
    }).join(" ");
    expect(lines).toContain("withheld by review: 2 place(s), 5 photo(s), 1 photo-place link(s)");
    expect(publishLines(report).join(" ")).not.toContain("withheld by review");
  });

  /**
   * `media --retry` is the only door into a lost blob — the crawl's walk asks about nothing already
   * `published` — so the advice is right only once the rows have been demoted, and must not be given when
   * they have not. Both halves are pinned, because the second is a no-op that already shipped once.
   */
  it("names --retry once files are demoted, and not before", () => {
    const demoted = publishLines({ ...report, missingBlobs: 500, demotedFiles: 222 }).join(" ");
    expect(demoted).toContain("500 photo reference(s) had no blob on disk");
    expect(demoted).toContain("222 file(s) were put back on the retry ledger");
    expect(demoted).toContain("Now run `cartographer media --retry`");

    // The dry-run shape: the finding stands and the door is still named — an operator should learn what it
    // is — but the *instruction* is withheld, because following it now would do nothing.
    const dry = publishLines({ ...report, missingBlobs: 500, demotedFiles: 0 }).join(" ");
    expect(dry).toContain("500 photo reference(s) had no blob on disk");
    expect(dry).toContain("Nothing was demoted");
    expect(dry).not.toContain("Now run `cartographer media --retry`");
  });
});

describe("verifyLines", () => {
  const report = {
    volume: "us-west",
    version: "2026-08",
    revision: 7,
    publisher: "did:key:z6Mk",
    claimed: 3,
    found: 3,
    cells: 2,
    geometryTiles: 1,
    aliases: 1,
    mediaChecked: 0,
    mediaBytes: 0,
    mediaSkipped: false,
    continuity: "checked" as const,
    previousIds: 4,
    failures: [],
  };

  it("says it verified, and against how many previous ids", () => {
    const lines = verifyLines(report).join(" ");
    expect(lines).toContain("verifies");
    expect(lines).toContain("continuity checked against 4 previous ids");
  });

  /**
   * The distinction this exists for: "the check passed" and "the check did not run" look identical in a
   * green build log, and only one of them means no place was lost.
   */
  it("reads a skipped continuity check as a finding, never as a pass", () => {
    // `previousIds` is *omitted*, not set to undefined — `exactOptionalPropertyTypes` treats those as
    // different things, and so does `canonicalJson`, which drops absent keys and rejects undefined ones.
    const { previousIds: _omitted, ...withoutPrevious } = report;
    const lines = verifyLines({ ...withoutPrevious, continuity: "no-previous" });
    const text = lines.join(" ");
    expect(text).toContain("was NOT checked");
    expect(text).toContain("--previous");
    expect(text).not.toContain("continuity checked against");
  });

  it("lists every failure rather than counting them, because the next action is to look one up", () => {
    const lines = verifyLines({
      ...report,
      failures: [
        { check: "hash", detail: "cells/c290b.json: advertised sha256:a, bytes hash to sha256:b" },
        { check: "continuity", detail: "1 place id(s) ... : 01K9" },
      ],
    }).join(" ");
    expect(lines).toContain("FAILED");
    expect(lines).toContain("2 problem(s)");
    expect(lines).toContain("cells/c290b.json");
    expect(lines).toContain("01K9");
  });
});

/**
 * Stage 4's report, which exists to keep one distinction visible: *the data has no photo* versus *we failed
 * to get one*. An operator who reads the second as the first publishes a volume missing every photo a
 * throttle deferred — the incident the whole stage was built to prevent.
 */
describe("mediaLines", () => {
  const report: MediaReport = {
    pages: 5,
    files: 46,
    fetched: 40,
    known: 6,
    refused: {},
    unanswered: 0,
    skipped: { notAsked: 0, noP18: 0, noLead: 0, noLogo: 0, foreignHost: 0, unrankedSource: 0 },
    placesWithMedia: 47,
    byCategory: [],
    bytes: 5_700_000,
  };

  it("leads with what it got, and separates fetched from already-known", () => {
    const lines = mediaLines(report).join("\n");
    expect(lines).toContain("40 file(s) fetched and stored (5.7 MB)");
    expect(lines).toContain("6 already known");
    expect(lines).toContain("47 place(s) now carry at least one photo");
  });

  /** The only bucket a re-run can fix, and it must read as an instruction rather than a statistic. */
  it("says an unanswered file is scheduled, not absent, and names the command", () => {
    const lines = mediaLines({ ...report, unanswered: 12 }).join("\n");
    expect(lines).toContain("12 file(s) went UNANSWERED");
    expect(lines).toMatch(/scheduled, not\s+recorded as absent/);
    expect(lines).toContain("media --retry");
  });

  /** A refusal is an answer. Printing it beside the unanswered count would make the two look alike. */
  it("groups refusals under wording that says they are answers", () => {
    const lines = mediaLines({ ...report, refused: { "http-404": 3, "no-license": 9 } }).join("\n");
    expect(lines).toContain("refused (an answer — not re-asked):");
    // Commonest first, so the operator reads the one worth acting on.
    expect(lines.indexOf("9 no-license")).toBeLessThan(lines.indexOf("3 http-404"));
  });

  /**
   * `notAsked` is the finding, not a statistic: it means the concordance has no row, which is absent
   * *knowledge*. Wording it like "no photo" is exactly the conflation this stage exists to prevent.
   */
  it("explains a missing concordance row as never-asked, not as no photo", () => {
    const lines = mediaLines({
      ...report,
      skipped: { ...report.skipped, notAsked: 213, noLead: 3 },
    }).join("\n");
    expect(lines).toContain("213 — no concordance row for the QID");
    expect(lines).toContain("NOT 'no photo'");
    expect(lines).toContain("3 — category answered for");
  });

  it("prints coverage per category, thinnest first, with a derived column width", () => {
    const lines = mediaLines({
      ...report,
      byCategory: [
        { category: "entertainment", places: 100, withMedia: 40 },
        { category: "park", places: 100, withMedia: 1 },
      ],
    });
    const table = lines.slice(lines.indexOf("  photo coverage by category:") + 1);
    // Thinnest first — the point of the view is which source to add next.
    expect(table[0]).toContain("park");
    expect(table[1]).toContain("entertainment");
    // Aligned to the longest name present, not to a magic 16 — asserted as the property (the counts line
    // up) rather than as a space count, which is what the width being derived actually buys.
    expect(table[0]).toContain("1/100 (1.0%)");
    expect(table[1]).toContain("40/100 (40.0%)");
    expect(table[0]!.indexOf("1/100")).toBe(table[1]!.indexOf("40/100"));
  });

  it("says plainly when nothing claims a photo at all", () => {
    expect(mediaLines({ ...report, files: 0 })[0]).toContain("no media references to chase");
  });
});
