import { describe, expect, it, vi } from "vitest";
import {
  OutboundError,
  OutboundHttp,
  OutboundLimiter,
  type FetchImpl,
  type OutboundResponse,
} from "../common/outbound-http";

/** Build a fake {@link OutboundResponse} with the given body/status/headers. */
function response(opts: {
  ok?: boolean;
  status?: number;
  body?: string;
  bytes?: Buffer;
  headers?: Record<string, string>;
}): OutboundResponse {
  const headers = new Map(Object.entries(opts.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    ok: opts.ok ?? true,
    status: opts.status ?? 200,
    headers: { get: (name) => headers.get(name.toLowerCase()) ?? null },
    text: () => Promise.resolve(opts.body ?? ""),
    arrayBuffer: () => {
      const b = opts.bytes ?? Buffer.from(opts.body ?? "");
      return Promise.resolve(
        b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer,
      );
    },
  };
}

const UA = "beacon-server/test (ops@example.com)";

describe("OutboundHttp — typed outbound requests (`doc/spec/location-lookups.md` §1)", () => {
  it("getJson parses a 2xx JSON body and sends the identifying User-Agent", async () => {
    const fetchImpl = vi.fn<FetchImpl>().mockResolvedValue(response({ body: '{"a":1}' }));
    const http = new OutboundHttp({ userAgent: UA, timeoutMs: 1000, fetchImpl });
    const out = await http.getJson<{ a: number }>("https://x/y");
    expect(out).toEqual({ a: 1 });
    expect(fetchImpl.mock.calls[0]?.[1]?.headers?.["User-Agent"]).toBe(UA);
  });

  it("maps a non-2xx status to OutboundError('http') carrying the status", async () => {
    const fetchImpl = vi.fn<FetchImpl>().mockResolvedValue(response({ ok: false, status: 429 }));
    const http = new OutboundHttp({ userAgent: UA, timeoutMs: 1000, fetchImpl });
    await expect(http.getText("https://x")).rejects.toMatchObject({
      kind: "http",
      status: 429,
    } satisfies Partial<OutboundError>);
  });

  it("maps invalid JSON to OutboundError('parse')", async () => {
    const fetchImpl = vi.fn<FetchImpl>().mockResolvedValue(response({ body: "not json" }));
    const http = new OutboundHttp({ userAgent: UA, timeoutMs: 1000, fetchImpl });
    await expect(http.getJson("https://x")).rejects.toMatchObject({ kind: "parse" });
  });

  it("maps a rejecting fetch to OutboundError('network')", async () => {
    const fetchImpl = vi.fn<FetchImpl>().mockRejectedValue(new Error("ECONNREFUSED"));
    const http = new OutboundHttp({ userAgent: UA, timeoutMs: 1000, fetchImpl });
    await expect(http.getText("https://x")).rejects.toMatchObject({ kind: "network" });
  });

  it("aborts a slow call as OutboundError('timeout')", async () => {
    const fetchImpl: FetchImpl = (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      });
    const http = new OutboundHttp({ userAgent: UA, timeoutMs: 5, fetchImpl });
    await expect(http.getText("https://slow")).rejects.toMatchObject({ kind: "timeout" });
  });

  describe("getBytes — bounded blob download", () => {
    it("returns bytes + content-type under the ceiling", async () => {
      const bytes = Buffer.from("PNGDATA");
      const fetchImpl = vi
        .fn<FetchImpl>()
        .mockResolvedValue(response({ bytes, headers: { "content-type": "image/png" } }));
      const http = new OutboundHttp({ userAgent: UA, timeoutMs: 1000, fetchImpl });
      const out = await http.getBytes("https://img", 1000);
      expect(out.bytes.equals(bytes)).toBe(true);
      expect(out.contentType).toBe("image/png");
    });

    it("rejects on an oversize Content-Length before buffering", async () => {
      const fetchImpl = vi
        .fn<FetchImpl>()
        .mockResolvedValue(response({ headers: { "content-length": "999999" } }));
      const http = new OutboundHttp({ userAgent: UA, timeoutMs: 1000, fetchImpl });
      await expect(http.getBytes("https://img", 1000)).rejects.toMatchObject({ kind: "tooLarge" });
    });

    it("rejects when the read body outran the ceiling", async () => {
      const fetchImpl = vi
        .fn<FetchImpl>()
        .mockResolvedValue(response({ bytes: Buffer.alloc(2000) }));
      const http = new OutboundHttp({ userAgent: UA, timeoutMs: 1000, fetchImpl });
      await expect(http.getBytes("https://img", 1000)).rejects.toMatchObject({ kind: "tooLarge" });
    });
  });

  /**
   * Wikimedia rate-limits image bytes per IP and answers `429` + `Retry-After: 10`. Without a retry
   * budget that deferral was recorded as "this place has no photo", which is how a continent-scale
   * snapshot arrived with 204 photos out of 7,092 candidates.
   */
  describe("retrying a throttled response", () => {
    const throttled = (headers?: Record<string, string>): OutboundResponse =>
      response({ ok: false, status: 429, ...(headers ? { headers } : {}) });

    /** An {@link OutboundHttp} whose backoff sleeps are recorded instead of taken. */
    function retrying(fetchImpl: FetchImpl, maxRetries: number) {
      const slept: number[] = [];
      const http = new OutboundHttp({
        userAgent: UA,
        timeoutMs: 1000,
        fetchImpl,
        maxRetries,
        sleep: (ms) => {
          slept.push(ms);
          return Promise.resolve();
        },
      });
      return { http, slept };
    }

    it("waits out the Retry-After and re-issues the request", async () => {
      const fetchImpl = vi
        .fn<FetchImpl>()
        .mockResolvedValueOnce(throttled({ "retry-after": "10" }))
        .mockResolvedValueOnce(response({ body: '{"a":1}' }));
      const { http, slept } = retrying(fetchImpl, 3);
      expect(await http.getJson("https://x")).toEqual({ a: 1 });
      expect(slept).toEqual([10_000]);
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    });

    it("retries a 503 too — with maxlag set that also means 'come back'", async () => {
      const fetchImpl = vi
        .fn<FetchImpl>()
        .mockResolvedValueOnce(response({ ok: false, status: 503 }))
        .mockResolvedValueOnce(response({ body: "ok" }));
      const { http } = retrying(fetchImpl, 1);
      expect(await http.getText("https://x")).toBe("ok");
    });

    it("accepts an HTTP-date Retry-After as well as delta-seconds", async () => {
      const at = new Date(Date.now() + 8_000).toUTCString();
      const fetchImpl = vi
        .fn<FetchImpl>()
        .mockResolvedValueOnce(throttled({ "retry-after": at }))
        .mockResolvedValueOnce(response({ body: "ok" }));
      const { http, slept } = retrying(fetchImpl, 1);
      await http.getText("https://x");
      expect(slept[0]).toBeGreaterThan(6_000);
      expect(slept[0]).toBeLessThanOrEqual(8_000);
    });

    it("floors a Retry-After of 0 so it can't spin", async () => {
      const fetchImpl = vi
        .fn<FetchImpl>()
        .mockResolvedValueOnce(throttled({ "retry-after": "0" }))
        .mockResolvedValueOnce(response({ body: "ok" }));
      const { http, slept } = retrying(fetchImpl, 1);
      await http.getText("https://x");
      expect(slept).toEqual([500]);
    });

    it("gives up rather than wait out an unreasonable Retry-After", async () => {
      const fetchImpl = vi.fn<FetchImpl>().mockResolvedValue(throttled({ "retry-after": "3600" }));
      const { http, slept } = retrying(fetchImpl, 3);
      await expect(http.getText("https://x")).rejects.toMatchObject({ kind: "http", status: 429 });
      expect(slept).toEqual([]);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    });

    it("surfaces the throttle once the budget runs out", async () => {
      const fetchImpl = vi.fn<FetchImpl>().mockResolvedValue(throttled({ "retry-after": "1" }));
      const { http } = retrying(fetchImpl, 2);
      await expect(http.getText("https://x")).rejects.toMatchObject({ kind: "http", status: 429 });
      expect(fetchImpl).toHaveBeenCalledTimes(3); // the original + both retries
    });

    it("never retries a status that isn't a deferral", async () => {
      const fetchImpl = vi.fn<FetchImpl>().mockResolvedValue(response({ ok: false, status: 404 }));
      const { http } = retrying(fetchImpl, 3);
      await expect(http.getText("https://x")).rejects.toMatchObject({ status: 404 });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    });

    it("fails fast by default, so a request-path caller never holds a connection open", async () => {
      const fetchImpl = vi.fn<FetchImpl>().mockResolvedValue(throttled({ "retry-after": "10" }));
      const http = new OutboundHttp({ userAgent: UA, timeoutMs: 1000, fetchImpl });
      await expect(http.getText("https://x")).rejects.toMatchObject({ status: 429 });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    });
  });
});

describe("OutboundLimiter — minimum-interval throttle", () => {
  it("spaces consecutive acquisitions by minIntervalMs", async () => {
    let clock = 1000;
    const slept: number[] = [];
    const limiter = new OutboundLimiter(
      () => 1000,
      () => clock,
      (ms) => {
        slept.push(ms);
        clock += ms; // advance the injected clock as if we slept
        return Promise.resolve();
      },
    );
    await limiter.acquire(); // first — no wait
    await limiter.acquire(); // second — full interval
    await limiter.acquire(); // third — full interval
    expect(slept).toEqual([1000, 1000]);
  });

  it("does not throttle when the interval is non-positive", async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    const limiter = new OutboundLimiter(
      () => 0,
      () => 0,
      sleep,
    );
    await limiter.acquire();
    await limiter.acquire();
    expect(sleep).not.toHaveBeenCalled();
  });
});
