import { DEFAULT_PRECISION, encode } from "@beaconsgg/geo";
import type { MapDelta, ScoutReportParams } from "@beaconsgg/protocol-types";
import { beforeEach, describe, expect, it } from "vitest";
import type { RoomsGateway } from "../rooms/rooms.gateway";
import { ScoutsService } from "../scouts/scouts.service";

const OWNER = "did:key:z6MkScout1";
const STRANGER = "did:key:z6MkStranger";
const NOW = Date.parse("2026-06-29T00:00:00Z");
const reportedAt = (ms = NOW): string => new Date(ms).toISOString();
/** A report received at `ms` on the server's clock, signed by a client whose clock reads `ms + skewMs`. */
const at = (ms = NOW, skewMs = 0) => ({
  reportedAt: reportedAt(ms),
  issuedAt: reportedAt(ms + skewMs),
});

const HERE = { lat: 47.61, lng: -122.34 };
const CELL = encode(HERE, DEFAULT_PRECISION);
const ELSEWHERE_CELL = encode({ lat: 0, lng: 0 }, DEFAULT_PRECISION);

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

describe("ScoutsService (relay)", () => {
  let svc: ScoutsService;
  let mapDeltas: MapDelta[];
  let audiences: (readonly string[])[];
  beforeEach(() => {
    mapDeltas = [];
    audiences = [];
    const gateway = {
      broadcastMap: (d: MapDelta, games: readonly string[]) => {
        mapDeltas.push(d);
        audiences.push(games);
      },
    } as unknown as RoomsGateway;
    svc = new ScoutsService(gateway);
  });

  it("hands the gateway each scout's game, and the game filter to the relay", () => {
    svc.report(OWNER, params("a"), at(), "game-a");
    svc.report(OWNER, params("b"), at(), "game-b");
    expect(audiences).toEqual([["game-a"], ["game-b"]]);
    expect(svc.scoutsInView([CELL], NOW, ["game-a"]).map((s) => s.id)).toEqual(["a"]);
  });

  it("relays the report envelope's game slug on the summary, and nothing when there was none", () => {
    svc.report(OWNER, params("s1"), at(), "kites");
    svc.report(OWNER, params("s2"), at());
    const [withSlug, without] = svc.scoutsInView([CELL], NOW);
    expect(withSlug?.game).toBe("kites");
    expect(without).not.toHaveProperty("game");
    // The live map's upsert carries it too.
    const upserts = mapDeltas.filter((d) => d.kind === "scout");
    expect(upserts.map((d) => (d.kind === "scout" ? d.scout.game : null))).toEqual([
      "kites",
      undefined,
    ]);
  });

  it("reports a scout and serves it by interpolated cell", () => {
    expect(svc.report(OWNER, params("s1"), at())).toEqual({ ok: true });
    expect(svc.scoutsInView([CELL], NOW).map((s) => s.id)).toEqual(["s1"]);
    expect(svc.scoutsInView([ELSEWHERE_CELL], NOW)).toEqual([]);
  });

  it("only the original owner may refresh a unique", () => {
    svc.report(OWNER, params("s2"), at());
    expect(svc.report(STRANGER, params("s2"), at(NOW + 1000))).toEqual({
      ok: false,
      error: "denied",
    });
  });

  it("rejects an expiry beyond the TTL horizon (can't squat the map)", () => {
    const farFuture = reportedAt(NOW + 2 * 60 * 60_000); // 2h > 1h horizon
    expect(svc.report(OWNER, params("s3", { expiresAt: farFuture }), at())).toEqual({
      ok: false,
      error: "invalid",
    });
    expect(svc.scoutsInView([CELL], NOW)).toEqual([]); // not stored
  });

  it("cancel removes a scout; expired reports aren't served", () => {
    svc.report(OWNER, params("s4"), at());
    expect(svc.cancel(OWNER, "s4")).toEqual({ ok: true });
    expect(svc.scoutsInView([CELL], NOW)).toEqual([]);

    svc.report(OWNER, params("s5"), at());
    // query past expiresAt -> aged out of the view
    expect(svc.scoutsInView([CELL], NOW + 600_000)).toEqual([]);
  });

  it("emits live map deltas: scout upsert on report, scoutGone on cancel", () => {
    svc.report(OWNER, params("s6"), at());
    expect(mapDeltas.at(-1)).toMatchObject({ kind: "scout", scout: { id: "s6" } });
    svc.cancel(OWNER, "s6");
    expect(mapDeltas.at(-1)).toMatchObject({ kind: "scoutGone", id: "s6" });
  });
});
