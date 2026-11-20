import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

/** One stored object, as a backup test wants to see it. */
export interface FakeObject {
  body: Buffer;
  contentType: string | undefined;
  cacheControl: string | undefined;
}

/**
 * An in-process S3, just enough of it for the real AWS SDK to talk to: path-style put, head, get,
 * delete, ListObjectsV2 and multipart. The backup suites run the real `BackupBucket` against it, so
 * the code that speaks to S3 is under test without needing MinIO on the laptop; the MinIO round trip
 * is the gated integration suite (`backup.integration.test.ts`).
 */
export class FakeS3 {
  readonly objects = new Map<string, FakeObject>();
  /** Keys in the order their writes completed: what the manifest-last tests assert on. */
  readonly writes: string[] = [];
  /** How many keys one list page returns, so paging can be exercised. */
  pageSize = 1000;
  /** A write this returns true for is refused with `failureMessage`. */
  refuseWrite: (key: string) => boolean = () => false;
  failureMessage = "access denied";
  /** A write this returns true for is received and never answered: a stalled peer. */
  hangWrite: (key: string) => boolean = () => false;
  /** Runs when a write arrives, before it is stored or refused. */
  beforeWrite: ((key: string) => Promise<void>) | undefined;
  /** A read this returns true for sends part of the body and then goes quiet. */
  stallRead: (key: string) => boolean = () => false;
  /** Answer every read as if the bucket did not exist. */
  bucketMissing = false;

  private readonly uploads = new Map<string, Map<number, Buffer>>();
  private server: Server | undefined;
  private nextUpload = 1;

  async start(): Promise<string> {
    this.server = createServer((req, res) => {
      void this.handle(req, res);
    });
    await new Promise<void>((resolve) => this.server?.listen(0, "127.0.0.1", resolve));
    const { port } = this.server.address() as AddressInfo;
    return `http://127.0.0.1:${port}`;
  }

  async close(): Promise<void> {
    this.server?.closeAllConnections();
    await new Promise((resolve) => this.server?.close(resolve));
  }

  reset(): void {
    this.objects.clear();
    this.writes.length = 0;
    this.pageSize = 1000;
    this.refuseWrite = () => false;
    this.failureMessage = "access denied";
    this.hangWrite = () => false;
    this.beforeWrite = undefined;
    this.bucketMissing = false;
    this.stallRead = () => false;
    this.uploads.clear();
  }

  private body(req: IncomingMessage): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => resolve(Buffer.concat(chunks)));
      req.on("error", reject);
    });
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://x");
    // Path style: /<bucket>/<key>, and the key itself may hold slashes.
    const key = decodeURIComponent(url.pathname.split("/").slice(2).join("/"));
    const q = url.searchParams;
    const method = req.method ?? "GET";

    if (method === "GET" && q.get("list-type") === "2") return this.list(q, res);
    if (method === "POST" && q.has("uploads")) {
      const id = `upload-${this.nextUpload++}`;
      this.uploads.set(id, new Map());
      return xml(
        res,
        `<InitiateMultipartUploadResult><UploadId>${id}</UploadId></InitiateMultipartUploadResult>`,
      );
    }

    if (method === "PUT" || (method === "POST" && q.has("uploadId"))) {
      const body = await this.body(req);
      await this.beforeWrite?.(key);
      if (this.hangWrite(key)) return;
      if (this.refuseWrite(key)) return s3Error(res, 403, "AccessDenied", this.failureMessage);
      if (q.has("partNumber")) {
        this.uploads.get(q.get("uploadId") ?? "")?.set(Number(q.get("partNumber")), body);
        res.writeHead(200, { etag: `"part-${q.get("partNumber")}"` });
        return void res.end();
      }
      if (method === "POST") {
        const parts = this.uploads.get(q.get("uploadId") ?? "") ?? new Map<number, Buffer>();
        const ordered = [...parts.entries()].sort(([a], [b]) => a - b).map(([, part]) => part);
        this.store(key, Buffer.concat(ordered), req);
        this.uploads.delete(q.get("uploadId") ?? "");
        return xml(
          res,
          `<CompleteMultipartUploadResult><Location>x</Location><Key>${key}</Key><ETag>"done"</ETag></CompleteMultipartUploadResult>`,
        );
      }
      this.store(key, body, req);
      res.writeHead(200, { etag: '"done"' });
      return void res.end();
    }

    if (method === "DELETE") {
      this.uploads.delete(q.get("uploadId") ?? "");
      if (!q.has("uploadId")) this.objects.delete(key);
      res.writeHead(204);
      return void res.end();
    }

    if (method === "GET" && this.bucketMissing) {
      return s3Error(res, 404, "NoSuchBucket", "no such bucket");
    }

    if (method === "HEAD" || method === "GET") {
      const found = this.objects.get(key);
      if (!found) {
        if (method === "HEAD") {
          res.writeHead(404);
          return void res.end();
        }
        return s3Error(res, 404, "NoSuchKey", "no such key");
      }
      res.writeHead(200, { "content-length": String(found.body.length) });
      if (method === "GET" && this.stallRead(key)) {
        res.write(found.body.subarray(0, 1));
        return;
      }
      return void res.end(method === "GET" ? found.body : undefined);
    }

    res.writeHead(400);
    res.end();
  }

  private store(key: string, body: Buffer, req: IncomingMessage): void {
    this.objects.set(key, {
      body,
      contentType: req.headers["content-type"],
      cacheControl: req.headers["cache-control"],
    });
    this.writes.push(key);
  }

  private list(q: URLSearchParams, res: ServerResponse): void {
    const prefix = q.get("prefix") ?? "";
    const delimiter = q.get("delimiter");
    const after = q.get("continuation-token");
    const keys = [...this.objects.keys()].filter((k) => k.startsWith(prefix)).sort();
    const entries = new Set<string>();
    const direct: string[] = [];
    for (const k of keys) {
      const rest = k.slice(prefix.length);
      const cut = delimiter ? rest.indexOf(delimiter) : -1;
      if (cut >= 0) entries.add(prefix + rest.slice(0, cut + 1));
      else direct.push(k);
    }
    const all = [...direct.map((k) => ({ k })), ...[...entries].map((p) => ({ p }))];
    // A token past the last key returned, as S3's is, so deleting behind a page cannot skip anything.
    const nameOf = (e: { k: string } | { p: string }): string => ("k" in e ? e.k : e.p);
    all.sort((a, b) => (nameOf(a) < nameOf(b) ? -1 : 1));
    const start = after === null ? 0 : all.findIndex((e) => nameOf(e) > after);
    const remaining = start < 0 ? [] : all.slice(start);
    const page = remaining.slice(0, this.pageSize);
    const truncated = remaining.length > page.length;
    const next = truncated ? nameOf(page[page.length - 1] as { k: string }) : "";
    xml(
      res,
      "<ListBucketResult>" +
        `<IsTruncated>${truncated}</IsTruncated>` +
        (truncated ? `<NextContinuationToken>${next}</NextContinuationToken>` : "") +
        page
          .map((e) =>
            "k" in e
              ? `<Contents><Key>${e.k}</Key><Size>${this.objects.get(e.k)?.body.length ?? 0}</Size></Contents>`
              : `<CommonPrefixes><Prefix>${e.p}</Prefix></CommonPrefixes>`,
          )
          .join("") +
        "</ListBucketResult>",
    );
  }
}

function xml(res: ServerResponse, body: string): void {
  res.writeHead(200, { "content-type": "application/xml" });
  res.end(body);
}

function s3Error(res: ServerResponse, status: number, code: string, message: string): void {
  res.writeHead(status, { "content-type": "application/xml" });
  res.end(`<Error><Code>${code}</Code><Message>${message}</Message></Error>`);
}
