import type { ExecutionContext } from "@nestjs/common";
import { HttpException } from "@nestjs/common";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { describeClientKey } from "../common/client-key";
import { WriteRateLimitGuard } from "../common/rate-limit.guard";
import {
  DescriptorRateLimitGuard,
  PlayerReadRateLimitGuard,
  ReadRateLimitGuard,
} from "../common/read-rate-limit.guard";

/** The 429 shape every rate limiter throws, asserted identically wherever one is exercised. */
function expectRateLimited(call: () => unknown): void {
  try {
    call();
    throw new Error("expected a rate-limit rejection");
  } catch (err) {
    expect(err).toBeInstanceOf(HttpException);
    const e = err as HttpException;
    expect(e.getStatus()).toBe(429);
    expect(e.getResponse()).toMatchObject({ ok: false, error: "rateLimited" });
  }
}

/** Minimal ExecutionContext double carrying a request with a client IP. */
function ctx(ip: string): ExecutionContext {
  const req = { headers: {}, ip, socket: { remoteAddress: ip } };
  return {
    switchToHttp: () => ({ getRequest: () => req }),
  } as unknown as ExecutionContext;
}

describe("WriteRateLimitGuard (P2.3 write-op rate limiting)", () => {
  const saved = { ...process.env };
  beforeEach(() => {
    process.env["BEACON_WRITE_RATE_LIMIT_WINDOW_MS"] = "60000";
    process.env["BEACON_WRITE_RATE_LIMIT_MAX"] = "3";
  });
  afterEach(() => {
    process.env = { ...saved };
  });

  it("allows up to max then throws a 429 rateLimited for the same client", () => {
    const guard = new WriteRateLimitGuard();
    const c = ctx("1.2.3.4");
    for (let i = 0; i < 3; i++) expect(guard.canActivate(c)).toBe(true);
    expectRateLimited(() => guard.canActivate(c));
  });

  it("meters per-client independently", () => {
    const guard = new WriteRateLimitGuard();
    // Exhaust client A.
    for (let i = 0; i < 3; i++) guard.canActivate(ctx("10.0.0.1"));
    expect(() => guard.canActivate(ctx("10.0.0.1"))).toThrow(HttpException);
    // Client B is unaffected.
    expect(guard.canActivate(ctx("10.0.0.2"))).toBe(true);
  });

  it("keys on the resolved client IP, NOT a spoofable X-Forwarded-For", () => {
    const guard = new WriteRateLimitGuard();
    // Same resolved req.ip, a different (spoofed) x-forwarded-for on each call: all must share one
    // bucket, or an attacker rotating the header bypasses the limiter entirely.
    const spoof = (xff: string): ExecutionContext =>
      ({
        switchToHttp: () => ({
          getRequest: () => ({
            ip: "9.9.9.9",
            headers: { "x-forwarded-for": xff },
            socket: { remoteAddress: "9.9.9.9" },
          }),
        }),
      }) as unknown as ExecutionContext;
    for (let i = 0; i < 3; i++) expect(guard.canActivate(spoof(`1.1.1.${i}`))).toBe(true);
    expect(() => guard.canActivate(spoof("2.2.2.2"))).toThrow(HttpException);
  });
});

describe("the anonymous read guards", () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });

  it("allows up to max, throws the shared 429 shape, and meters per client", () => {
    process.env["BEACON_PLAYER_READ_RATE_LIMIT_MAX"] = "2";
    const guard = new PlayerReadRateLimitGuard();
    const c = ctx("1.2.3.4");
    expect(guard.canActivate(c)).toBe(true);
    expect(guard.canActivate(c)).toBe(true);
    expectRateLimited(() => guard.canActivate(c));
    expect(guard.canActivate(ctx("9.9.9.9"))).toBe(true); // an IP is the only key an anonymous read has
  });

  it("keeps three separate budgets, so no read class can starve another", () => {
    // The reference data, the hot path and the door are deliberately not pooled: a map pan must not
    // be able to starve a place lookup, and neither may close the door a new client walks through.
    process.env["BEACON_PLAYER_READ_RATE_LIMIT_MAX"] = "1";
    process.env["BEACON_PLACES_READ_RATE_LIMIT_MAX"] = "1";
    process.env["BEACON_DESCRIPTOR_RATE_LIMIT_MAX"] = "1";
    const player = new PlayerReadRateLimitGuard();
    const reference = new ReadRateLimitGuard();
    const descriptor = new DescriptorRateLimitGuard();
    const c = ctx("1.2.3.4");

    expect(player.canActivate(c)).toBe(true);
    expectRateLimited(() => player.canActivate(c));
    expect(reference.canActivate(c)).toBe(true);
    expect(descriptor.canActivate(c)).toBe(true);
  });

  it("cannot let the hot path close the door, which is why the descriptor is separate", () => {
    // Budgets are per KEY, not per client. On a shared egress, or on any deployment where
    // BEACON_TRUST_PROXY is unset behind an edge, every caller collapses onto one key: a few dozen
    // panning clients would then spend a shared budget and 429 the next client's add-a-server fetch.
    process.env["BEACON_PLAYER_READ_RATE_LIMIT_MAX"] = "2";
    const player = new PlayerReadRateLimitGuard();
    const descriptor = new DescriptorRateLimitGuard();
    const shared = ctx("1.2.3.4");

    player.canActivate(shared);
    player.canActivate(shared);
    expectRateLimited(() => player.canActivate(shared)); // the hot path is spent

    expect(descriptor.canActivate(shared)).toBe(true); // onboarding still works
  });

  it("defaults far above honest play, so it binds a crawler rather than a player", () => {
    // 600/60s is a backstop, not the primary throttle: it has to survive a hard map pan fanned out
    // across several covering servers without firing. Pins the shipped default rather than the prose.
    const guard = new PlayerReadRateLimitGuard();
    const c = ctx("1.2.3.4");
    for (let i = 0; i < 600; i += 1) guard.canActivate(c);
    expectRateLimited(() => guard.canActivate(c));
  });
});

describe("describeClientKey (the boot line an operator checks)", () => {
  it("distinguishes unset from deliberately off from a value it could not parse", () => {
    // The three collapse to `false` in `parseTrustProxy`, and the boot line is the only place an
    // operator finds out which one they are in. Reporting a typo as "unset" is the reading most
    // likely to be dismissed, since someone who never set it knows they never set it.
    expect(describeClientKey(false)).toContain("unset");
    expect(describeClientKey(false, "")).toContain("unset");
    expect(describeClientKey(false, "0")).toContain("BEACON_TRUST_PROXY=0");
    expect(describeClientKey(false, "false")).toContain("BEACON_TRUST_PROXY=false");

    const typo = describeClientKey(false, "yes");
    expect(typo).toContain("NOT UNDERSTOOD");
    expect(typo).not.toContain("unset");
  });

  it("names the hop count when the proxy is trusted", () => {
    expect(describeClientKey(1)).toContain("x-forwarded-for");
    expect(describeClientKey(2)).toContain("trust 2");
  });
});
