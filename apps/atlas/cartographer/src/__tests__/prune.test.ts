import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { blobPath } from "@beaconsgg/atlas-volume";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prune } from "../prune";
import type { Querier } from "../store";

/**
 * The blob sweep, and every test here is about something it must **not** delete.
 *
 * A prune is the one stage that destroys work: a wrong keep costs disk, a wrong delete costs a
 * re-download at best and an unverifiable published version at worst. So the deletion count is the
 * least interesting assertion in this file.
 */

const A = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const B = "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
const C = "CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC";

let out: string;
beforeEach(async () => {
  out = await mkdtemp(join(tmpdir(), "cartographer-prune-"));
});
afterEach(async () => {
  await rm(out, { recursive: true, force: true });
});

/**
 * Put a blob exactly where the code under test will look for it.
 *
 * Through `blobPath`, not a hand-built path: the sharding rule is the format package's, and a
 * fixture that restated it could only agree with the implementation by luck.
 */
async function blob(hash: string, bytes = 1000): Promise<void> {
  const path = blobPath(out, hash);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, Buffer.alloc(bytes));
}

/** A published version that references `hashes` from its one cell tile. */
async function version(name: string, hashes: readonly string[]): Promise<void> {
  const dir = join(out, name, "cells");
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(out, name, "manifest.json"),
    JSON.stringify({ mediaProfile: { format: "image/webp" } }),
  );
  await writeFile(join(out, name, "index.json"), JSON.stringify({ cells: [{ cell: "9q8yy" }] }));
  await writeFile(
    join(dir, "9q8yy.json"),
    JSON.stringify({
      places: [{ media: hashes.map((h) => ({ hash: `sha256:${h}` })) }],
    }),
  );
}

/** A database that claims exactly `keep`, recording the parameters it was asked with. */
function db(keep: readonly string[], asked: unknown[][] = []): Querier {
  const querier: Querier = {
    query: (_sql: string, params?: unknown[]) => {
      asked.push(params ?? []);
      return Promise.resolve({ rows: keep.map((hash) => ({ hash: `sha256:${hash}` })) });
    },
  };
  return querier;
}

const run = (querier: Querier, over: { unlinked?: boolean; dryRun?: boolean } = {}) =>
  prune(querier, {
    outDir: out,
    includeUnlinked: over.unlinked ?? false,
    dryRun: over.dryRun ?? false,
    log: () => {},
  });

async function remaining(): Promise<string[]> {
  const found: string[] = [];
  for (const shard of await readdir(join(out, "media"))) {
    for (const file of await readdir(join(out, "media", shard))) found.push(file);
  }
  return found.sort();
}

describe("what a prune must never delete", () => {
  /**
   * The expensive mistake. A version's manifest vouches for its photos by hash, so deleting one
   * makes that version permanently unverifiable and unshippable — the signature still demands bytes
   * that are gone. The database's opinion is irrelevant here: the volume is already published.
   */
  it("keeps a blob a published version references, even when nothing claims it", async () => {
    await blob(A);
    await version("2026-08", [A]);

    const report = await run(db([]));
    expect(report.keptByVolume).toBe(1);
    expect(report.removed).toBe(0);
    expect(await remaining()).toEqual([`${A}.webp`]);
  });

  it("protects every version on disk, not just the newest", async () => {
    await blob(A);
    await blob(B);
    await version("2026-07", [A]);
    await version("2026-08", [B]);

    const report = await run(db([]));
    expect(report.versions).toEqual(["2026-07", "2026-08"]);
    expect(report.removed).toBe(0);
  });

  /**
   * Unlinked is also the state of a crawl page whose file rows have committed and whose links have
   * not. Sweeping it by default would delete the bytes of photos seconds from being linked, turning
   * a free relink into a re-download.
   */
  it("carries --unlinked into the claim query rather than deciding locally", async () => {
    // The keep rule lives in SQL (it must share publish's predicates), so a fake can only stub the
    // answer — asserting on the *flag reaching the query* is the part this level can actually
    // prove. Whether the query then honours it is the store's contract, not the walker's.
    await blob(A);
    const asked: unknown[][] = [];
    await run(db([A], asked));
    expect(asked).toEqual([[false]]);

    asked.length = 0;
    await run(db([A], asked), { unlinked: true });
    expect(asked).toEqual([[true]]);
  });

  it("leaves a non-blob file alone and counts it", async () => {
    await mkdir(join(out, "media", "AA"), { recursive: true });
    await writeFile(join(out, "media", "AA", "notes.txt"), "operator's own");
    const report = await run(db([]));
    expect(report.strays).toBe(1);
    expect(report.removed).toBe(0);
    expect(await remaining()).toEqual(["notes.txt"]);
  });

  it("deletes nothing under --dry-run, and still reports what it would reclaim", async () => {
    await blob(A, 4096);
    const report = await run(db([]), { dryRun: true });
    expect(report.removed).toBe(1);
    expect(report.bytes).toBe(4096);
    expect(await remaining()).toEqual([`${A}.webp`]);
  });
});

describe("what it does delete", () => {
  /**
   * The leak that motivated the stage: `refusedRow` rebuilds a row **without** its hashes, so a
   * `published` → `rejected` transition strands the bytes with nothing in the database naming them.
   * They cannot be found by querying — only a disk-versus-claims diff reaches them.
   */
  it("reclaims a blob no row and no version names at all", async () => {
    await blob(A, 2048);
    await blob(B, 3072);
    await version("2026-08", [B]);

    const report = await run(db([B]));
    expect(report.onDisk).toBe(2);
    expect(report.removed).toBe(1);
    expect(report.bytes).toBe(2048);
    expect(await remaining()).toEqual([`${B}.webp`]);
  });

  it("runs with no published version at all, protected only by the database", async () => {
    await blob(A);
    await blob(C);
    const report = await run(db([C]));
    expect(report.versions).toEqual([]);
    expect(report.keptByDatabase).toBe(1);
    expect(await remaining()).toEqual([`${C}.webp`]);
  });
});
