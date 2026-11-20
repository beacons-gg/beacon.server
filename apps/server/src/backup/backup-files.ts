import { createHash } from "node:crypto";
import type { Readable } from "node:stream";
import type { RunProgress } from "./backup-job";

/**
 * Moving media files between a server's blob backend and a backup, whichever way round. Each file
 * is read whole so it can be hashed before it is written anywhere, which the 0.5 CPU tenant pays
 * for in memory, so both jobs share the same bounds.
 */

/** One media row: what a file has to match. */
export interface MediaRow {
  hash: string;
  size: number;
  type: string;
}

/** A slow link's floor for a whole-file write: past `mediaStallMs` plus this long, it has stalled. */
const WRITE_FLOOR_BYTES_PER_MS = 64;

/** At most this many files at once, fewer when four of the largest would break the byte budget. */
const MEDIA_CONCURRENCY = 4;
const MEDIA_BYTE_BUDGET = 48 * 1024 * 1024;

/** How long a media read may go without a byte before it counts as stalled. */
export const MEDIA_READ_STALL_MS = 60_000;

/**
 * Attempts at one file operation when a backend errors or stalls. An error is not a missing file:
 * a backup that wrote one off as missing would finish `done` and delete the backup before it, so
 * past this many the run fails instead.
 */
const FILE_ATTEMPTS = 3;
const FILE_RETRY_MS = 500;

/** Why a file is counted as missing: the only two reasons that do not fail a run. */
export type MediaFault = "missing" | "corrupt";

/** What reading and retrying a file needs. */
export interface FileDeps {
  sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  mediaStallMs: number;
}

/** Opens a file's bytes, or undefined when it is absent. */
export type OpenFile = (hash: string, signal: AbortSignal) => Promise<Readable | undefined>;

/** `work` raced against `signal`, for a backend that does not honour it. A late result is released. */
function untilAborted<T>(
  work: Promise<T>,
  signal: AbortSignal,
  release: (late: T) => void,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      reject(signal.reason as Error);
      void work.then(release, () => undefined);
    };
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

/**
 * A signal that ends with `signal`, or with `message` once `ms` passes without a {@link refresh}.
 * `clear` it when the watched work is over.
 */
function stallWatch(
  ms: number,
  signal: AbortSignal,
  message: string,
): { signal: AbortSignal; refresh: () => void; clear: () => void } {
  const stall = new AbortController();
  const timer = setTimeout(() => {
    stall.abort(new Error(message));
  }, ms);
  return {
    signal: AbortSignal.any([signal, stall.signal]),
    refresh: () => {
      timer.refresh();
    },
    clear: () => {
      clearTimeout(timer);
    },
  };
}

/**
 * Read a file once, hashing as it arrives, into one buffer of the row's size: the file is rejected
 * the moment it runs long, so `row.size` is an upper bound and nothing is held twice.
 *
 * Throws on a backend error or a stall, which the caller retries. A stall is a span of
 * `deps.mediaStallMs` with no bytes, so a large file on a slow backend is not one.
 */
async function readVerified(
  deps: FileDeps,
  open: OpenFile,
  row: MediaRow,
  signal: AbortSignal,
): Promise<Buffer | MediaFault> {
  const watch = stallWatch(deps.mediaStallMs, signal, `no data for ${deps.mediaStallMs}ms`);
  const reading = watch.signal;
  let stream: Readable | undefined;
  const stop = (): void => {
    stream?.destroy(reading.reason as Error);
  };
  try {
    stream = await untilAborted(open(row.hash, reading), reading, (late) => {
      late?.destroy();
    });
    if (stream === undefined) return "missing";
    reading.addEventListener("abort", stop, { once: true });
    const bytes = Buffer.allocUnsafe(row.size);
    const hash = createHash("sha256");
    let total = 0;
    for await (const chunk of stream) {
      const buf = chunk as Buffer;
      if (total + buf.length > row.size) return "corrupt";
      buf.copy(bytes, total);
      total += buf.length;
      hash.update(buf);
      watch.refresh();
    }
    if (total !== row.size || hash.digest("base64url") !== row.hash) return "corrupt";
    return bytes;
  } finally {
    watch.clear();
    reading.removeEventListener("abort", stop);
    stream?.destroy();
  }
}

/**
 * `work` under a stall limit, for a backend call with no bytes to watch: `work` gets a signal that
 * ends when the limit passes, and a backend that ignores it is abandoned. `size` lengthens the limit
 * by what a slow link would need for that many bytes.
 */
export async function withStallLimit<T>(
  deps: Pick<FileDeps, "mediaStallMs">,
  signal: AbortSignal,
  work: (signal: AbortSignal) => Promise<T>,
  size = 0,
): Promise<T> {
  const limitMs = deps.mediaStallMs + size / WRITE_FLOOR_BYTES_PER_MS;
  const watch = stallWatch(limitMs, signal, `no response for ${limitMs}ms`);
  try {
    return await untilAborted(work(watch.signal), watch.signal, () => undefined);
  } finally {
    watch.clear();
  }
}

/**
 * Hand each entry of a listing to `onEntry`, stalled when `deps.mediaStallMs` passes with no entry
 * arriving. Listing once is what stops a top-up asking the backend about every file in turn.
 */
export async function consumeListing(
  deps: Pick<FileDeps, "mediaStallMs">,
  list: (signal: AbortSignal) => AsyncIterable<{ hash: string; size: number }>,
  onEntry: (entry: { hash: string; size: number }) => void,
  signal: AbortSignal,
): Promise<void> {
  const watch = stallWatch(deps.mediaStallMs, signal, `no data for ${deps.mediaStallMs}ms`);
  const entries = list(watch.signal)[Symbol.asyncIterator]();
  try {
    for (;;) {
      const next = await untilAborted(entries.next(), watch.signal, () => undefined);
      if (next.done) return;
      onEntry(next.value);
      watch.refresh();
    }
  } finally {
    watch.clear();
    void entries.return?.();
  }
}

/** `work`, retried a few times; past them the run fails, saying `what`. An abort is never retried. */
export async function retrying<T>(
  deps: Pick<FileDeps, "sleep">,
  what: string,
  signal: AbortSignal,
  work: () => Promise<T>,
): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await work();
    } catch (err) {
      signal.throwIfAborted();
      if (attempt >= FILE_ATTEMPTS) {
        const why = err instanceof Error ? err.message : String(err);
        throw new Error(`${what} after ${attempt} attempts: ${why}`);
      }
      await deps.sleep(FILE_RETRY_MS * attempt, signal);
    }
  }
}

/** {@link readVerified} with retries. */
export function readFileVerified(
  deps: FileDeps,
  open: OpenFile,
  row: MediaRow,
  signal: AbortSignal,
): Promise<Buffer | MediaFault> {
  return retrying(deps, `media ${row.hash} could not be read`, signal, () =>
    readVerified(deps, open, row, signal),
  );
}

/**
 * Run `copyOne` over `rows` with a plain worker pool, sized for the largest file so workers holding
 * one each stay under the budget. A file over the budget by itself still runs, on the one worker.
 */
export async function forEachFile(
  rows: readonly MediaRow[],
  signal: AbortSignal,
  copyOne: (row: MediaRow) => Promise<void>,
): Promise<void> {
  // By comparison, so one row with no usable size cannot poison the sum, and at least one worker
  // whenever there is work: a pool of none would finish `done` having copied nothing.
  const largest = rows.reduce((max, row) => (row.size > max ? row.size : max), 1);
  const workers =
    rows.length === 0
      ? 0
      : Math.max(
          1,
          Math.min(MEDIA_CONCURRENCY, rows.length, Math.floor(MEDIA_BYTE_BUDGET / largest)),
        );
  let next = 0;
  const worker = async (): Promise<void> => {
    try {
      while (next < rows.length) {
        signal.throwIfAborted();
        await copyOne(rows[next++]!);
      }
    } catch (err) {
      next = rows.length; // the other workers stop at their next file
      throw err;
    }
  };
  // Settled, not `all`: the bucket closes when this returns, so the files still in flight on the
  // other workers have to finish first.
  const settled = await Promise.allSettled(Array.from({ length: workers }, worker));
  const failed = settled.find((r): r is PromiseRejectedResult => r.status === "rejected");
  if (failed) throw failed.reason;
}

/** How far a run reports having got; both jobs count files the same way. */
type FileProgress = Pick<RunProgress, "stats" | "tick" | "warn">;

function fileDone(progress: FileProgress): void {
  progress.stats.mediaDone += 1;
  progress.tick();
}

/** Count a file already at its destination. */
export function fileSkipped(progress: FileProgress, row: MediaRow): void {
  progress.stats.mediaSkipped += 1;
  progress.stats.mediaBytes += row.size;
  fileDone(progress);
}

/** Count a file that is not coming: a warning, never a failure. */
export function fileMissing(progress: FileProgress, hash: string, why: string): void {
  progress.stats.mediaMissing += 1;
  progress.warn(`media ${hash}: ${why}`);
  fileDone(progress);
}

/** What differs between copying files out of a server and into one. */
export interface CopySteps {
  open: OpenFile;
  store: (row: MediaRow, bytes: Buffer) => Promise<void>;
  faultText: Record<MediaFault, string>;
  progress: FileProgress;
}

/** Read, verify and store each of `rows`; returns the hashes that were counted as missing. */
export async function copyVerifiedFiles(
  deps: FileDeps,
  rows: readonly MediaRow[],
  { open, store, faultText, progress }: CopySteps,
  signal: AbortSignal,
): Promise<string[]> {
  const missing: string[] = [];
  await forEachFile(rows, signal, async (row) => {
    const bytes = await readFileVerified(deps, open, row, signal);
    if (typeof bytes === "string") {
      fileMissing(progress, row.hash, faultText[bytes]);
      missing.push(row.hash);
      return;
    }
    await store(row, bytes);
    progress.stats.mediaBytes += row.size;
    fileDone(progress);
  });
  return missing;
}
