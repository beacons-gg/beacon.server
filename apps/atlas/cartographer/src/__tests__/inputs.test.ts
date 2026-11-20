import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { adoptAcquired, hashFile, recordInput } from "../inputs";
import type { Querier } from "../store";

const NOW = "2026-08-05T12:00:00.000Z";

/** The digest of the literal string below, so the streaming path is pinned to a known answer. */
const CARTOGRAPHER_SHA256 = "A6Yrxg4DWGqLm_XKdKDPKRcoWTovmQXdLkbKxuAKWfQ";

/** A fake `pg` querier holding `build_inputs` in a Map, and recording every write. */
function fakeDb() {
  const rows = new Map<string, { hash: string; bytes: string; mtime_ms: string }>();
  const writes: unknown[][] = [];
  const db: Querier = {
    query(sql: string, params: unknown[] = []) {
      if (sql.startsWith("CREATE")) return Promise.resolve({ rows: [] });
      if (sql.startsWith("SELECT")) {
        const key = `${params[0] as string}/${params[1] as string}`;
        const row = rows.get(key);
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

describe("hashFile", () => {
  let dir = "";
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "cartographer-inputs-"));
  });
  afterAll(async () => {
    // Best-effort: a leftover temp dir is the OS's problem, and failing here would mask a real failure.
    await rm(dir, { recursive: true, force: true });
  });

  it("streams a file to a base64url sha256 and reports its length", async () => {
    const path = join(dir, "known.txt");
    await writeFile(path, "cartographer");
    expect(await hashFile(path)).toEqual({ hash: CARTOGRAPHER_SHA256, bytes: 12 });
  });

  it("hashes a multi-megabyte file — the size that exposes a stalled pipeline", async () => {
    // 4 MB, and the size is the assertion. An earlier version made the pipeline's final stage an
    // async *generator*, yielding chunks nothing consumed; past ~1 MB the unconsumed output buffer
    // fills, backpressure stalls, and the promise never settles. Under 1 MB it passes cleanly, so a
    // small fixture called that implementation correct while the only file it ever sees is gigabytes.
    // If this ever hangs instead of failing, that regression is back.
    const body = "x".repeat(4_000_000);
    const path = join(dir, "big.bin");
    await writeFile(path, body);
    const expected = createHash("sha256").update(body).digest("base64url");
    expect(await hashFile(path)).toEqual({ hash: expected, bytes: 4_000_000 });
  }, 20_000);
});

/**
 * Move a file's mtime forward by a second, and prove it moved.
 *
 * A test about an *edited* file needs the timestamp to differ, and two writes back to back can land
 * inside the filesystem's mtime granularity, leaving it identical. `recordInput` then correctly takes
 * its skip path and the case quietly asserts nothing. Which way it lands is a property of the machine
 * running the suite rather than of the code, which is why this arrived as an intermittent failure
 * instead of an honest one. Setting the value makes the timestamp the test's variable, not the runner's.
 *
 * The read-back is not ceremony: a coarse-grained filesystem can round the new value straight back onto
 * the old one, and that has to fail here, where the message says what happened, rather than resurface as
 * the same puzzling flake in the assertion below.
 */
async function advanceMtime(path: string): Promise<void> {
  const before = await stat(path);
  await utimes(path, before.atime, new Date(before.mtimeMs + 1000));
  const after = await stat(path);
  expect(after.mtimeMs, "filesystem did not honour the mtime this test sets").not.toBe(
    before.mtimeMs,
  );
}

describe("recordInput", () => {
  let dir = "";
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "cartographer-record-"));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("hashes and records an artifact it has never seen", async () => {
    const { db, writes } = fakeDb();
    const path = join(dir, "first.osm.pbf");
    await writeFile(path, "cartographer");

    const result = await recordInput(db, { source: "osm", path, now: NOW });
    expect(result).toMatchObject({
      source: "osm",
      artifact: "first.osm.pbf",
      hash: CARTOGRAPHER_SHA256,
      bytes: 12,
      via: "hashed",
      skipped: false,
    });
    expect(writes).toHaveLength(1);
  });

  it("skips the hash when size and mtime both match — a 12 GB re-run is instant", async () => {
    const { db, writes } = fakeDb();
    const path = join(dir, "again.osm.pbf");
    await writeFile(path, "cartographer");

    await recordInput(db, { source: "osm", path, now: NOW });
    const second = await recordInput(db, { source: "osm", path, now: NOW });

    expect(second.skipped).toBe(true);
    expect(second.hash).toBe(CARTOGRAPHER_SHA256);
    // The point of the skip: no second write, and (unobservable here but the reason for it) no reread.
    expect(writes).toHaveLength(1);
  });

  it("rehashes when the content changed under an unchanged size", async () => {
    const { db, writes } = fakeDb();
    const path = join(dir, "edited.osm.pbf");
    await writeFile(path, "cartographer");
    await recordInput(db, { source: "osm", path, now: NOW });

    // Same length, different bytes — the case `bytes` alone would wave through. mtime moves on any
    // real edit, so this asserts the pair is what's compared, not just the cheaper half.
    await writeFile(path, "CARTOGRAPHER");
    // A real edit lands minutes or days after the last one; these two writes are microseconds apart,
    // which to the filesystem can be the same instant. Stand in for that elapsed time, so what drives
    // the rehash is the rule under test and not how fine the runner's clock happens to be.
    await advanceMtime(path);
    const second = await recordInput(db, { source: "osm", path, now: NOW });

    expect(second.skipped).toBe(false);
    expect(second.bytes).toBe(12);
    expect(second.hash).not.toBe(CARTOGRAPHER_SHA256);
    expect(writes).toHaveLength(2);
  });

  it("rehashes an unchanged file under --force", async () => {
    const { db, writes } = fakeDb();
    const path = join(dir, "forced.osm.pbf");
    await writeFile(path, "cartographer");
    await recordInput(db, { source: "osm", path, now: NOW });

    const second = await recordInput(db, { source: "osm", path, now: NOW, force: true });
    expect(second.skipped).toBe(false);
    expect(writes).toHaveLength(2);
  });

  it("keys on the basename, so two sources may hold same-named artifacts", async () => {
    const { db } = fakeDb();
    const path = join(dir, "shared.txt");
    await writeFile(path, "cartographer");

    await recordInput(db, { source: "osm", path, now: NOW });
    const other = await recordInput(db, { source: "gnis", path, now: NOW });
    expect(other.skipped).toBe(false);
    expect(other.artifact).toBe("shared.txt");
  });
});

/**
 * Adoption is the path OSM takes: `osm-import` is the only thing that opens the `.pbf`, so it records
 * what it consumed and stage 0 copies that record. Cartographer never names the extract — it used to,
 * and two commands naming the same artifact independently is how a build could hash extract A while the
 * database held extract B.
 */
describe("adoptAcquired", () => {
  let dir = "";
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "cartographer-adopt-"));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  /** The digest as the producer writes it: hex, because it comes from `sha256sum` in a shell. */
  const CARTOGRAPHER_HEX = createHash("sha256").update("cartographer").digest("hex");

  const sidecar = async (name: string, body: unknown): Promise<void> => {
    await writeFile(
      join(dir, `${name}.input.json`),
      typeof body === "string" ? body : JSON.stringify(body),
    );
  };

  const record = (over: Record<string, unknown> = {}) => ({
    source: "osm",
    artifact: "us-west.osm.pbf",
    sha256: CARTOGRAPHER_HEX,
    bytes: 3_373_438_358,
    mtimeMs: 1_784_942_874_000,
    ...over,
  });

  /** Every case starts from the same on-disk record, so any one of them runs alone under `-t`. */
  beforeEach(async () => {
    await rm(dir, { recursive: true, force: true });
    await mkdir(dir, { recursive: true });
    await sidecar("osm", record());
  });

  const noWarn = (): void => {};

  it("records what an acquisition step consumed, without reading the artifact", async () => {
    // The artifact is not in `dir` and does not exist anywhere — which is the point. By the time a later
    // stage runs, the external drive holding a 3.4 GB extract may not be mounted.
    const { db, writes } = fakeDb();
    const results = await adoptAcquired(db, { dir, now: NOW, warn: noWarn });
    expect(results).toEqual([
      {
        source: "osm",
        artifact: "us-west.osm.pbf",
        // Converted from the producer's hex to the base64url form the platform prints everywhere else.
        hash: CARTOGRAPHER_SHA256,
        bytes: 3_373_438_358,
        mtimeMs: 1_784_942_874_000,
        via: "adopted",
        skipped: false,
      },
    ]);
    expect(writes).toHaveLength(1);
  });

  it("is named for the source, not the artifact — a re-import cannot leave a stale record", async () => {
    // Keying by file name meant importing a second extract left the first record behind and stage 0
    // adopted both, so a manifest named inputs the build was not made from.
    const { db } = fakeDb();
    await sidecar("osm", record({ artifact: "us-260724.osm.pbf" }));
    const results = await adoptAcquired(db, { dir, now: NOW, warn: noWarn });
    expect(results.map((r) => r.artifact)).toEqual(["us-260724.osm.pbf"]);
  });

  it("re-adopting an unchanged record writes nothing", async () => {
    const { db, writes } = fakeDb();
    await adoptAcquired(db, { dir, now: NOW, warn: noWarn });
    const again = await adoptAcquired(db, { dir, now: NOW, warn: noWarn });
    expect(again[0]).toMatchObject({ via: "adopted", skipped: true });
    expect(writes).toHaveLength(1);
  });

  it("re-adopts when the recorded hash changed — a re-import of different bytes", async () => {
    const { db, writes } = fakeDb();
    await adoptAcquired(db, { dir, now: NOW, warn: noWarn });
    await sidecar("osm", record({ sha256: createHash("sha256").update("other").digest("hex") }));
    const again = await adoptAcquired(db, { dir, now: NOW, warn: noWarn });
    expect(again[0]).toMatchObject({ skipped: false });
    expect(again[0]?.hash).not.toBe(CARTOGRAPHER_SHA256);
    expect(writes).toHaveLength(2);
  });

  it("warns about a malformed record and never treats it as no input", async () => {
    // A half-written or truncated record must not read as a clean build — that is the whole failure this
    // stage exists to prevent, one level up.
    const { db, writes } = fakeDb();
    const warnings: string[] = [];
    await sidecar("broken", "{not json");
    await sidecar("partial", { source: "osm", artifact: "partial.osm.pbf" });
    // A hex digest that isn't one: the producer is a shell script, and a failed pipeline there used to
    // be able to write an empty string while still exiting 0.
    await sidecar("truncated", record({ source: "gnis", sha256: "" }));

    const results = await adoptAcquired(db, { dir, now: NOW, warn: (m) => warnings.push(m) });

    expect(results.map((r) => r.artifact)).toEqual(["us-west.osm.pbf"]);
    expect(warnings).toHaveLength(3);
    expect(warnings.every((w) => w.includes("not a readable input record"))).toBe(true);
    expect(writes).toHaveLength(1);
  });

  it("treats a missing state directory as nothing acquired", async () => {
    // The state of a fresh checkout. `inputs` reports it rather than failing.
    const { db } = fakeDb();
    await expect(
      adoptAcquired(db, { dir: join(dir, "does-not-exist"), now: NOW, warn: noWarn }),
    ).resolves.toEqual([]);
  });

  it("rethrows a directory that is unreadable rather than absent", async () => {
    // The live case: the import writes /state as root, cartographer reads it as `node`. Swallowing this
    // would report "nothing has been acquired yet" — a give-up recorded as a fact, which is the one
    // thing the pipeline's own rules forbid.
    const { db } = fakeDb();
    const notADirectory = join(dir, "osm.input.json");
    await expect(adoptAcquired(db, { dir: notADirectory, now: NOW, warn: noWarn })).rejects.toThrow(
      /ENOTDIR/,
    );
  });

  it("ignores files that are not acquisition records", async () => {
    const { db } = fakeDb();
    await writeFile(join(dir, "notes.txt"), "scratch");
    const results = await adoptAcquired(db, { dir, now: NOW, warn: noWarn });
    expect(results.map((r) => r.artifact)).toEqual(["us-west.osm.pbf"]);
  });
});
