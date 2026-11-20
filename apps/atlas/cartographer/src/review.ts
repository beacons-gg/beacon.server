/**
 * The decisions review console — `apps/atlas/doc/spec/cartographer.md` §5's human surface, served
 * by cartographer itself.
 *
 * The queue is `ambiguous_ids`: every identifier the merge gate refused, with the records that assert
 * it, their fields, and both pins on a map. The verdicts are `decisions` rows, and their semantics are
 * `identity.ts`'s, not this file's:
 *
 * - **`distinct(asserter, id)`** severs one record's claim to an identifier — "this record does not
 *   really assert that QID". Durable across rebuilds, and the correct verdict for a tag that names the
 *   operator rather than the place.
 * - **`same(a, b)`** is a forced claim that outranks the gate. "These really are one place" is written
 *   between the two **record** nodes — an edge through the gated identifier would be filtered before
 *   the union ever saw it, so forcing the records together is the only form that works.
 * - **Skip is not a verdict.** `ambiguous_ids` is rebuilt by every `resolve`, so an undecided refusal
 *   simply comes back; recording "later" would be inventing a state the pipeline never reads.
 *
 * A verdict applies at the **next `resolve` run** — the console edits the input, never the graph.
 *
 * Served by cartographer rather than a console app of its own because the contract lives here:
 * `recordNode` builds the node a decision names (the docblock on `decisions` forbids spelling it by
 * hand), and `store.ts` owns every read this needs. The UI is one static page; MapLibre is served out
 * of node_modules, so the only network the browser touches beyond this server is the OSM tile host.
 */
import { createReadStream } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { join } from "node:path";
import { recordNode } from "./identity";
import { blobPath } from "@beaconsgg/atlas-volume";
import { PLACE_MEDIA_TYPE } from "@beaconsgg/protocol-types";
import {
  deleteMediaDecision,
  deletePlaceDecision,
  fetchMediaQueue,
  mediaReviewStats,
  placesForFile,
  readAmbiguousId,
  readAmbiguousIds,
  readDecisionLog,
  readWikidataLabels,
  recordsAssertingIds,
  writeDecision,
  writeMediaDecisions,
  writePlaceDecision,
  deleteDecision,
  type AmbiguousRow,
  type DecisionLogRow,
  type Querier,
  type ReviewAsserter,
  type WikidataLabel,
} from "./store";
import { namespaceOf, upstreamValue } from "./upstream";

/** One refusal as the console shows it: the gate's evidence plus everything needed to rule on it. */
export interface ReviewEntry extends AmbiguousRow {
  /** What the concordance knows the id names — an `enwiki` title for a `wd:` refusal, when held. */
  label?: string;
  /** The concordance answered "no such entity" — worth showing, since the id still gated something. */
  labelAbsent?: boolean;
  asserters: (ReviewAsserter & { node: string })[];
  /** The verdicts that touch this refusal — its id by name, or a pair of its own asserters. */
  decisions: DecisionLogRow[];
}

/**
 * Order the queue for a human: `span` refusals first, widest first — they are the disagreements a
 * reviewer can actually settle — then `not-a-place`, most-asserted first, which the gate already
 * handles correctly and the console shows for audit.
 *
 * Each entry carries the decisions that touch it, matched **here** rather than in the page: what a
 * decision's ends mean relative to a refusal is the identity contract's business, and this function
 * is the exported, tested one — the page stays purely presentational.
 */
export function assembleQueue(
  ambiguous: readonly AmbiguousRow[],
  asserters: ReadonlyMap<string, ReviewAsserter[]>,
  labels: ReadonlyMap<string, WikidataLabel>,
  decisions: readonly DecisionLogRow[],
): ReviewEntry[] {
  const entries = ambiguous.map((row): ReviewEntry => {
    const label =
      namespaceOf(row.upstreamId) === "wd" ? labels.get(upstreamValue(row.upstreamId)) : undefined;
    const held = (asserters.get(row.upstreamId) ?? []).map((asserter) => ({
      ...asserter,
      node: recordNode(asserter),
    }));
    const nodes = new Set(held.map((asserter) => asserter.node));
    return {
      ...row,
      ...(label?.enwikiTitle === undefined ? {} : { label: label.enwikiTitle }),
      ...(label?.absent ? { labelAbsent: true } : {}),
      asserters: held,
      decisions: decisions.filter(
        (d) =>
          d.a === row.upstreamId || d.b === row.upstreamId || (nodes.has(d.a) && nodes.has(d.b)),
      ),
    };
  });
  return entries.sort((a, b) => {
    if (a.reason !== b.reason) return a.reason === "span" ? -1 : 1;
    if (a.reason === "span")
      return (b.spanM ?? 0) - (a.spanM ?? 0) || cmp(a.upstreamId, b.upstreamId);
    return b.records - a.records || cmp(a.upstreamId, b.upstreamId);
  });
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export interface DecisionBody {
  a: string;
  b: string;
  verdict: "same" | "distinct";
  /** The queue entry the reviewer was looking at — becomes the verdict's evidence, looked up here. */
  context?: string;
}

/** A request's mistake, answered 400 with the message verbatim. Anything else is ours, and a 500. */
export class BadRequest extends Error {}

/**
 * One optional string field of a request body — present and sane, or absent. The single spelling of
 * "a non-empty bounded string" for every endpoint here; hand-checking `typeof x !== "string"` per
 * handler is how three of them ended up with no length cap at all.
 */
function stringField(raw: unknown, name: string, max = 400): string | undefined {
  const value = (raw as Record<string, unknown> | null)?.[name];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || value.length === 0 || value.length > max) {
    throw new BadRequest(`${name} must be a non-empty string`);
  }
  return value;
}

/** The same, required. */
function requireString(raw: unknown, name: string, max = 400): string {
  const value = stringField(raw, name, max);
  if (value === undefined) throw new BadRequest(`${name} is required`);
  return value;
}

/** Validate a verdict request. */
export function parseDecisionBody(raw: unknown): DecisionBody {
  const body = raw as Record<string, unknown> | null;
  const field = (name: "a" | "b" | "context"): string | undefined => stringField(body, name);
  const a = field("a");
  const b = field("b");
  if (!a || !b) throw new BadRequest("a and b are required");
  if (a === b) throw new BadRequest("a and b name the same node");
  const verdict = body?.["verdict"];
  if (verdict !== "same" && verdict !== "distinct") {
    throw new BadRequest('verdict must be "same" or "distinct"');
  }
  const context = field("context");
  return { a, b, verdict, ...(context ? { context } : {}) };
}

/**
 * The orientation a verdict is stored under. `identity.ts` reads the pair unordered, so this is purely
 * about the row reading well in the log: a `distinct` names the asserter first and the identifier
 * second (the `decisions` docblock's example), and a `same` between two records has no natural order,
 * so the smaller node leads — one spelling per pair, whichever end the UI happened to send first.
 */
export function canonicalDecision(
  a: string,
  b: string,
  verdict: DecisionBody["verdict"],
): {
  a: string;
  b: string;
} {
  if (verdict === "distinct" && !a.startsWith("record:") && b.startsWith("record:")) {
    return { a: b, b: a };
  }
  if (verdict === "same" && b < a) return { a: b, b: a };
  return { a, b };
}

export interface ReviewDeps {
  db: Querier;
  reviewer: string;
  /** Where `media` wrote its blobs — the Media tab serves thumbs straight off disk from here. */
  outDir: string;
  now: () => string;
  log: (message: string) => void;
}

/**
 * A media hash as a blob request may spell it. Validated before it reaches a path: the hash arrives
 * from the browser, and `blobPath` would happily resolve `sha256:../../etc/passwd` into a read.
 */
const BLOB_HASH = /^sha256:[A-Za-z0-9_-]{16,64}$/;

/** Content-addressed bytes never change under their key — the same header a volume's host sets. */
const BLOB_CACHE = "public, max-age=31536000, immutable";

/** One verdict request from the Media tab, validated the same way the identity ones are. */
export interface MediaVerdictBody {
  fileKey: string;
  entityId?: string;
  verdict: "ok" | "reject" | "unlink";
  reason?: string;
}

export function parseMediaVerdict(raw: unknown): MediaVerdictBody {
  const body = raw as Record<string, unknown> | null;
  const fileKey = requireString(body, "fileKey");
  const verdict = body?.["verdict"];
  if (verdict !== "ok" && verdict !== "reject" && verdict !== "unlink") {
    throw new BadRequest('verdict must be "ok", "reject" or "unlink"');
  }
  const entityId = stringField(body, "entityId");
  // The scope IS the verdict's meaning: an `unlink` with no place would silently become a global
  // reject, and a global verdict carrying a place would be stored under a scope nothing reads.
  if (verdict === "unlink" && !entityId) throw new BadRequest("unlink names the place to unlink");
  if (verdict !== "unlink" && entityId)
    throw new BadRequest(`${verdict} applies to the whole file`);
  const reason = stringField(body, "reason", 500);
  return {
    fileKey,
    verdict,
    ...(entityId ? { entityId } : {}),
    ...(reason ? { reason } : {}),
  };
}

interface ReviewPayload {
  reviewer: string;
  queue: ReviewEntry[];
  decisions: DecisionLogRow[];
}

async function reviewPayload(db: Querier, reviewer: string): Promise<ReviewPayload> {
  const ambiguous = await readAmbiguousIds(db);
  // Independent given `ambiguous`, and `db` is the pool — so the three reads land on their own
  // connections. This runs after every verdict, not once.
  const [asserters, labels, decisions] = await Promise.all([
    recordsAssertingIds(
      db,
      ambiguous.map((row) => row.upstreamId),
    ),
    readWikidataLabels(
      db,
      ambiguous
        .filter((row) => namespaceOf(row.upstreamId) === "wd")
        .map((row) => upstreamValue(row.upstreamId)),
    ),
    readDecisionLog(db),
  ]);
  return { reviewer, queue: assembleQueue(ambiguous, asserters, labels, decisions), decisions };
}

/** Small enough for any verdict, far too small for a mistake pointed at the wrong port. */
const MAX_BODY_BYTES = 64 * 1024;

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new BadRequest("request body too large");
    chunks.push(chunk as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new BadRequest("request body is not JSON");
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

/**
 * Stream a file, answering 404 when it is not there.
 *
 * The head is written on `open`, not before it: a missing blob is **routine** here (publish's
 * `missingBlobs` counter exists because blobs do go missing), and writing 200 first would make the
 * error handler's 404 a second `writeHead` — which throws inside an event handler.
 */
function sendFile(res: ServerResponse, path: string, type: string, cacheControl?: string): void {
  const stream = createReadStream(path);
  stream.once("open", () => {
    res.writeHead(200, {
      "content-type": type,
      ...(cacheControl ? { "cache-control": cacheControl } : {}),
    });
    stream.pipe(res);
  });
  stream.on("error", () => {
    if (res.headersSent) res.destroy();
    else sendJson(res, 404, { error: "not found" });
  });
}

/**
 * The static files the page needs — MapLibre comes straight out of node_modules (a declared
 * dependency, so the resolve always succeeds), so the browser touches no network beyond this server
 * and the tile host.
 */
const STATIC_FILES: Record<string, { path: string; type: string }> = {
  "/": { path: join(__dirname, "review-page.html"), type: "text/html; charset=utf-8" },
  "/assets/maplibre-gl.js": {
    path: require.resolve("maplibre-gl/dist/maplibre-gl.js"),
    type: "text/javascript",
  },
  "/assets/maplibre-gl.css": {
    path: require.resolve("maplibre-gl/dist/maplibre-gl.css"),
    type: "text/css",
  },
};

async function handle(deps: ReviewDeps, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const path = url.pathname;
  const file = STATIC_FILES[path];
  if (file && req.method === "GET") return sendFile(res, file.path, file.type);

  if (path === "/api/review" && req.method === "GET") {
    return sendJson(res, 200, await reviewPayload(deps.db, deps.reviewer));
  }

  if (path === "/api/decisions" && req.method === "POST") {
    const body = parseDecisionBody(await readJsonBody(req));
    // The queue row the reviewer ruled on becomes the verdict's evidence — read from the database
    // rather than trusted from the client, so the log records what the gate actually said.
    const context = body.context ? await readAmbiguousId(deps.db, body.context) : undefined;
    const { a, b } = canonicalDecision(body.a, body.b, body.verdict);
    const write = {
      a,
      b,
      verdict: body.verdict,
      evidence: { via: "review-console", ...(context ?? {}) },
      decidedBy: deps.reviewer,
    };
    await writeDecision(deps.db, write, deps.now());
    deps.log(`${body.verdict}: ${a} / ${b} (${deps.reviewer})`);
    return sendJson(res, 200, { ok: true });
  }

  if (path === "/api/decisions/delete" && req.method === "POST") {
    const body = await readJsonBody(req);
    const a = requireString(body, "a");
    const b = requireString(body, "b");
    const removed = await deleteDecision(deps.db, a, b);
    if (removed > 0) deps.log(`withdrawn: ${a} / ${b} (${deps.reviewer})`);
    return sendJson(res, 200, { ok: true, removed });
  }

  // ── the Media tab ───────────────────────────────────────────────────────────────────────────
  if (path === "/api/media" && req.method === "GET") {
    const after = url.searchParams.get("afterAt");
    const source = url.searchParams.get("source");
    const [stats, entries] = await Promise.all([
      mediaReviewStats(deps.db),
      fetchMediaQueue(deps.db, {
        limit: Math.min(Number(url.searchParams.get("limit") ?? 60) || 60, 200),
        ...(source ? { source } : {}),
        // The skip cursor: advance past a page without ruling on it.
        ...(after
          ? { after: { fetchedAt: after, fileKey: url.searchParams.get("afterKey") ?? "" } }
          : {}),
      }),
    ]);
    return sendJson(res, 200, { stats, entries });
  }

  if (path === "/api/media/places" && req.method === "GET") {
    const fileKey = url.searchParams.get("file");
    if (!fileKey) throw new BadRequest("file is required");
    return sendJson(res, 200, { places: await placesForFile(deps.db, fileKey) });
  }

  if (path === "/api/media/verdict" && req.method === "POST") {
    const body = parseMediaVerdict(await readJsonBody(req));
    await writeMediaDecisions(deps.db, [{ ...body, decidedBy: deps.reviewer }], deps.now());
    deps.log(`media ${body.verdict}: ${body.fileKey}${body.entityId ? ` @ ${body.entityId}` : ""}`);
    return sendJson(res, 200, { ok: true });
  }

  /** Bulk approve — the button that makes an exhaustive pass over tens of thousands finite. */
  if (path === "/api/media/approve" && req.method === "POST") {
    const keys = ((await readJsonBody(req)) as { fileKeys?: unknown } | null)?.fileKeys;
    if (!Array.isArray(keys) || keys.length === 0 || keys.length > 500) {
      throw new BadRequest("fileKeys must be a non-empty array of at most 500 keys");
    }
    const rows = keys.map((key) => {
      if (typeof key !== "string" || key.length === 0) throw new BadRequest("bad fileKey");
      return { fileKey: key, verdict: "ok" as const, decidedBy: deps.reviewer };
    });
    await writeMediaDecisions(deps.db, rows, deps.now());
    deps.log(`media ok: ${rows.length} photo(s) approved (${deps.reviewer})`);
    return sendJson(res, 200, { ok: true, approved: rows.length });
  }

  /** Undo — the console's safety net, and the reason a verdict is a row rather than a mutation. */
  if (path === "/api/media/withdraw" && req.method === "POST") {
    const body = await readJsonBody(req);
    const removed = await deleteMediaDecision(
      deps.db,
      requireString(body, "fileKey"),
      stringField(body, "entityId"),
    );
    if (removed > 0) deps.log(`media verdict withdrawn (${deps.reviewer})`);
    return sendJson(res, 200, { ok: true, removed });
  }

  if (path === "/api/places/remove" && req.method === "POST") {
    const body = await readJsonBody(req);
    const entityId = requireString(body, "entityId");
    const reason = stringField(body, "reason", 500);
    await writePlaceDecision(
      deps.db,
      { entityId, ...(reason ? { reason } : {}), decidedBy: deps.reviewer },
      deps.now(),
    );
    deps.log(`place removed: ${entityId} (${deps.reviewer})`);
    return sendJson(res, 200, { ok: true });
  }

  if (path === "/api/places/restore" && req.method === "POST") {
    const entityId = requireString(await readJsonBody(req), "entityId");
    const removed = await deletePlaceDecision(deps.db, entityId);
    if (removed > 0) deps.log(`place restored: ${entityId} (${deps.reviewer})`);
    return sendJson(res, 200, { ok: true, removed });
  }

  /**
   * A photo's own bytes, straight off the crawl's output tree. The URL *is* a sha256, so the answer
   * can never go stale — without the header the browser re-fetches the whole sheet (~1 MB) after
   * every verdict, because each reload rebuilds the grid's `<img>` elements.
   */
  if (path === "/blob" && req.method === "GET") {
    const hash = url.searchParams.get("hash") ?? "";
    if (!BLOB_HASH.test(hash)) throw new BadRequest("not a media hash");
    return sendFile(res, blobPath(deps.outDir, hash), PLACE_MEDIA_TYPE, BLOB_CACHE);
  }

  sendJson(res, 404, { error: "not found" });
}

/**
 * Serve the console until SIGINT/SIGTERM. Resolves when the server has closed — `main` treats this
 * like any stage, so the pool is ended and the process exits cleanly on ctrl-c.
 */
export function serveReview(deps: ReviewDeps, port: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const server = createServer((req, res) => {
      handle(deps, req, res).catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        // Either way the console stays up — one bad request must not take the reviewer's session down.
        if (!res.headersSent) {
          sendJson(res, error instanceof BadRequest ? 400 : 500, { error: message });
        }
      });
    });
    server.on("error", reject);
    const stop = (): void => {
      server.closeAllConnections();
      server.close(() => resolve());
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    server.listen(port, () => {
      deps.log(`review console listening on http://localhost:${port} (reviewer: ${deps.reviewer})`);
      deps.log("identity verdicts apply at the next `resolve`; media and place ones at `publish`");
    });
  });
}
