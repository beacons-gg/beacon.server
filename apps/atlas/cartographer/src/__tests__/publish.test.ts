import { accountFromMnemonic } from "@beaconsgg/identity";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hashText } from "@beaconsgg/atlas-volume";
import { keygen, loadAccount, publish } from "../publish";
import type { PublishedMedia, Querier } from "../store";
import { verify } from "../verify";

/**
 * Stages 5 and 6 together, against a real directory — because the thing under test is a *tree of files*,
 * and a mocked filesystem would let a publish that never wrote a tile pass a verify that never read one.
 *
 * The keypair is fixed, so the signature is deterministic and the round trip is byte-comparable.
 */

const MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const ACCOUNT = accountFromMnemonic(MNEMONIC);
const NOW = "2026-08-06T12:00:00.000Z";

interface FakePlace {
  id: string;
  cell: string;
  fields: Record<string, unknown>;
  point: [number, number];
  geometry?: unknown;
  aliases?: string[];
  media?: PublishedMedia[];
}

/** A database holding exactly the places a test names. Unexpected SQL is a loud failure, never `[]`. */
function fakeDb(
  places: readonly FakePlace[],
  retired: readonly string[] = [],
): {
  db: Querier;
  seen: string[];
  /** Hashes the demote statement was asked about, so a test can assert it fired with the right ones. */
  demoted: string[][];
} {
  const seen: string[] = [];
  const demoted: string[][] = [];
  const db: Querier = {
    query(sql: string, params: unknown[] = []) {
      seen.push(sql.slice(0, 44));
      if (sql.startsWith("UPDATE media_files SET state = 'retryable'")) {
        const hashes = params[0] as string[];
        demoted.push([...hashes].sort());
        // `RETURNING 1` per row moved. The real statement matches on `state = 'published'`; here every hash
        // handed over belongs to one, so the pair for one file answers with two rows.
        return Promise.resolve({ rows: hashes.map(() => 1) });
      }
      if (sql.startsWith("SELECT (SELECT count(DISTINCT entity_id)")) {
        return Promise.resolve({ rows: [{ expected: places.length, merged: places.length }] });
      }
      if (sql.startsWith("SELECT DISTINCT s AS source")) {
        return Promise.resolve({ rows: [{ source: "osm" }] });
      }
      if (sql.startsWith("SELECT e.id")) {
        return Promise.resolve({
          rows: places.map((p) => ({
            id: p.id,
            upstream: [`osm:w/${p.id}`],
            aliases: p.aliases ?? [],
          })),
        });
      }
      if (sql.startsWith("INSERT INTO publish_log")) {
        return Promise.resolve({ rows: [{ revision: "7" }] });
      }
      if (sql.startsWith("SELECT entity_id, cell, fields")) {
        return Promise.resolve({
          rows: places.map((p) => ({
            entity_id: p.id,
            cell: p.cell,
            fields: p.fields,
            sources: ["osm"],
            point: JSON.stringify({ type: "Point", coordinates: p.point }),
            geometry: p.geometry ? JSON.stringify(p.geometry) : null,
            media: p.media ?? null,
          })),
        });
      }
      if (sql.startsWith("SELECT source, artifact, hash")) {
        return Promise.resolve({
          rows: [
            {
              source: "osm",
              artifact: "us-west.osm.pbf",
              hash: "abc",
              bytes: "10",
              mtime_ms: "1",
            },
          ],
        });
      }
      if (sql.startsWith("UPDATE publish_log")) return Promise.resolve({ rows: [] });
      // The review console: the ids a curator removed, and the counts publish reports.
      if (sql.startsWith("SELECT entity_id FROM place_decisions")) {
        return Promise.resolve({ rows: retired.map((id) => ({ entity_id: id })) });
      }
      if (sql.includes("FROM place_decisions")) {
        return Promise.resolve({ rows: [{ places: retired.length, files: 0, pairs: 0 }] });
      }
      throw new Error(`unexpected SQL: ${sql}`);
    },
  };
  return { db, seen, demoted };
}

const PLACES: FakePlace[] = [
  {
    id: "01K9Q7M4ZB8X2VNR5T0P0WR3AC",
    cell: "c290b",
    fields: {
      category: "landmark",
      name: "Mukilteo Lighthouse",
      description: "An operational navigation aid.",
      descriptionCredit: { license: "CC BY-SA 4.0", author: "Wikipedia contributors" },
    },
    point: [-122.30474, 47.94766],
    aliases: ["01K8H2A1YY4RM0QD7C6T9E1B5F"],
  },
  {
    id: "01K9Q7M4ZB8X2VNR5T0P0WR3AD",
    cell: "c290b",
    fields: { category: "park", subcategory: "park" },
    point: [-122.3, 47.95],
    geometry: {
      type: "Polygon",
      coordinates: [
        [
          [-122.3, 47.95],
          [-122.29, 47.95],
          [-122.29, 47.96],
          [-122.3, 47.95],
        ],
      ],
    },
  },
  {
    id: "01K9Q7M4ZB8X2VNR5T0P0WR3AE",
    cell: "c29d5",
    fields: { category: "nature" },
    point: [-121.5, 48.2],
  },
];

let root: string;
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "cartographer-volume-"));
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

/**
 * One publish against a database holding exactly these places.
 *
 * Returns the fake's observations beside the report — the tests that check what publish *did to the database*
 * need `seen`/`demoted`, and reaching for them was what had four copies of this options literal in one file.
 */
const publishTo = async (
  dir: string,
  places: readonly FakePlace[],
  over: { version?: string; dryRun?: boolean; retired?: readonly string[] } = {},
) => {
  const { db, seen, demoted } = fakeDb(places, over.retired ?? []);
  const report = await publish(db, {
    volume: "us-west",
    version: over.version ?? "2026-08",
    outDir: dir,
    dryRun: over.dryRun ?? false,
    account: ACCOUNT,
    now: () => NOW,
    log: () => {},
  });
  return { report, seen, demoted };
};

describe("publish writes a tree a foreign consumer can verify", () => {
  it("publishes, and the volume verifies end to end", async () => {
    const dir = join(root, "clean");
    const { report } = await publishTo(dir, PLACES);

    expect(report.places).toBe(3);
    expect(report.cells).toBe(2);
    expect(report.geometryCells).toBe(1);
    expect(report.revision).toBe(7);
    expect(report.publisher).toBe(ACCOUNT.did);

    const verified = await verify({ dir: join(dir, "2026-08"), log: () => {} });
    expect(verified.failures).toEqual([]);
    expect(verified.found).toBe(3);
    expect(verified.aliases).toBe(1);
    // No previous version was named, so the check did not run — and must not read as though it passed.
    expect(verified.continuity).toBe("no-previous");
  });

  /** `latest.json` is the only mutable file, and it must point at what was just written (§1). */
  it("writes latest.json pointing at the version", async () => {
    const dir = join(root, "latest");
    await publishTo(dir, PLACES);
    const latest = JSON.parse(await readFile(join(dir, "latest.json"), "utf8")) as {
      version: string;
      manifest: string;
    };
    expect(latest).toEqual({ version: "2026-08", manifest: "2026-08/manifest.json" });
  });

  /**
   * The property that proves nothing non-deterministic reached the artifact. It also matters downstream:
   * the server's refresh no-op compares canonical JSON, so unstable output makes every re-import rewrite
   * the whole dataset.
   */
  it("is byte-identical across two runs, signature included", async () => {
    const a = join(root, "idem-a");
    const b = join(root, "idem-b");
    await publishTo(a, PLACES);
    await publishTo(b, PLACES);
    for (const path of ["2026-08/manifest.json", "2026-08/index.json", "2026-08/dict.json"]) {
      expect(await readFile(join(a, path), "utf8")).toBe(await readFile(join(b, path), "utf8"));
    }
  });

  it("hashes with sha256 and names the algorithm in the string", async () => {
    const dir = join(root, "hashes");
    const { report } = await publishTo(dir, PLACES);
    expect(report.manifestHash).toMatch(/^sha256:[A-Za-z0-9_-]+$/);

    // Every hash in the tree is over the bytes on disk, which is what makes the signature cover the whole
    // volume rather than just the manifest.
    const manifest = JSON.parse(await readFile(join(dir, "2026-08/manifest.json"), "utf8")) as {
      index: { hash: string };
    };
    const indexText = await readFile(join(dir, "2026-08/index.json"), "utf8");
    expect(hashText(indexText)).toBe(manifest.index.hash);
  });

  it("refuses to publish an incomplete merge", async () => {
    const db: Querier = {
      query(sql: string) {
        if (sql.startsWith("SELECT (SELECT count(DISTINCT entity_id)")) {
          return Promise.resolve({ rows: [{ expected: 100, merged: 60 }] });
        }
        if (sql.includes("FROM place_decisions")) {
          return Promise.resolve({ rows: [{ places: 0, files: 0, pairs: 0 }] });
        }
        throw new Error(`unexpected SQL: ${sql}`);
      },
    };
    await expect(
      publish(db, {
        volume: "us-west",
        version: "2026-08",
        outDir: join(root, "never"),
        dryRun: false,
        account: ACCOUNT,
        now: () => NOW,
        log: () => {},
      }),
    ).rejects.toThrow(/merge is incomplete: 60 merged places for 100 entities \(40 missing\)/);
  });

  it("writes nothing on --dry-run", async () => {
    const dir = join(root, "dry");
    const { report, seen } = await publishTo(dir, PLACES, { dryRun: true });
    expect(report.places).toBe(3);
    await expect(readFile(join(dir, "latest.json"), "utf8")).rejects.toThrow();
    // No revision claimed either: a dry run must not consume a number the real publish would then skip.
    expect(seen.some((s) => s.startsWith("INSERT INTO publish_log"))).toBe(false);
  });

  /**
   * A lost `media/` directory: the build database lives in a container volume and the blobs on a host bind
   * mount, so one `rm -rf` parts them. See `demoteMissingBlobs` for why publish is what repairs it.
   */
  const withPhoto: FakePlace[] = [
    {
      ...PLACES[0]!,
      media: [
        {
          thumbHash: "sha256:AAAAthumb",
          fullHash: "sha256:AAAAfull",
          bytes: 1234,
          license: "CC BY-SA 4.0",
          source: "wikipedia",
        },
      ],
    },
  ];

  it("puts a file back on the retry ledger when its blob is gone", async () => {
    const dir = join(root, "lostblobs");
    const { report, demoted } = await publishTo(dir, withPhoto);

    // Both halves of the pair are missing, and both are counted: `missingBlobs` measures references.
    expect(report.missingBlobs).toBe(2);
    expect(report.demotedFiles).toBe(2);
    // Distinct hashes, once each — a logo on 200 places must not issue 400 statements.
    expect(demoted).toEqual([["sha256:AAAAfull", "sha256:AAAAthumb"]]);

    // And the volume is still valid, carrying no photo rather than a hash pointing at nothing.
    const tile = JSON.parse(
      await readFile(join(dir, "2026-08", "cells", "c290b.json"), "utf8"),
    ) as {
      places: { media?: unknown }[];
    };
    expect(tile.places[0]).not.toHaveProperty("media");
    expect(report.media).toBe(0);
  });

  /**
   * A dry run finds the divergence and repairs nothing, which is the case that made the *corrected* advice
   * wrong a second time: `publishLines` must not send an operator to `media --retry` when the ledger it reads
   * is still empty. Diagnosing with `--dry-run` is exactly when someone would look.
   */
  it("demotes nothing on --dry-run, and says so rather than naming --retry", async () => {
    const { report, demoted } = await publishTo(join(root, "lostblobs-dry"), withPhoto, {
      dryRun: true,
    });
    expect(demoted).toEqual([]);
    expect(report.missingBlobs).toBe(2);
    expect(report.demotedFiles).toBe(0);
  });

  /** A publish that demoted a healthy file would put a working photo back in the crawl queue every run. */
  it("demotes nothing when every referenced blob is present", async () => {
    const { report, demoted } = await publishTo(join(root, "clean-nodemote"), PLACES, {
      version: "2026-09",
    });
    expect(report.missingBlobs).toBe(0);
    expect(report.demotedFiles).toBe(0);
    expect(demoted).toEqual([]);
  });
});

describe("verify catches what it exists to catch", () => {
  /**
   * The assertion that protects every downstream operator. A place that stops appearing is retired by the
   * consumer's scope-aware sweep, taking that operator's edits and its players' contributions with it —
   * so this must fail a build, and a test that never watched it fail has not tested it.
   */
  it("fails when a place id from the previous version is neither live nor aliased", async () => {
    const before = join(root, "continuity-v1");
    const after = join(root, "continuity-v2");
    await publishTo(before, PLACES, { version: "2026-08" });
    await publishTo(after, PLACES.slice(0, 2), { version: "2026-09" });

    const report = await verify({
      dir: join(after, "2026-09"),
      previousDir: join(before, "2026-08"),
      log: () => {},
    });
    expect(report.continuity).toBe("checked");
    expect(report.failures.map((f) => f.check)).toContain("continuity");
    expect(report.failures.find((f) => f.check === "continuity")?.detail).toContain(
      "01K9Q7M4ZB8X2VNR5T0P0WR3AE",
    );
  });

  /**
   * The review console's removals travel in the manifest for exactly this: `verify` reads what a
   * foreign consumer reads and cannot ask the build database, so without the `retired` list the first
   * publish after a curator removes a place fails the build for doing what it was told.
   */
  it("passes continuity when a dropped place is named in the manifest's retired list", async () => {
    const before = join(root, "retired-v1");
    const after = join(root, "retired-v2");
    await publishTo(before, PLACES, { version: "2026-08" });
    await publishTo(after, PLACES.slice(0, 2), {
      version: "2026-09",
      retired: ["01K9Q7M4ZB8X2VNR5T0P0WR3AE"],
    });

    const report = await verify({
      dir: join(after, "2026-09"),
      previousDir: join(before, "2026-08"),
      log: () => {},
    });
    expect(report.continuity).toBe("checked");
    expect(report.failures).toEqual([]);
  });

  it("passes continuity when a dropped place was merged away into an alias", async () => {
    const before = join(root, "merged-v1");
    const after = join(root, "merged-v2");
    await publishTo(before, PLACES, { version: "2026-08" });
    // The third place merged into the first, which now lists it as an alias.
    const merged: FakePlace[] = [
      { ...PLACES[0]!, aliases: [...(PLACES[0]!.aliases ?? []), PLACES[2]!.id] },
      PLACES[1]!,
    ];
    await publishTo(after, merged, { version: "2026-09" });

    const report = await verify({
      dir: join(after, "2026-09"),
      previousDir: join(before, "2026-08"),
      log: () => {},
    });
    expect(report.failures).toEqual([]);
  });

  it("detects a tampered tile", async () => {
    const dir = join(root, "tampered");
    await publishTo(dir, PLACES);
    const tile = join(dir, "2026-08/cells/c290b.json");
    const text = await readFile(tile, "utf8");
    await writeFile(tile, text.replace("Mukilteo Lighthouse", "Somewhere Else"), "utf8");

    const report = await verify({ dir: join(dir, "2026-08"), log: () => {} });
    expect(report.failures.map((f) => f.check)).toContain("hash");
  });

  it("detects a tampered manifest", async () => {
    const dir = join(root, "tampered-manifest");
    await publishTo(dir, PLACES);
    const path = join(dir, "2026-08/manifest.json");
    const manifest = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    manifest["places"] = 999;
    await writeFile(path, JSON.stringify(manifest), "utf8");

    const report = await verify({ dir: join(dir, "2026-08"), log: () => {} });
    expect(report.failures.map((f) => f.check)).toContain("signature");
  });

  /** A place outside its own cell is one no consumer will ever fetch — partial import would just lose it. */
  it("detects a place filed under the wrong cell", async () => {
    const dir = join(root, "wrong-cell");
    await publishTo(dir, [{ ...PLACES[0]!, cell: "c29d5" }]);
    const report = await verify({ dir: join(dir, "2026-08"), log: () => {} });
    expect(report.failures.map((f) => f.check)).toContain("cell");
  });
});

describe("loadAccount", () => {
  it("refuses when no key file is configured — there is no unsigned mode", () => {
    expect(() => loadAccount({})).toThrow(/CARTOGRAPHER_KEY_FILE is not set/);
  });

  /** A group- or world-readable signing key is a leak, and silently trusting it defeats the point. */
  it("refuses a key file anyone but the owner can read", async () => {
    const path = join(root, "loose.key");
    await writeFile(path, MNEMONIC, "utf8");
    await chmod(path, 0o644);
    expect(() => loadAccount({ CARTOGRAPHER_KEY_FILE: path })).toThrow(/insecure permissions 644/);
  });

  it("loads the same account from the same phrase, so a volume keeps one publisher identity", async () => {
    const path = join(root, "good.key");
    await writeFile(path, `${MNEMONIC}\n`, "utf8");
    await chmod(path, 0o600);
    expect(loadAccount({ CARTOGRAPHER_KEY_FILE: path }).did).toBe(ACCOUNT.did);
  });

  it("refuses an empty key file rather than inventing an identity", async () => {
    const path = join(root, "empty.key");
    await writeFile(path, "   \n", "utf8");
    await chmod(path, 0o600);
    expect(() => loadAccount({ CARTOGRAPHER_KEY_FILE: path })).toThrow(/key file is empty/);
  });
});

describe("keygen", () => {
  it("writes a key loadAccount accepts, owner-only", async () => {
    const path = join(root, "publisher.key");
    const report = keygen({}, { file: path });
    expect(report.created).toBe(true);

    // The round trip is the point: what keygen writes, publish reads — same did, no chmod needed.
    expect(loadAccount({ CARTOGRAPHER_KEY_FILE: path }).did).toBe(report.did);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  /** An overwrite strands every volume the old key signed; the refusal doubles as "what is my did?". */
  it("refuses an existing file and reports its did instead", () => {
    const path = join(root, "existing.key");
    const first = keygen({}, { file: path });
    const second = keygen({}, { file: path });
    expect(second).toEqual({ path, did: first.did, created: false });
  });

  /** A typo'd parent is ENOENT, never a silently materialized tree the operator's backup then misses. */
  it("does not create missing parent directories", () => {
    expect(() => keygen({}, { file: join(root, "no-such-dir", "k.key") })).toThrow(/ENOENT/);
  });

  it("takes the path from CARTOGRAPHER_KEY_FILE when --file is not given, and refuses neither", () => {
    const path = join(root, "from-env.key");
    expect(keygen({ CARTOGRAPHER_KEY_FILE: path }, {}).created).toBe(true);
    expect(() => keygen({}, {})).toThrow(/keygen needs --file/);
  });
});
