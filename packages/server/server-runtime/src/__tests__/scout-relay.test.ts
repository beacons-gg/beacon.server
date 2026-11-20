import { DEFAULT_PRECISION, encode } from "@beaconsgg/geo";
import type { MapDelta, ScoutReportParams } from "@beaconsgg/protocol-types";
import { beforeEach, describe, expect, it } from "vitest";
import { ScoutRelay } from "../scout-relay";

const OWNER = "did:key:z6MkScout1";
const STRANGER = "did:key:z6MkStranger";
const NOW = Date.parse("2026-06-29T00:00:00Z");
const reportedAt = (ms = NOW) => new Date(ms).toISOString();
/** A report received at `ms` on the server's clock, signed by a client whose clock reads `ms + skewMs`. */
const at = (ms = NOW, skewMs = 0) => ({
  reportedAt: reportedAt(ms),
  issuedAt: reportedAt(ms + skewMs),
});

const HERE = { lat: 47.61, lng: -122.34 };
const CELL = encode(HERE, DEFAULT_PRECISION);
const ELSEWHERE_CELL = encode({ lat: 0, lng: 0 }, DEFAULT_PRECISION);

// Baked config (display data, trusted under radical trust) + stub provenance. The relay checks only
// single-writer ownership + the TTL horizon — it does NOT validate the config caps (the controller
// verifies `mintedBy`; movement caps are the client's job, beacon.core `doc/spec/identity.md` §3
// and `doc/spec/discovery.md` §5).
const CONFIG = {
  scoutType: "Sky",
  label: "Sky",
  maxSpeedId: 2,
  maxMoveDistanceMi: 400,
  maxResources: 2,
};
const MINTED = { id: "did:key:z6MkStub", sig: "stub" };
function params(unique: string, over: Partial<ScoutReportParams> = {}): ScoutReportParams {
  return {
    unique,
    config: CONFIG,
    mintedBy: MINTED,
    movement: { lastKnownLocation: HERE, locationTimestamp: reportedAt(), speedKmh: 0 },
    expiresAt: reportedAt(NOW + 300_000), // 5 min
    ...over,
  };
}

describe("ScoutRelay", () => {
  let relay: ScoutRelay;
  let deltas: MapDelta[];
  let audiences: (readonly string[])[];
  beforeEach(() => {
    deltas = [];
    audiences = [];
    relay = new ScoutRelay({
      broadcast: (d, games) => {
        deltas.push(d);
        audiences.push(games);
      },
    });
  });

  it("serves only the listed games' scouts when asked, and every scout when not", () => {
    relay.report(OWNER, params("a"), at(), "game-a");
    relay.report(OWNER, params("b"), at(), "game-b");
    relay.report(OWNER, params("x"), at()); // reported without a game
    expect(relay.scoutsInView([CELL], NOW, ["game-a"]).map((s) => s.id)).toEqual(["a"]);
    expect(
      relay
        .scoutsInView([CELL], NOW)
        .map((s) => s.id)
        .sort(),
    ).toEqual(["a", "b", "x"]);
  });

  it("sends a scout's marker and its tombstone to its own game", () => {
    relay.report(OWNER, params("a"), at(), "game-a");
    relay.cancel(OWNER, "a");
    relay.report(OWNER, params("x"), at());
    expect(audiences).toEqual([["game-a"], ["game-a"], []]);
  });

  it("reports a scout and serves it by interpolated cell", () => {
    expect(relay.report(OWNER, params("s1"), at())).toEqual({ ok: true });
    expect(relay.scoutsInView([CELL], NOW).map((s) => s.id)).toEqual(["s1"]);
    expect(relay.scoutsInView([ELSEWHERE_CELL], NOW)).toEqual([]);
  });

  it("trusts the client's movement — no server-side cap enforcement (radical trust)", () => {
    // The relay is a bulletin board, not a cheat referee (beacon.core `doc/spec/identity.md` §3): a
    // report faster than the config's max speed and to a farther destination than its max distance
    // is accepted and stored. Movement caps are the owner's client-side math (beacon.core
    // `doc/spec/discovery.md` §5); the server only relays.
    const beyondCaps = params("f1", {
      movement: {
        lastKnownLocation: HERE,
        locationTimestamp: reportedAt(),
        destination: { lat: 0, lng: 0 }, // thousands of km past the "cap"
        speedKmh: 80, // past the maxSpeedId-2 "cap"
      },
    });
    expect(relay.report(OWNER, beyondCaps, at())).toEqual({ ok: true });
    expect(relay.scoutsInView([CELL], NOW).map((s) => s.id)).toEqual(["f1"]);
  });

  it("only the original owner may refresh a unique", () => {
    relay.report(OWNER, params("s2"), at());
    expect(relay.report(STRANGER, params("s2"), at(NOW + 1000))).toEqual({
      ok: false,
      error: "denied",
    });
  });

  it("rejects an expiry beyond the TTL horizon (can't squat the map)", () => {
    const farFuture = reportedAt(NOW + 2 * 60 * 60_000); // 2h > 1h horizon
    expect(relay.report(OWNER, params("s3", { expiresAt: farFuture }), at())).toEqual({
      ok: false,
      error: "invalid",
    });
    expect(relay.scoutsInView([CELL], NOW)).toEqual([]); // not stored
  });

  describe("expiry runs on the server's clock, for the length the client asked for", () => {
    const TEN_MIN = 10 * 60_000;
    const FIVE_MIN = 5 * 60_000;
    /** A report whose `expiresAt` is five minutes past the client's own clock, as the SDK stamps it. */
    const fromClientClock = (unique: string, skewMs: number) => {
      const expiresAt = reportedAt(NOW + skewMs + FIVE_MIN);
      return relay.report(OWNER, params(unique, { expiresAt }), at(NOW, skewMs));
    };
    const expiryOf = (unique: string) =>
      relay.scoutsInView([CELL], NOW).find((s) => s.id === unique)?.expiresAt;

    it("gives a client 10 minutes slow its full five minutes, not an already-expired report", () => {
      expect(fromClientClock("slow", -TEN_MIN)).toEqual({ ok: true });
      expect(expiryOf("slow")).toBe(reportedAt(NOW + FIVE_MIN));
    });

    it("gives a client 10 minutes fast five minutes, not fifteen", () => {
      expect(fromClientClock("fast", TEN_MIN)).toEqual({ ok: true });
      expect(expiryOf("fast")).toBe(reportedAt(NOW + FIVE_MIN));
      relay.sweepExpired(NOW + FIVE_MIN);
      expect(relay.scoutsInView([CELL], NOW)).toEqual([]);
    });

    it("measures the one-hour horizon as a length, whatever the client's clock reads", () => {
      // 59 minutes asked by a client 10 minutes fast: inside the horizon, though its expiresAt is
      // 69 minutes past receipt on the server's clock.
      const expiresAt = reportedAt(NOW + TEN_MIN + 59 * 60_000);
      expect(relay.report(OWNER, params("long", { expiresAt }), at(NOW, TEN_MIN))).toEqual({
        ok: true,
      });
      expect(expiryOf("long")).toBe(reportedAt(NOW + 59 * 60_000));
      // 61 minutes asked by a client 10 minutes slow is refused, as any length over an hour is.
      const over = reportedAt(NOW - TEN_MIN + 61 * 60_000);
      expect(relay.report(OWNER, params("over", { expiresAt: over }), at(NOW, -TEN_MIN))).toEqual({
        ok: false,
        error: "invalid",
      });
    });

    it("refuses a report whose length is not positive", () => {
      for (const ms of [0, -1000]) {
        const expiresAt = reportedAt(NOW + ms);
        expect(relay.report(OWNER, params(`none${ms}`, { expiresAt }), at())).toEqual({
          ok: false,
          error: "invalid",
        });
      }
      expect(relay.scoutsInView([CELL], NOW)).toEqual([]);
    });
  });

  it("cancel removes a scout; sweepExpired ages out and broadcasts scoutGone", () => {
    relay.report(OWNER, params("s4"), at());
    expect(relay.cancel(OWNER, "s4")).toEqual({ ok: true });
    expect(relay.scoutsInView([CELL], NOW)).toEqual([]);

    relay.report(OWNER, params("s5"), at());
    deltas.length = 0;
    relay.sweepExpired(NOW + 600_000); // past expiresAt
    expect(relay.scoutsInView([CELL], NOW + 600_000)).toEqual([]);
    expect(deltas.at(-1)).toMatchObject({ kind: "scoutGone", id: "s5" });
  });

  it("emits live map deltas: scout upsert on report, scoutGone on cancel", () => {
    relay.report(OWNER, params("s6"), at());
    expect(deltas.at(-1)).toMatchObject({ kind: "scout", scout: { id: "s6" } });
    relay.cancel(OWNER, "s6");
    expect(deltas.at(-1)).toMatchObject({ kind: "scoutGone", id: "s6" });
  });
});
