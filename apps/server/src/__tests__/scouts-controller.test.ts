import {
  createWallet,
  signOpWithWallet,
  signScoutProvenance,
  walletMinter,
} from "@beaconsgg/identity";
import { MAX_SCOUT_CONFIG_BYTES, type ScoutReportParams } from "@beaconsgg/protocol-types";
import { HttpException, HttpStatus } from "@nestjs/common";
import { ulid } from "ulid";
import { describe, expect, it } from "vitest";
import { DidBudgets } from "../common/did-budgets";
import { ScoutsController } from "../scouts/scouts.controller";
import {
  budgetsWith,
  rejectedWith,
  testBlocklist,
  testGameGate,
  testSignedRequestGate,
  TEST_GAME,
  signedEnv,
} from "./test-helpers";
import type { ScoutsService } from "../scouts/scouts.service";

const CONFIG = {
  scoutType: "heavy-air",
  label: "Heavy Air Scout",
  maxSpeedId: 5,
  maxMoveDistanceMi: 1200,
  maxResources: 6,
};

/** A signed `report` op. The op actor signs the envelope; `minter` signs the provenance (defaults to the
 *  actor). Pass `minter` to sign `mintedBy` with a key other than the reporting owner (allowed — minter is
 *  decoupled from owner). Pass `mintedByConfig` to sign provenance over a DIFFERENT config than params.config
 *  (an invalid `mintedBy`, to check the signature is still verified). */
function reportEnv(
  opts: {
    minter?: ReturnType<typeof createWallet>;
    mintedByConfig?: Record<string, unknown>;
    /** The config the scout carries and is signed over (another game's, say). Defaults to a sample game's. */
    config?: Record<string, unknown>;
    /** Signed as {@link TEST_GAME} by default; `null` names no game. */
    game?: string | null;
    issuedAt?: string;
  } = {},
) {
  const actor = createWallet();
  const signer = opts.minter ?? actor;
  const unique = ulid();
  const config = opts.config ?? CONFIG;
  const mintedBy = signScoutProvenance(
    { unique, config: opts.mintedByConfig ?? config },
    walletMinter(signer),
  );
  return signOpWithWallet(actor, {
    op: "report",
    nonce: ulid(),
    issuedAt: opts.issuedAt ?? new Date().toISOString(),
    ...(opts.game === null ? {} : { game: opts.game ?? TEST_GAME }),
    params: {
      unique,
      config,
      mintedBy,
      movement: {
        lastKnownLocation: { lat: 47.6, lng: -122.3 },
        locationTimestamp: new Date().toISOString(),
        speedKmh: 0,
      },
      expiresAt: new Date(Date.now() + 300_000).toISOString(),
    },
  });
}

function makeController(
  report: ScoutsService["report"] = () => ({ ok: true }),
  denied: string[] = [],
  budgets = new DidBudgets(),
  games = testGameGate(),
  revokedDevices: string[] = [],
): ScoutsController {
  const scouts = { report } as unknown as ScoutsService;
  const signed = testSignedRequestGate({ blocklist: testBlocklist(denied), revokedDevices });
  return new ScoutsController(scouts, signed, games, budgets);
}

type Params = ScoutReportParams & Record<string, unknown>;

/** The HTTP status a throwing call rejects with (fails if it returns or throws something else). */
function rejectStatus(fn: () => unknown): number {
  try {
    fn();
  } catch (err) {
    if (err instanceof HttpException) return err.getStatus();
    throw err;
  }
  throw new Error("expected the call to throw");
}

describe("ScoutsController.scout — provenance gate", () => {
  it("accepts a first-party report (mintedBy signed by the reporting owner)", () => {
    expect(makeController().scout(reportEnv())).toMatchObject({ ok: true });
  });

  it("accepts a report whose mintedBy is signed by a party other than the owner (minter is decoupled)", () => {
    // A minter may be a spawn pool / server / another player, not the reporter (beacon.core
    // `doc/spec/identity.md` §4.3). The server verifies the mintedBy signature but does NOT require
    // minter === owner.
    expect(makeController().scout(reportEnv({ minter: createWallet() }))).toMatchObject({
      ok: true,
    });
  });

  it("rejects a report whose mintedBy does not verify against its {unique, config} (→ 400)", () => {
    // The op is validly signed by the actor, but `mintedBy` was signed over a DIFFERENT config than the
    // one in params — so the signature is still verified and report() must never be reached.
    const controller = makeController(() => {
      throw new Error("must not be reached");
    });
    const bad = reportEnv({ mintedByConfig: { ...CONFIG, maxSpeedId: 0 } });
    expect(rejectStatus(() => controller.scout(bad))).toBe(HttpStatus.BAD_REQUEST);
  });
});

describe("ScoutsController.scout — the config is opaque", () => {
  it("relays another game's config verbatim: the server reads no field of it", () => {
    const seen: ScoutReportParams[] = [];
    const controller = makeController((_owner, params) => {
      seen.push(params);
      return { ok: true };
    });
    const config = { kind: "drone", range: 4.5, tags: ["survey"], nested: { tier: 2 } };
    expect(controller.scout(reportEnv({ config }))).toMatchObject({ ok: true });
    expect(seen[0]?.config).toEqual(config);
  });

  it("hands the relay the envelope's signed issuedAt beside the server's receipt time", () => {
    const stamps: { reportedAt: string; issuedAt: string }[] = [];
    const controller = makeController((_owner, _params, stamp) => {
      stamps.push(stamp);
      return { ok: true };
    });
    const issuedAt = new Date(Date.now() - 60_000).toISOString(); // a client clock a minute slow
    const before = Date.now();
    expect(controller.scout(reportEnv({ issuedAt }))).toMatchObject({ ok: true });
    expect(stamps[0]?.issuedAt).toBe(issuedAt);
    expect(Date.parse(stamps[0]?.reportedAt ?? "")).toBeGreaterThanOrEqual(before);
  });

  it("hands the relay the envelope's signed game slug, so readers can tell whose scout it is", () => {
    const games: (string | undefined)[] = [];
    const controller = makeController((_owner, _params, _at, game) => {
      games.push(game);
      return { ok: true };
    });
    controller.scout(reportEnv({ game: "kites" }));
    controller.scout(reportEnv());
    expect(games).toEqual(["kites", TEST_GAME]);
  });

  it("refuses a config over the cap with 400, before the relay stores it", () => {
    const controller = makeController(() => {
      throw new Error("must not be reached");
    });
    const big = reportEnv({ config: { note: "x".repeat(MAX_SCOUT_CONFIG_BYTES) } });
    expect(rejectStatus(() => controller.scout(big))).toBe(HttpStatus.BAD_REQUEST);
  });

  it("refuses a value canonical JSON has no form for with 400 invalid, not a 500", () => {
    const controller = makeController(() => {
      throw new Error("must not be reached");
    });
    // Only JSON.parse writes it: `1e400` parses to Infinity, which the verifier cannot canonicalize.
    const env = reportEnv({ config: { k: 1 } });
    const bad: unknown = JSON.parse(JSON.stringify(env).replaceAll('"k":1', '"k":1e400'));
    const err = rejectedWith(() => controller.scout(bad as typeof env));
    return expect(err.then((e) => [e.getStatus(), e.getResponse()])).resolves.toMatchObject([
      HttpStatus.BAD_REQUEST,
      { error: "invalid", message: "malformed" },
    ]);
  });

  it("refuses a `derivedStats` by name: it left the wire", () => {
    const env = reportEnv();
    const withStats = signedEnv(createWallet(), "report", {
      ...(env.params as Record<string, unknown>),
      derivedStats: { speed: 1 },
    });
    expect(rejectStatus(() => makeController().scout(withStats))).toBe(HttpStatus.BAD_REQUEST);
  });

  // A newer app's field used to be stripped here and the report accepted without it.
  it.each([
    ["the report", (p: Params) => ({ ...p, altitude: 12 }), "altitude"],
    [
      "its mintedBy",
      (p: Params) => ({ ...p, mintedBy: { ...p.mintedBy, chain: 1 } }),
      "mintedBy.chain",
    ],
    [
      "a position",
      (p: Params) => ({
        ...p,
        movement: {
          ...p.movement,
          lastKnownLocation: { ...p.movement.lastKnownLocation, accuracy: 5 },
        },
      }),
      "movement.lastKnownLocation.accuracy",
    ],
  ])("names a field it does not know on %s", async (_where, add, field) => {
    const params = add(reportEnv().params as Params);
    const env = signedEnv(createWallet(), "report", params);
    const err = await rejectedWith(() => makeController().scout(env));
    expect(err.getStatus()).toBe(HttpStatus.BAD_REQUEST);
    expect(err.getResponse()).toMatchObject({ error: "invalid", fields: [field] });
  });

  it("names a field it does not know on a cancel", async () => {
    const env = signedEnv(createWallet(), "cancel", { unique: ulid(), reason: "lost" });
    const err = await rejectedWith(() => makeController().scout(env));
    expect(err.getResponse()).toMatchObject({ error: "invalid", fields: ["reason"] });
  });
});

describe("ScoutsController — admission", () => {
  it("refuses a blocked owner's report with 403 denied", () => {
    const env = reportEnv();
    expect(rejectStatus(() => makeController(undefined, [env.actor]).scout(env))).toBe(
      HttpStatus.FORBIDDEN,
    );
  });

  it("refuses a blocked owner's cancel too, since the relay bypasses the engine entirely", () => {
    const actor = createWallet();
    const env = signedEnv(actor, "cancel", { unique: ulid() });
    expect(rejectStatus(() => makeController(undefined, [actor.account.did]).scout(env))).toBe(
      HttpStatus.FORBIDDEN,
    );
  });

  it("leaves an unblocked owner alone", () => {
    const env = reportEnv();
    expect(makeController(undefined, ["did:key:zSomeoneElse"]).scout(env)).toMatchObject({
      ok: true,
    });
  });
});

describe("ScoutsController — game admission", () => {
  it("refuses a report from an unadmitted game with 403 gameNotAdmitted", async () => {
    const env = reportEnv({ game: "other-game" });
    const controller = makeController(undefined, [], new DidBudgets(), testGameGate(["kites"]));
    const err = await rejectedWith(() => controller.scout(env));
    expect(err.getStatus()).toBe(HttpStatus.FORBIDDEN);
    expect(err.getResponse()).toMatchObject({ error: "gameNotAdmitted" });
  });

  it("refuses that application's cancel too, the same footprint a block leaves", () => {
    // Consistent with the block above and with the same consequence: the scout stays advertised
    // until the relay TTL expires it, because its owner can no longer take it down. Self-limiting
    // (an hour, capped), and a consequence worth stating rather than an oversight.
    const actor = createWallet();
    const env = signedEnv(actor, "cancel", { unique: ulid() }, undefined, "other-game");
    expect(
      rejectStatus(() =>
        makeController(undefined, [], new DidBudgets(), testGameGate(["kites"])).scout(env),
      ),
    ).toBe(HttpStatus.FORBIDDEN);
  });

  it("lets an admitted game through, and refuses a report naming no game", () => {
    const controller = makeController(undefined, [], new DidBudgets(), testGameGate(["kites"]));
    expect(controller.scout(reportEnv({ game: "kites" }))).toMatchObject({ ok: true });
    expect(rejectStatus(() => controller.scout(reportEnv({ game: null })))).toBe(
      HttpStatus.FORBIDDEN,
    );
  });

  it("refuses before the relay is billed, so a refused application cannot drain the budget", () => {
    // The ordering claim made executable, and the reason it matters here: the relay is background
    // traffic that retries on a timer, so an application refused AFTER the charge would spend its
    // owner's whole relay budget on 403s while their honest scouts went unreported.
    const budgets = budgetsWith({ BEACON_SCOUT_RATE_LIMIT_MAX: "1" });
    const refused = reportEnv({ game: "other-game" });
    const controller = makeController(undefined, [], budgets, testGameGate(["kites"]));
    expect(rejectStatus(() => controller.scout(refused))).toBe(HttpStatus.FORBIDDEN);
    expect(budgets.allowRelayWrite(refused.actor)).toBe(true); // the owner's budget is intact
  });
});

describe("ScoutsController — the relay budget", () => {
  it("refuses a report past the relay budget with 429, without touching the player class", () => {
    const budgets = budgetsWith({ BEACON_SCOUT_RATE_LIMIT_MAX: "1" });
    const env = reportEnv();

    expect(makeController(undefined, [], budgets).scout(env)).toMatchObject({ ok: true });
    expect(rejectStatus(() => makeController(undefined, [], budgets).scout(env))).toBe(
      HttpStatus.TOO_MANY_REQUESTS,
    );

    // The wiring the unit tests cannot see: this controller bills the RELAY class, so the same
    // account's room writes are still open to them. Billing the player class here would leave a
    // runaway heartbeat failing an unrelated jar take, which is the whole reason for two classes.
    expect(budgets.allowPlayerWrite(env.actor, "take")).toBe(true);
  });

  it("charges nothing for a revoked device, so a lost phone cannot drain its owner's budget", () => {
    // A revoked device still presents its owner's account DID and still passes `verifyOp`, since
    // the device authorization is signed by the account root and revocation is a separate consult.
    // If the charge ran before that check, a stolen phone's heartbeat would spend the budget the
    // owner's good phone needs, and revoking it would not stop that.
    const budgets = budgetsWith({ BEACON_SCOUT_RATE_LIMIT_MAX: "1" });
    const env = reportEnv();
    const controller = makeController(() => ({ ok: true }), [], budgets, testGameGate(), [
      env.device,
    ]);

    expect(rejectStatus(() => controller.scout(env))).toBe(HttpStatus.FORBIDDEN);
    expect(budgets.allowRelayWrite(env.actor)).toBe(true); // the owner's budget is intact
  });

  it("charges nothing for a blocked owner, because admission is settled first", () => {
    const budgets = budgetsWith({ BEACON_SCOUT_RATE_LIMIT_MAX: "1" });
    const env = reportEnv();
    expect(rejectStatus(() => makeController(undefined, [env.actor], budgets).scout(env))).toBe(
      HttpStatus.FORBIDDEN,
    );
    expect(budgets.allowRelayWrite(env.actor)).toBe(true); // the block cost them no budget
  });
});

describe("ScoutsController — the shared signed-request bracket", () => {
  it("refuses a report signed outside the replay window, and accepts one inside it", () => {
    // The window itself is not new — this path always had one, under a private
    // `SCOUT_REPLAY_WINDOW_MS` set to the same five minutes as the shared constant. What is new is
    // that anything asserts it: retiring the private copy broke no test, which is how it became
    // clear the rule had three spellings and no coverage.
    const stale = new Date(Date.now() - 6 * 60_000).toISOString();
    expect(rejectStatus(() => makeController().scout(reportEnv({ issuedAt: stale })))).toBe(
      HttpStatus.BAD_REQUEST,
    );
    const fresh = new Date(Date.now() - 60_000).toISOString();
    expect(makeController().scout(reportEnv({ issuedAt: fresh }))).toMatchObject({ ok: true });
  });

  it("charges nothing for a stale report, because freshness is now settled before the budget", () => {
    // The one ordering this move changes in the relay's favour. Freshness used to run AFTER the
    // charge, so a captured report replayed past the window still spent the owner's relay budget on
    // its way to a 400 — an attacker with one stale envelope could starve the account it was
    // captured from.
    const budgets = budgetsWith({ BEACON_SCOUT_RATE_LIMIT_MAX: "1" });
    const env = reportEnv({ issuedAt: new Date(Date.now() - 6 * 60_000).toISOString() });
    expect(rejectStatus(() => makeController(undefined, [], budgets).scout(env))).toBe(
      HttpStatus.BAD_REQUEST,
    );
    expect(budgets.allowRelayWrite(env.actor)).toBe(true);
  });

  it("answers `deviceRevoked` for a revoked device on an unadmitted game, not `gameNotAdmitted`", async () => {
    // The chain is `block -> revocation -> app -> budget`, not the engine's
    // `block -> app -> revocation -> budget`, because the two identity consults share a transport
    // bracket the app gate cannot live in. Decided, not inherited: an application question presumes
    // a player to ask it about, and a revoked device is not the player.
    //
    // This is the one refusal on this path whose wire answer changed. Before, the app gate ran
    // first and this returned `gameNotAdmitted`; asserting it is what keeps the next reorder honest.
    const env = reportEnv({ game: "kites" });
    const controller = makeController(
      () => ({ ok: true }),
      [],
      new DidBudgets(),
      testGameGate(["other-game"]),
      [env.device],
    );
    const err = await rejectedWith(() => controller.scout(env));
    expect(err.getResponse()).toMatchObject({ error: "deviceRevoked", message: "device revoked" });
  });

  it("refuses an envelope naming another op before verifying, consulting or charging it", () => {
    // The op name used to be checked LAST, after a verify, four consults and a charge. A `place`
    // envelope posted to /scouts paid for all of it before being told the route does not serve it.
    const budgets = budgetsWith({ BEACON_SCOUT_RATE_LIMIT_MAX: "1" });
    const wrong = signOpWithWallet(createWallet(), {
      op: "place",
      nonce: ulid(),
      issuedAt: new Date().toISOString(),
      params: {},
    });
    expect(rejectStatus(() => makeController(undefined, [], budgets).scout(wrong))).toBe(
      HttpStatus.BAD_REQUEST,
    );
    expect(budgets.allowRelayWrite(wrong.actor)).toBe(true);
  });
});
