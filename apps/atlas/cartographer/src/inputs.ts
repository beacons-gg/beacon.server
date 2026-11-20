/**
 * Stage 0 — record which exact bytes this build was made from.
 *
 * **It does not download anything, and that is deliberate.** Extracts are placed by hand today
 * (`apps/atlas/README.md`), the ones on disk are 3.4 GB and 12 GB, and `curl` already resumes. What a
 * build actually needs is not a downloader but a *record*, so a volume's manifest can name its inputs
 * and a rebuild can be shown to have used the same ones.
 *
 * There are two ways an input gets recorded, and which one applies depends on **who read the file**:
 *
 * 1. **Adopted** — the acquisition step read the bytes and left a sidecar saying what it consumed.
 *    That is how OSM works: `osm-import` is the only thing that opens the `.pbf`, so it is the only
 *    thing that can say for certain which one went into `beacon_places`. Cartographer does not name
 *    that file at all. It used to, via `--input`, and that was a hole: two commands naming the same
 *    artifact independently with nothing checking they agreed, so a build could hash extract A while
 *    the database held extract B — and then publish a manifest asserting reproducibility.
 * 2. **Hashed here** — for artifacts Cartographer itself reads (the GNIS names file, a dump later),
 *    where `--input` names the file to the thing that actually consumes it.
 *
 * Adopting also survives a case hashing here cannot: the archives live on external storage, and by the
 * time a later stage runs that disk may not be mounted. The sidecar was written while the file was
 * provably present, and it is a few hundred bytes.
 */
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { pipeline } from "node:stream/promises";
import { readInput, writeInput, type InputRecord, type Querier } from "./store";

/** What stage 0 did to one artifact. */
export interface InputResult extends InputRecord {
  /** How this record was arrived at — see the two paths in the module comment. */
  via: "adopted" | "hashed";
  /** Already recorded with the same bytes, so nothing was re-read. */
  skipped: boolean;
}

/**
 * The suffix an acquisition record carries. One record **per source**, named for the source
 * (`osm.input.json`) — not for the artifact.
 *
 * Keyed by source because that is what the database holds: `osm2pgsql --create` replaces the table
 * wholesale, so exactly one OSM extract is in there at a time. Keying by file name left a stale record
 * behind after importing a different extract, and stage 0 adopted both — a manifest naming inputs the
 * build was not made from, which is the failure this stage exists to prevent, arriving by another door.
 *
 * The producer side of this contract is the `osm-import` command in `apps/atlas/docker-compose.yml`.
 * Renaming this constant or changing {@link readSidecar}'s field list orphans every existing record, so
 * that command names this file in its comment as the grep anchor.
 */
const SIDECAR_SUFFIX = ".input.json";

/**
 * Hash a file with constant memory.
 *
 * Streamed rather than buffered because the inputs are multi-GB: `OutboundHttp.getBytes` buffers (and
 * belongs to the server anyway), and there is no streaming hash elsewhere in the repo to reuse.
 *
 * `base64url`, unpadded — matching `@beaconsgg/identity`'s `sha256Base64url` convention, so a hash in a
 * volume manifest reads the same as every other digest the platform prints.
 */
export async function hashFile(path: string): Promise<{ hash: string; bytes: number }> {
  const digest = createHash("sha256");
  let bytes = 0;
  // The final stage is a plain async function — a *sink*, not a generator. An async generator here
  // would yield chunks nothing consumes, and once the unconsumed output buffer fills, backpressure
  // stalls the pipeline and it never settles. It is invisible under ~1 MB (the chunks fit in the
  // buffer) and total above it, so the test that guards it uses a deliberately multi-megabyte file.
  // Today's `--input` artifacts are small — the multi-GB ones arrive by adoption — but a dump would
  // not be, and this is the property that makes size not matter.
  await pipeline(createReadStream(path), async function (source) {
    for await (const part of source as AsyncIterable<Buffer>) {
      digest.update(part);
      bytes += part.length;
    }
  });
  return { hash: digest.digest("base64url"), bytes };
}

/**
 * Record an input Cartographer reads **itself**, hashing it only when it looks changed.
 *
 * This is the `--input` path: the GNIS names file today, a dump later. The multi-GB OSM extract does not
 * come through here — see {@link adoptAcquired}.
 *
 * The skip test is `bytes` **and** `mtime_ms` together. Size alone would miss an in-place edit that
 * happens to preserve length, and the whole value of this stage is that the hash can be trusted;
 * "probably unchanged" is not that. The check is cheap and the artifact could be large, so it stays.
 */
export async function recordInput(
  db: Querier,
  opts: {
    source: string;
    path: string;
    now: string;
    force?: boolean;
    /** Called only when the file is actually about to be read — minutes of silence otherwise. */
    onHash?: (path: string) => void;
  },
): Promise<InputResult> {
  const artifact = basename(opts.path);
  const info = await stat(opts.path);
  const mtimeMs = Math.trunc(info.mtimeMs);
  const previous = await readInput(db, opts.source, artifact);

  if (!opts.force && previous && previous.bytes === info.size && previous.mtimeMs === mtimeMs) {
    return { ...previous, via: "hashed", skipped: true };
  }

  opts.onHash?.(opts.path);
  const { hash, bytes } = await hashFile(opts.path);
  const record: InputRecord = { source: opts.source, artifact, hash, bytes, mtimeMs };
  await writeInput(db, record, opts.now);
  return { ...record, via: "hashed", skipped: false };
}

/**
 * Adopt every sidecar an acquisition step left in `dir`, as `build_inputs` rows.
 *
 * No file is re-read: the sidecar carries the hash, so this is a copy from one record into another. An
 * unreadable or malformed sidecar is **skipped with a warning, never silently**, and never treated as
 * "no input" — the whole point of the record is that a missing one must not look like a clean build.
 *
 * A missing directory is not an error. It just means nothing has been acquired yet, which is the state
 * of a fresh checkout, and `inputs` will say so rather than failing.
 */
export async function adoptAcquired(
  db: Querier,
  opts: { dir: string; now: string; warn: (message: string) => void },
): Promise<InputResult[]> {
  let names: string[];
  try {
    names = (await readdir(opts.dir)).filter((n) => n.endsWith(SIDECAR_SUFFIX)).sort();
  } catch (error: unknown) {
    // ENOENT only. A directory that is unreadable rather than absent — the live case is the import
    // writing it as root while this runs as `node` over a read-only mount — must NOT read as "nothing
    // acquired yet": that is the pipeline's own rule about never recording a give-up as a fact, and
    // stage 0's report would state it as a finding.
    if ((error as { code?: string }).code === "ENOENT") return [];
    throw error;
  }

  const out: InputResult[] = [];
  for (const name of names) {
    const path = join(opts.dir, name);
    const record = await readSidecar(path);
    if (!record) {
      opts.warn(`ignoring ${path}: not a readable input record`);
      continue;
    }
    const previous = await readInput(db, record.source, record.artifact);
    // The hash settles it — matching bytes are implied, and a second clause would only be a second
    // thing that could disagree.
    const unchanged = previous?.hash === record.hash;
    if (!unchanged) await writeInput(db, record, opts.now);
    out.push({ ...record, via: "adopted", skipped: unchanged });
  }
  return out;
}

/**
 * One acquisition record, validated field by field — a partial or truncated write must not become a
 * half-recorded input.
 *
 * Hand-validated rather than parsed with zod: `InputRecord` is a database row shape, not a wire type,
 * so no schema exists to reuse and zod is not a dependency of this app. Five primitives from a
 * first-party producer is what `typeof` narrowing is for.
 *
 * **`sha256` arrives as hex and is converted here.** The producer is a shell script, so it writes what
 * `sha256sum` gives it; base64url-nopad — the convention the rest of the platform prints — stays a
 * single TypeScript implementation rather than something a pipeline of `base64` and `tr` has to
 * reproduce correctly in a shell with no `pipefail`.
 */
async function readSidecar(path: string): Promise<InputRecord | undefined> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, "utf8"));
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const { source, artifact, sha256, bytes, mtimeMs } = parsed as Record<string, unknown>;
  if (typeof source !== "string" || !source) return undefined;
  if (typeof artifact !== "string" || !artifact) return undefined;
  if (typeof sha256 !== "string" || !/^[0-9a-f]{64}$/.test(sha256)) return undefined;
  if (typeof bytes !== "number" || !Number.isFinite(bytes)) return undefined;
  if (typeof mtimeMs !== "number" || !Number.isFinite(mtimeMs)) return undefined;
  const hash = Buffer.from(sha256, "hex").toString("base64url");
  return { source, artifact, hash, bytes, mtimeMs };
}
