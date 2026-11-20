import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
} from "@nestjs/common";
import { type ClientKeyRequest, clientKey } from "./client-key";
import { boolEnv, intEnv } from "./env";

/** The slice of the Express request the limiter reads (avoids an `@types/express` dep). */
interface RateLimitRequest extends ClientKeyRequest {
  method?: string;
  originalUrl?: string;
  url?: string;
}

/** Per-client window state: when it started, how many writes, and a per-route tally for diagnostics. */
interface WindowState {
  start: number;
  count: number;
  /** normalized `"METHOD /path"` -> count within this window; powers the breach breakdown log. */
  routes: Map<string, number>;
  /** whether we've already emitted the "approaching limit" warning this window (log once). */
  warned: boolean;
}

/**
 * Fixed-window per-client rate limiter for **write** ops. Applied to the state-changing POST routes
 * (`/rooms`, `/rooms/:id/ops`, `/scouts`, `/profiles`); GETs are unlimited. On breach it throws the
 * same `{ok:false,error:"rateLimited"}` shape the OpResult table maps to **429**
 * (`rooms/http-status.ts`), so the client's existing branch handles it.
 *
 * In-process and per-instance by design (one server process per database). A multi-instance deploy
 * would need a shared limiter, but that is deferred with the same trigger as multi-instance
 * concurrency control.
 *
 * **Diagnostics.** Because a single automatic write loop (e.g. a scout heartbeat) can silently drain
 * the budget and make an unrelated action — like taking from a jar — fail with `rateLimited`, the
 * guard keeps a per-window per-route tally per client and logs it:
 *   - `warn` when a client crosses 80% of the budget (early warning, once per window);
 *   - `warn` on every breach, with the full route breakdown and the blocked route;
 *   - `debug` on every guarded request when `BEACON_WRITE_RATE_LIMIT_DEBUG` is truthy (verbose; opt-in).
 * The breakdown answers "what ate my budget" without a repro.
 */
@Injectable()
export class WriteRateLimitGuard implements CanActivate {
  private readonly logger = new Logger("WriteRateLimit");
  private readonly windowMs: number;
  private readonly max: number;
  private readonly debug: boolean;
  /** client key -> window state. Pruned lazily as windows roll over. */
  private readonly hits = new Map<string, WindowState>();

  constructor() {
    const limit = readLimit();
    this.windowMs = limit.windowMs;
    this.max = limit.max;
    this.debug = boolEnv("BEACON_WRITE_RATE_LIMIT_DEBUG");
  }

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<RateLimitRequest>();
    const key = clientKey(req);
    const route = requestRoute(req);
    const now = Date.now();
    const entry = this.hits.get(key);

    if (!entry || now - entry.start >= this.windowMs) {
      this.hits.set(key, { start: now, count: 1, routes: new Map([[route, 1]]), warned: false });
      this.pruneIfLarge(now);
      if (this.debug) this.logger.debug(`${key} ${route} 1/${this.max} (new window)`);
      return true;
    }

    entry.count += 1;
    entry.routes.set(route, (entry.routes.get(route) ?? 0) + 1);
    if (this.debug) this.logger.debug(`${key} ${route} ${entry.count}/${this.max}`);

    // Diagnostics: `key count/max elapsed routes={…}` is the shared shape both the early-warning and
    // the breach logs report, so a runaway loop is fingerprintable either way.
    const stats = () =>
      `key=${key} count=${entry.count}/${this.max} elapsed=${now - entry.start}ms ` +
      `routes={${routeBreakdown(entry.routes)}}`;

    // Early warning: a client is on track to breach — log once, *before* an innocent request is rejected.
    if (!entry.warned && entry.count >= Math.floor(this.max * 0.8)) {
      entry.warned = true;
      this.logger.warn(`client approaching write limit: ${stats()}`);
    }

    if (entry.count > this.max) {
      this.logger.warn(
        `write rate limit breached: ${stats()} window=${this.windowMs}ms blocked=${route}`,
      );
      throw new HttpException(
        { ok: false, error: "rateLimited", message: "too many write requests" },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    return true;
  }

  /** Keep the map bounded — drop entries whose window has fully elapsed. */
  private pruneIfLarge(now: number): void {
    if (this.hits.size < 10_000) return;
    for (const [k, v] of this.hits) {
      if (now - v.start >= this.windowMs) this.hits.delete(k);
    }
  }
}

/**
 * `"METHOD /normalized/path"` for diagnostics. Dynamic ids are collapsed (`/rooms/x@h/ops` ->
 * `/rooms/:id/ops`) so the per-route tally stays compact and groups by shape, not by target.
 */
function requestRoute(req: RateLimitRequest): string {
  const method = req.method ?? "?";
  const raw = req.originalUrl ?? req.url ?? "?";
  const path = raw.split("?")[0] ?? raw;
  const normalized = path
    .replace(/^\/rooms\/[^/]+\/ops$/, "/rooms/:id/ops")
    .replace(/^\/rooms\/[^/]+$/, "/rooms/:id");
  return `${method} ${normalized}`;
}

/** Render a routes tally as `route×count` pairs, busiest first — the "what ate the budget" summary. */
function routeBreakdown(routes: Map<string, number>): string {
  return [...routes.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([route, n]) => `${route}×${n}`)
    .join(", ");
}

interface WriteLimit {
  windowMs: number;
  max: number;
}

/** Read the write-rate-limit knobs from env (`intEnv`, sane defaults). `main.ts` validates the rest of the config at boot. */
function readLimit(): WriteLimit {
  const windowMs = intEnv("BEACON_WRITE_RATE_LIMIT_WINDOW_MS", 60_000);
  const max = intEnv("BEACON_WRITE_RATE_LIMIT_MAX", 120);
  return { windowMs, max };
}
