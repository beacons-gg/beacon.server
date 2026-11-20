/**
 * The server's outbound-HTTP seam (`doc/spec/location-lookups.md` §1). The `geocode` capability
 * proxies Nominatim, which demands **fair use** — an identifying `User-Agent`, a bounded request
 * rate, and a timeout so a slow upstream can't pin a request — and the places import paths fetch
 * volumes and re-host media through the same discipline.
 *
 * This module is deliberately dependency-free (Node 22 global `fetch`) and fully injectable — the
 * `fetch` impl, the clock, and the sleep are constructor args so tests drive every path (timeout,
 * network error, non-2xx, oversize, throttle) without a live network. Every failure surfaces as a typed
 * {@link OutboundError}; a caller maps it to `503` and never lets it become a `500`.
 */

/** The minimal response surface used here — avoids a DOM/undici type dependency in the injected impl. */
export interface OutboundResponse {
  readonly ok: boolean;
  readonly status: number;
  readonly headers: { get(name: string): string | null };
  text(): Promise<string>;
  arrayBuffer(): Promise<ArrayBuffer>;
}

/** The injectable `fetch` shape (a subset of the global). Default impl is Node's global `fetch`. */
export type FetchImpl = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; signal?: AbortSignal },
) => Promise<OutboundResponse>;

/** Why an outbound call failed — the caller maps every kind to a soft `503`, never a `500`. */
export type OutboundFailureKind = "timeout" | "network" | "http" | "tooLarge" | "parse";

/** A typed outbound failure carrying the failure {@link OutboundFailureKind} (+ HTTP status for `http`). */
export class OutboundError extends Error {
  constructor(
    readonly kind: OutboundFailureKind,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "OutboundError";
  }
}

/** The real sleep, shared by the two things here that wait — both take it injected for tests. */
const sleepDefault = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A minimum-interval throttle for one upstream (`doc/spec/location-lookups.md` §3). Serializes
 * acquisitions so consecutive outbound calls are spaced by at least `minIntervalMs` — the honest
 * way to respect Nominatim's ~1 req/s. `minIntervalMs <= 0` disables throttling. The clock and the
 * sleep are injectable so tests assert spacing without real timers.
 */
export class OutboundLimiter {
  private nextAt = 0;

  /**
   * `minIntervalMs` is a thunk, always, so a caller can pace against a setting an operator edits at
   * runtime (`doc/spec/runtime-settings.md` §5) rather than against whatever it was at boot. Read
   * per acquisition: raising the interval slows the *next* slot rather than retroactively pushing
   * out one already granted, which is what an operator asking the server to be politer to an
   * upstream expects. A fixed pace is spelled `() => 0` rather than admitting a second parameter
   * shape — one idiom is worth more here than saving four characters at three call sites.
   */
  constructor(
    private readonly minIntervalMs: () => number,
    private readonly now: () => number = () => Date.now(),
    private readonly sleep: (ms: number) => Promise<void> = sleepDefault,
  ) {}

  /** Resolve once a slot is available, sleeping out any remaining gap since the last acquisition. */
  async acquire(): Promise<void> {
    const minIntervalMs = this.minIntervalMs();
    if (minIntervalMs <= 0) return;
    const now = this.now();
    const at = Math.max(now, this.nextAt);
    this.nextAt = at + minIntervalMs;
    const wait = at - now;
    if (wait > 0) await this.sleep(wait);
  }
}

export interface OutboundHttpOptions {
  /** Identifying `User-Agent` (fair-use requirement) — e.g. `beacon-server/0.0.1 (ops@example.com)`. */
  userAgent: string;
  /** Per-request timeout (ms) before the call is aborted with an `OutboundError("timeout")`. */
  timeoutMs: number;
  /** Injectable fetch (default: global `fetch`). */
  fetchImpl?: FetchImpl;
  /**
   * How many times a **throttled** response (`429`/`503`) is re-issued after waiting out its
   * `Retry-After`. Default `0` — a request-path caller must fail fast rather than hold a client
   * connection open for someone else's backoff. Background work (media transfer's re-hosting) sets a
   * budget instead, because for it a throttle is a "come back", not an answer.
   */
  maxRetries?: number;
  /**
   * Longest single backoff this client will wait out (default 30s). An upstream is free to ask for an
   * hour; a caller is not free to wait one, and how long it *may* wait is the caller's business —
   * hence an option beside `maxRetries` rather than a constant in here. Together they make the worst
   * case statable: `maxRetries × maxBackoffMs`.
   */
  maxBackoffMs?: number;
  /** Injectable sleep, so tests assert backoff without real timers. */
  sleep?: (ms: number) => Promise<void>;
}

/** Options for a single outbound request. */
export interface OutboundRequestOptions {
  /** Optional upstream throttle to acquire before the call. */
  limiter?: OutboundLimiter;
  /** Extra request headers (merged over the `User-Agent`). */
  headers?: Record<string, string>;
  /** Per-request timeout override (ms). */
  timeoutMs?: number;
  /**
   * Per-request retry-budget override, mirroring `timeoutMs`. `0` opts one call out of the client's
   * budget — for a lookup whose result is *optional*, where waiting out a throttle buys nothing but
   * dead time in a strictly sequential run.
   */
  maxRetries?: number;
}

/**
 * A small, typed outbound-HTTP client bound to one identity + default timeout. `getJson` / `getText`
 * fetch a document; `getBytes` downloads a blob with a hard size ceiling (import-media transfer).
 * All map failures to {@link OutboundError}.
 */
/** A paced outbound pair — share ONE per upstream budget (a second limiter doubles the rate). */
export interface OutboundClient {
  http: OutboundHttp;
  limiter: OutboundLimiter;
}

/**
 * Floor for a backoff wait, so a `Retry-After: 0` can't spin. A spin guard rather than a budget —
 * unlike the ceiling, it isn't a caller's decision, so it stays a constant.
 */
const MIN_BACKOFF_MS = 500;

/** Default ceiling for one backoff wait; overridable per client via `maxBackoffMs`. */
const DEFAULT_MAX_BACKOFF_MS = 30_000;

/** The statuses that mean "come back later" rather than "no" — both are retried, never counted as a failure. */
const THROTTLED = new Set([429, 503]);

export class OutboundHttp {
  private readonly fetchImpl: FetchImpl;
  private readonly defaultMaxRetries: number;
  private readonly maxBackoffMs: number;
  private readonly sleep: (ms: number) => Promise<void>;

  /**
   * The two operator-editable options, `userAgent` and `timeoutMs`, are **read from `opts` per
   * request** rather than copied here, so a client built at boot tracks a setting an admin changes
   * later (`doc/spec/runtime-settings.md` §5). The rest are wiring, not policy, and are captured as
   * before.
   */
  constructor(private readonly opts: OutboundHttpOptions) {
    this.fetchImpl = opts.fetchImpl ?? (fetch as unknown as FetchImpl);
    this.defaultMaxRetries = opts.maxRetries ?? 0;
    this.maxBackoffMs = opts.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS;
    this.sleep = opts.sleep ?? sleepDefault;
  }

  private get defaultTimeoutMs(): number {
    return this.opts.timeoutMs;
  }

  /** GET + parse JSON. Throws `OutboundError("parse")` on non-JSON, `("http")` on a non-2xx status. */
  async getJson<T>(url: string, opts: OutboundRequestOptions = {}): Promise<T> {
    return this.parseJson<T>(await this.getText(url, opts), url);
  }

  /** GET + return the response text (2xx only). */
  async getText(url: string, opts: OutboundRequestOptions = {}): Promise<string> {
    const res = await this.request("GET", url, opts);
    return res.text();
  }

  /** Parse a response body as JSON, mapping a non-JSON body to `OutboundError("parse")`. */
  private parseJson<T>(body: string, url: string): T {
    try {
      return JSON.parse(body) as T;
    } catch {
      throw new OutboundError("parse", `invalid JSON from ${url}`);
    }
  }

  /**
   * GET raw bytes with a hard `maxBytes` ceiling (image download). Rejects **before** buffering when the
   * upstream advertises an oversize `Content-Length`, and again after read if the body outran it, with
   * `OutboundError("tooLarge")`.
   */
  async getBytes(
    url: string,
    maxBytes: number,
    opts: OutboundRequestOptions = {},
  ): Promise<{ bytes: Buffer; contentType: string }> {
    const res = await this.request("GET", url, opts);
    const declared = Number(res.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > maxBytes) {
      throw new OutboundError("tooLarge", `content-length ${declared} exceeds ${maxBytes}`);
    }
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > maxBytes) {
      throw new OutboundError("tooLarge", `body ${buf.length} exceeds ${maxBytes}`);
    }
    return {
      bytes: buf,
      contentType: res.headers.get("content-type") ?? "application/octet-stream",
    };
  }

  /**
   * The shared request path: throttle → timed fetch → status gate. All errors become `OutboundError`.
   *
   * A `429`/`503` is a *deferral*, not an answer, so with a retry budget it is waited out and
   * re-issued rather than surfaced. Without one (the default) it throws immediately, exactly as
   * before — a caller on the request path would otherwise hold a client connection open through
   * someone else's rate limit.
   */
  private async request(
    method: string,
    url: string,
    opts: OutboundRequestOptions,
  ): Promise<OutboundResponse> {
    const maxRetries = opts.maxRetries ?? this.defaultMaxRetries;
    for (let attempt = 0; ; attempt++) {
      const res = await this.attempt(method, url, opts);
      if (res.ok) return res;
      const wait = attempt < maxRetries ? backoffFor(res, this.maxBackoffMs) : undefined;
      if (wait === undefined) {
        throw new OutboundError("http", `${url} returned ${res.status}`, res.status);
      }
      await this.sleep(wait);
    }
  }

  /** One timed, throttled attempt. Returns the response whatever its status; only I/O throws. */
  private async attempt(
    method: string,
    url: string,
    opts: OutboundRequestOptions,
  ): Promise<OutboundResponse> {
    if (opts.limiter) await opts.limiter.acquire();
    const controller = new AbortController();
    const timeoutMs = opts.timeoutMs ?? this.defaultTimeoutMs;
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res: OutboundResponse;
    try {
      res = await this.fetchImpl(url, {
        method,
        headers: { "User-Agent": this.opts.userAgent, ...opts.headers },
        signal: controller.signal,
      });
    } catch (err) {
      if (controller.signal.aborted) {
        throw new OutboundError("timeout", `${url} timed out after ${timeoutMs}ms`);
      }
      throw new OutboundError("network", `${url} failed: ${(err as Error).message}`);
    } finally {
      clearTimeout(timer);
    }
    return res;
  }
}

/**
 * How long to wait before re-issuing a throttled response, or `undefined` if it shouldn't be
 * retried at all — a non-throttling status, or a `Retry-After` longer than `maxBackoffMs`.
 *
 * `Retry-After` is either delta-seconds or an HTTP-date (RFC 9110); both forms appear in the wild,
 * so both are read. A missing or unparseable value falls back to the floor rather than to zero.
 */
function backoffFor(res: OutboundResponse, maxBackoffMs: number): number | undefined {
  if (!THROTTLED.has(res.status)) return undefined;
  const asked = retryAfterMs(res.headers.get("retry-after"));
  if (asked !== undefined && asked > maxBackoffMs) return undefined; // longer than the work can wait
  return Math.max(asked ?? 0, MIN_BACKOFF_MS);
}

/** A `Retry-After` header in ms — delta-seconds or an HTTP-date; `undefined` when neither parses. */
function retryAfterMs(header: string | null): number | undefined {
  const raw = header?.trim();
  if (!raw) return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const at = Date.parse(raw);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : undefined;
}
