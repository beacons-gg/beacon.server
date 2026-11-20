import { intEnv } from "./env";

/**
 * A fixed-window rate limiter keyed by a caller-supplied string — the **verified sender DID** for
 * the signed capability endpoints (mailbox / media, `doc/spec/mailbox-and-media.md` §3.4). It
 * mirrors the IP-keyed {@link WriteRateLimitGuard} but keys on the cryptographic actor rather than
 * the client IP, so a per-**account** send/upload budget is enforceable (an IP limit can't
 * distinguish accounts behind a NAT, and a DID can't be rotated the way an IP can).
 *
 * In-process + per-instance by design (one server process per database). A multi-instance deploy
 * would need a shared limiter — the same deferred trigger as the IP guard.
 */
export class DidRateLimiter {
  /** key -> current window {start, count}. Pruned lazily when the map grows large. */
  private readonly hits = new Map<string, { start: number; count: number }>();
  /** When the last full sweep ran, so a large map cannot make every rollover pay for one. */
  private lastPruneAt = 0;

  /**
   * The budget is **held, not copied**, so a limiter built over an accessor-backed config tracks an
   * admin's change (`doc/spec/runtime-settings.md` §5). Reading per check rather than rebuilding
   * the limiter is deliberate: a rebuild would drop every in-flight window, which hands a full
   * fresh budget to every caller currently being throttled and makes "ask an operator to nudge the
   * setting" a way around the limit. Re-reading changes only what the next check compares against,
   * and both directions are safe — a shorter window expires sooner, a lower max refuses sooner, and
   * neither corrupts a window already in progress.
   */
  constructor(private readonly opts: { readonly windowMs: number; readonly max: number }) {}

  /**
   * How many keys are currently tracked. Exists so {@link pruneIfLarge}'s two promises, the size
   * bound and the once-per-window cooldown, are checkable rather than merely asserted in a comment.
   */
  get size(): number {
    return this.hits.size;
  }

  /**
   * Record one request for `key`. Returns `true` if it's within budget for the current window,
   * `false` once the window is exhausted (the caller then rejects with 429).
   */
  check(key: string, now: number = Date.now()): boolean {
    const entry = this.hits.get(key);
    if (!entry || now - entry.start >= this.opts.windowMs) {
      this.hits.set(key, { start: now, count: 1 });
      this.pruneIfLarge(now);
      return true;
    }
    entry.count += 1;
    return entry.count <= this.opts.max;
  }

  /**
   * Keep the map bounded: drop entries whose window has fully elapsed.
   *
   * Rate-limited to one sweep per window, which matters once a limiter is keyed on **every** actor
   * rather than a subset. The sweep is an O(n) scan fired from a new-window insert, and a map that
   * is over the threshold and mostly *live* frees nothing on each pass, so an unbounded version
   * would scan again on the very next rollover: with N active accounts that is on the order of N
   * full N-entry scans per window, and on the room path it would run under the per-room lock.
   * Bounding it costs one comparison and keeps the map's size guarantee intact, since anything the
   * sweep would have freed is by definition idle and gets overwritten on its owner's next request.
   */
  private pruneIfLarge(now: number): void {
    if (this.hits.size < 10_000) return;
    // Read once: the sweep is ≥10,000 iterations and the accessor behind this is a chain through the
    // config slice to the settings cache. It cannot change mid-loop — the loop is synchronous.
    const windowMs = this.opts.windowMs;
    if (now - this.lastPruneAt < windowMs) return;
    this.lastPruneAt = now;
    for (const [k, v] of this.hits) {
      if (now - v.start >= windowMs) this.hits.delete(k);
    }
  }
}

/**
 * A limiter wired to the conventional `BEACON_<prefix>_RATE_LIMIT_{WINDOW_MS,MAX}` knob pair, which
 * every per-DID and per-IP budget on the server follows. Having one factory makes that convention
 * enforced rather than merely observed, and keeps a new budget from inventing a fourth spelling.
 */
export function envLimiter(prefix: string, maxDefault: number): DidRateLimiter {
  return new DidRateLimiter({
    windowMs: intEnv(`${prefix}_WINDOW_MS`, 60_000),
    max: intEnv(`${prefix}_MAX`, maxDefault),
  });
}
