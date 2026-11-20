import { describe, expect, it } from "vitest";
import { DidRateLimiter, envLimiter } from "../common/did-rate-limit";

const WINDOW = 60_000;
/** The size at which `pruneIfLarge` starts sweeping. */
const PRUNE_THRESHOLD = 10_000;

const limiter = (max = 1000): DidRateLimiter => new DidRateLimiter({ windowMs: WINDOW, max });

/** Fill `n` distinct keys at `t`, so their windows all start together. */
function fill(l: DidRateLimiter, n: number, t: number, prefix = "k"): void {
  for (let i = 0; i < n; i += 1) l.check(`${prefix}${i}`, t);
}

describe("DidRateLimiter — the window", () => {
  it("allows up to max in a window and refuses past it, per key", () => {
    const l = limiter(2);
    expect(l.check("a", 0)).toBe(true);
    expect(l.check("a", 1)).toBe(true);
    expect(l.check("a", 2)).toBe(false);
    expect(l.check("b", 2)).toBe(true); // its own window
  });

  it("starts a fresh window once the old one has fully elapsed", () => {
    const l = limiter(1);
    expect(l.check("a", 0)).toBe(true);
    expect(l.check("a", WINDOW - 1)).toBe(false);
    expect(l.check("a", WINDOW)).toBe(true);
  });
});

describe("DidRateLimiter — the prune is bounded to one sweep per window", () => {
  it("does not scan below the threshold, so a small map keeps every key", () => {
    const l = limiter();
    fill(l, 100, 0);
    l.check("late", WINDOW * 5); // long past every window, but the map is small
    expect(l.size).toBe(101);
  });

  it("sweeps once past the threshold, dropping only the elapsed windows", () => {
    const l = limiter();
    fill(l, PRUNE_THRESHOLD, 0);
    expect(l.size).toBe(PRUNE_THRESHOLD);

    // A new window opening a full window later: the sweep runs and every key above is elapsed.
    l.check("fresh", WINDOW);
    expect(l.size).toBe(1);
  });

  it("does not sweep again inside the same window, which is the regression this guards", () => {
    // A map that is over the threshold and mostly LIVE frees nothing per pass. Without the
    // cooldown, every new-window insert would pay a full O(n) scan and free nothing, so N active
    // accounts cost on the order of N scans of N entries per window, under the per-room lock on
    // the op path.
    const l = limiter();
    fill(l, PRUNE_THRESHOLD, 0);
    l.check("sweeper", WINDOW); // the one allowed sweep; drops all 10k
    expect(l.size).toBe(1);

    // Refill with live entries, then age exactly one of them out and open new windows repeatedly.
    fill(l, PRUNE_THRESHOLD, WINDOW, "live");
    expect(l.size).toBe(PRUNE_THRESHOLD + 1);

    // Still inside the cooldown: these inserts add keys and none of them triggers a scan, so the
    // long-elapsed "sweeper" entry survives even though a sweep would have freed it.
    for (let i = 0; i < 5; i += 1) l.check(`probe${i}`, WINDOW + 1);
    expect(l.size).toBe(PRUNE_THRESHOLD + 6);

    // A full window later the cooldown has expired, so the next new window sweeps again and the
    // stale generation goes.
    l.check("after", WINDOW * 2 + 2);
    expect(l.size).toBe(1);
  });
});

describe("envLimiter", () => {
  it("reads the conventional knob pair and falls back to the given default", () => {
    process.env["BEACON_TEST_RATE_LIMIT_MAX"] = "1";
    try {
      const l = envLimiter("BEACON_TEST_RATE_LIMIT", 999);
      expect(l.check("a", 0)).toBe(true);
      expect(l.check("a", 1)).toBe(false); // the env max, not the default

      // The unset window knob falls back to 60s, so a fresh window opens exactly there.
      expect(l.check("a", WINDOW)).toBe(true);
    } finally {
      delete process.env["BEACON_TEST_RATE_LIMIT_MAX"];
    }
  });
});
