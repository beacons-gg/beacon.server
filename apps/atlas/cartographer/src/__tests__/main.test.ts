import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { parseArgs, runInputs } from "../main";
import type { Querier } from "../store";

describe("parseArgs", () => {
  it("requires a stage", () => {
    expect(() => parseArgs([])).toThrow(/expected a stage/);
    expect(() => parseArgs(["summarize"])).toThrow(/expected a stage/);
  });

  it("parses repeated --input, splitting on the first = so a path may contain one", () => {
    const flags = parseArgs([
      "inputs",
      "--input",
      "osm=/data/a.osm.pbf",
      "--input",
      "gnis=/data/odd=name.zip",
    ]);
    // Narrowed on the tag, which is the union's whole point: `flags.inputs` does not typecheck until
    // the stage is known, so no caller can read a field the other stage doesn't have.
    expect(flags.stage).toBe("inputs");
    expect(flags.stage === "inputs" && flags.inputs).toEqual([
      { source: "osm", path: "/data/a.osm.pbf" },
      { source: "gnis", path: "/data/odd=name.zip" },
    ]);
  });

  it("rejects an --input with no source or no path", () => {
    expect(() => parseArgs(["inputs", "--input", "/data/a.pbf"])).toThrow(/needs <source>=<path>/);
    expect(() => parseArgs(["inputs", "--input", "osm="])).toThrow(/needs <source>=<path>/);
  });

  it("accepts bare `inputs` — adoption is the normal case, --input the exception", () => {
    // The OSM extract is named to `osm-import`, the command that reads it. Requiring `--input` here was
    // the flaw: two commands naming the same artifact with nothing checking they agreed.
    expect(parseArgs(["inputs"])).toEqual({ stage: "inputs", inputs: [], force: false });
  });

  it("defaults normalize to no row budget", () => {
    expect(parseArgs(["normalize"])).toMatchObject({
      limit: Number.POSITIVE_INFINITY,
      dryRun: false,
    });
  });

  it("parses the two stage-2 subcommands", () => {
    expect(parseArgs(["concordance", "--refresh"])).toEqual({
      stage: "concordance",
      limit: Number.POSITIVE_INFINITY,
      refresh: true,
      dryRun: false,
    });
    expect(parseArgs(["resolve", "--dry-run"])).toEqual({ stage: "resolve", dryRun: true });
  });

  /**
   * Identity is global: a component is only correct when every record sharing an identifier is in view,
   * so a bounded pass produces *wrong* entities — and mints ids for them, which is the one mistake here
   * that cannot be taken back. Being obeyed quietly would be the worst outcome, so it is an error.
   */
  it("refuses --limit on resolve, and says which stage owns it", () => {
    expect(() => parseArgs(["resolve", "--limit", "100"])).toThrow(
      /--limit belongs to the normalize stage/,
    );
  });

  it("refuses an unknown flag rather than ignoring it", () => {
    expect(() => parseArgs(["normalize", "--dryrun"])).toThrow(/unknown argument/);
    expect(() => parseArgs(["normalize", "--limit", "0"])).toThrow(/positive integer/);
  });

  /** A verdict is permanent and `decided_by` is its audit trail — no anonymous mode, like the UA rule. */
  it("requires review to name its reviewer, and validates the port", () => {
    expect(parseArgs(["review", "--reviewer", "alice"])).toEqual({
      stage: "review",
      port: 3200,
      reviewer: "alice",
      out: "/out", // the Media tab serves thumbs from the crawl's output tree
    });
    expect(parseArgs(["review", "--reviewer", "alice", "--port", "4000"])).toMatchObject({
      port: 4000,
    });
    expect(() => parseArgs(["review"])).toThrow(/--reviewer/);
    expect(() => parseArgs(["review", "--reviewer", "alice", "--port", "0"])).toThrow(/port/);
    expect(() => parseArgs(["review", "--reviewer", "alice", "--dry-run"])).toThrow(
      /belongs to the normalize stage/,
    );
  });

  /**
   * The media stage takes **both** recovery flags. Without `--refresh` in `STAGE_FLAGS` the parser rejects it
   * outright, so this is where that wiring is pinned; `MediaFlags` documents which door costs what.
   */
  it("gives media both --retry and --refresh", () => {
    expect(parseArgs(["media", "--refresh"])).toMatchObject({ retry: false, refresh: true });
    expect(parseArgs(["media", "--retry"])).toMatchObject({ retry: true, refresh: false });
  });

  it("parses upload, normalizing the key prefix and leaving it absent for the env default", () => {
    expect(parseArgs(["upload", "--prefix", "/us-west/", "--dry-run"], "/out")).toEqual({
      stage: "upload",
      out: "/out",
      prefix: "us-west",
      dryRun: true,
    });
    // No flag → no key, so main can fall back to CARTOGRAPHER_S3_PREFIX.
    expect(parseArgs(["upload"], "/out")).toEqual({ stage: "upload", out: "/out", dryRun: false });
  });

  it("parses keygen, whose only flag is the file", () => {
    expect(parseArgs(["keygen"])).toEqual({ stage: "keygen" });
    expect(parseArgs(["keygen", "--file", "/k/publisher.key"])).toEqual({
      stage: "keygen",
      file: "/k/publisher.key",
    });
  });

  /**
   * `--limit` is permitted here and refused by `resolve`, and the asymmetry is the design: merging one
   * entity needs only that entity's records, so a bound produces fewer places rather than wrong ones.
   */
  it("allows --limit on merge, which resolve refuses", () => {
    expect(parseArgs(["merge", "--limit", "500"])).toEqual({
      stage: "merge",
      limit: 500,
      dryRun: false,
    });
  });

  /** A published version is immutable, so its identity is stated rather than inferred from a clock. */
  it("requires publish to name its volume and version", () => {
    expect(() => parseArgs(["publish"])).toThrow(/needs --volume and --version/);
    expect(() => parseArgs(["publish", "--volume", "us-west"])).toThrow(
      /needs --volume and --version/,
    );
    expect(
      parseArgs(["publish", "--volume", "us-west", "--version", "2026-08", "--out", "/v"]),
    ).toEqual({
      stage: "publish",
      volume: "us-west",
      version: "2026-08",
      out: "/v",
      dryRun: false,
    });
  });

  /**
   * A value-taking flag must not swallow the next flag as its value. `--version --dry-run` used to give a
   * volume literally versioned `--dry-run`, published, immutable, and wrong.
   */
  it("refuses a value-taking flag whose value is another flag", () => {
    expect(() => parseArgs(["publish", "--volume", "us-west", "--version", "--dry-run"])).toThrow(
      /--version needs a value/,
    );
    expect(() => parseArgs(["verify", "--previous"])).toThrow(/--previous needs a value/);
  });

  it("lets verify default to whatever latest.json points at", () => {
    expect(parseArgs(["verify", "--out", "/v"])).toEqual({ stage: "verify", out: "/v" });
    expect(parseArgs(["verify", "--out", "/v", "--previous", "2026-07"])).toEqual({
      stage: "verify",
      out: "/v",
      previous: "2026-07",
    });
  });

  it("refuses a flag that belongs to the other stage, and says which", () => {
    // `inputs --dry-run` used to parse fine and write anyway — the exact failure the unknown-flag rule
    // exists to prevent, waved through because the flag was known, just not here.
    expect(() => parseArgs(["inputs", "--input", "osm=/a.pbf", "--dry-run"])).toThrow(
      /--dry-run belongs to the normalize stage/,
    );
    expect(() => parseArgs(["normalize", "--force"])).toThrow(
      /--force belongs to the inputs stage/,
    );
    expect(() => parseArgs(["normalize", "--input", "osm=/a.pbf"])).toThrow(
      /--input belongs to the inputs stage/,
    );
    expect(() => parseArgs(["concordance", "--retry"])).toThrow(/--retry belongs to the media/);
  });
});

/**
 * The rule that turns "whoever reads the file records it" from a convention into a mechanism.
 *
 * Without it, `--input osm=<path>` for an artifact the import already recorded overwrites that record
 * through `ON CONFLICT DO UPDATE` — last writer wins, no comparison, no warning. That is the original
 * defect, and it stayed reachable by anyone naming the extract here out of habit.
 */
describe("runInputs — the acquiring step's record is authoritative", () => {
  let dir = "";
  let file = "";
  const NOW = "2026-08-05T12:00:00.000Z";

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "cartographer-authority-"));
    await mkdir(join(dir, "state"), { recursive: true });
    file = join(dir, "us-west.osm.pbf");
    await writeFile(file, "cartographer");
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const acquired = async (body: string): Promise<void> => {
    await writeFile(
      join(dir, "state", "osm.input.json"),
      JSON.stringify({
        source: "osm",
        artifact: "us-west.osm.pbf",
        sha256: createHash("sha256").update(body).digest("hex"),
        bytes: body.length,
        mtimeMs: 1_784_942_874_000,
      }),
    );
  };

  /** Accepts every statement stage 0 issues and holds `build_inputs` in a Map. */
  function fakeDb() {
    const rows = new Map<string, { hash: string; bytes: string; mtime_ms: string }>();
    const writes: unknown[][] = [];
    const db: Querier = {
      query(sql: string, params: unknown[] = []) {
        if (sql.startsWith("CREATE")) return Promise.resolve({ rows: [] });
        if (sql.startsWith("SELECT")) {
          const row = rows.get(`${params[0] as string}/${params[1] as string}`);
          return Promise.resolve({
            rows: row ? [{ source: params[0], artifact: params[1], ...row }] : [],
          });
        }
        if (sql.startsWith("INSERT INTO build_inputs")) {
          writes.push(params);
          const [source, artifact, hash, bytes, mtimeMs] = params as [
            string,
            string,
            string,
            number,
            number,
          ];
          rows.set(`${source}/${artifact}`, {
            hash,
            bytes: String(bytes),
            mtime_ms: String(mtimeMs),
          });
          return Promise.resolve({ rows: [] });
        }
        throw new Error(`unexpected SQL: ${sql}`);
      },
    };
    return { db, writes };
  }

  const flags = { stage: "inputs", inputs: [{ source: "osm", path: "" }], force: false } as const;

  it("fails loudly when an explicit --input disagrees with what was acquired", async () => {
    // The file on disk is not the one that was consumed. A manifest must never be built on that.
    const { db } = fakeDb();
    await acquired("something else entirely");
    await expect(
      runInputs(
        db,
        { ...flags, inputs: [{ source: "osm", path: file }] },
        {
          now: NOW,
          stateDir: join(dir, "state"),
          log: () => {},
        },
      ),
    ).rejects.toThrow(/does not match what was acquired/);
  });

  it("accepts an explicit --input that agrees, without duplicating the record", async () => {
    const { db } = fakeDb();
    await acquired("cartographer");
    const results = await runInputs(
      db,
      { ...flags, inputs: [{ source: "osm", path: file }] },
      {
        now: NOW,
        stateDir: join(dir, "state"),
        log: () => {},
      },
    );
    // One entry, the adopted one — naming it again is redundant, not an error.
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ via: "adopted" });
  });

  it("adopts and hashes side by side, labelling each by how it was arrived at", async () => {
    // The GNIS names file: cartographer opens it itself, so naming it here is naming it to its reader.
    // The OSM extract alongside it is adopted, never named. Both end up in one report.
    const { db } = fakeDb();
    await acquired("cartographer");
    const gnis = join(dir, "names.zip");
    await writeFile(gnis, "cartographer");
    const results = await runInputs(
      db,
      { ...flags, inputs: [{ source: "gnis", path: gnis }] },
      {
        now: NOW,
        stateDir: join(dir, "state"),
        log: () => {},
      },
    );
    expect(results.map((r) => [r.source, r.via])).toEqual([
      ["osm", "adopted"],
      ["gnis", "hashed"],
    ]);
  });
});
