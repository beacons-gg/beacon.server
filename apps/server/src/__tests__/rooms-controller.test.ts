import {
  createWallet,
  signRoomProvenance,
  signOpWithWallet,
  verifyRoomProvenance,
  walletMinter,
} from "@beaconsgg/identity";
import { bagPolicy, ladderPolicy, reward } from "@beaconsgg/policy-engine/testing";
import { DerivedRangeError, PlaceConflictError } from "@beaconsgg/policy-engine";
import {
  MAX_REACTION_KIND_LEN,
  MAX_REACTION_TARGET_LEN,
  type ErrorCode,
  type OpaqueItem,
  type OpEnvelope,
  type Policy,
} from "@beaconsgg/protocol-types";
import { HttpException, HttpStatus } from "@nestjs/common";
import { ulid } from "ulid";
import { describe, expect, it } from "vitest";
import { DidBudgets } from "../common/did-budgets";
import { RoomsController } from "../rooms/rooms.controller";
import {
  budgetsWith,
  rejectedWith,
  testBlocklist,
  testGameGate,
  testSignedRequestGate,
  TEST_GAME,
} from "./test-helpers";
import type { RoomsService } from "../rooms/rooms.service";

/**
 * A signed `place` op. By default the op actor is also the container minter (first-party mint).
 * Pass a distinct `minter` to forge a placement wearing someone else's `mintedBy` (a replayed
 * provenance).
 */
function placeEnv(
  actor: ReturnType<typeof createWallet> = createWallet(),
  minter?: ReturnType<typeof createWallet>,
  game: string | null = TEST_GAME,
  issuedAt?: string,
  // Edits the params BEFORE they are signed, like `challengePlaceEnv`: a placement from a newer app
  // is one whose policy really was signed with the field this build does not know.
  mutate?: (params: Record<string, unknown>) => void,
) {
  const signer = minter ?? actor;
  const unique = ulid();
  const policy = bagPolicy();
  const params: Record<string, unknown> = {
    type: "jar",
    unique,
    mintedBy: {},
    location: { lat: 0, lng: 0 },
    policy,
  };
  mutate?.(params);
  params["mintedBy"] = signRoomProvenance(
    { unique, kind: "jar", policy: params["policy"] as Policy },
    walletMinter(signer),
  );
  return signOpWithWallet(actor, {
    op: "place",
    nonce: ulid(),
    ...(game !== null ? { game } : {}),
    ...(issuedAt !== undefined ? { issuedAt } : {}),
    params,
  });
}

/** A placement from a newer app: its signed policy carries `field` at `path`. */
function newerAppEnv(path: string[], field: string, value: unknown = "0s") {
  return placeEnv(undefined, undefined, undefined, undefined, (params) => {
    let target = params["policy"] as Record<string, unknown>;
    for (const step of path) target = target[step] as Record<string, unknown>;
    target[field] = value;
  });
}

/** An escrowed pool item, signed by the organizer who seeds it. */
const poolItem = (organizer: ReturnType<typeof createWallet>): OpaqueItem =>
  reward(ulid(), { minter: walletMinter(organizer) });

/** A two-rung ladder's escrow pools: the multi-step challenge wire shape, without a game builder. */
const POOL1 = "rung1";
const POOL2 = "rung2";

/**
 * A signed challenge `place` with a two-rung ladder policy and per-rung `initialPools` — the exact
 * shape a game's create screen sends. `mutate` edits the params BEFORE signing (so the envelope
 * stays valid and the rejection under test is the boundary rule, never `badsig`).
 */
function challengePlaceEnv(
  mutate?: (params: { policy: Policy; initialPools: Record<string, OpaqueItem[]> }) => void,
) {
  const organizer = createWallet();
  const policy = ladderPolicy({
    rungs: [
      { key: "a", target: 3, pool: POOL1 },
      { key: "b", target: 2, pool: POOL2 },
    ],
    deadlineSec: Math.floor(Date.now() / 1000) + 3600,
    maxContributors: 2,
  });
  const initialPools: Record<string, OpaqueItem[]> = {
    [POOL1]: [poolItem(organizer), poolItem(organizer)],
    [POOL2]: [poolItem(organizer), poolItem(organizer)],
  };
  const params = { policy, initialPools };
  mutate?.(params);
  const unique = ulid();
  const mintedBy = signRoomProvenance(
    { unique, kind: "challenge", policy: params.policy },
    walletMinter(organizer),
  );
  return signOpWithWallet(organizer, {
    op: "place",
    nonce: ulid(),
    game: TEST_GAME,
    params: {
      type: "challenge",
      unique,
      mintedBy,
      location: { lat: 47.61, lng: -122.34 },
      policy: params.policy,
      initialPools: params.initialPools,
    },
  });
}

/** A RoomsService double whose place() always succeeds — boundary tests never reach it on a 400. */
function okRooms(): RoomsService {
  return {
    place: () => Promise.resolve({ id: "x@h", version: 1, room: { id: "x@h" }, replayed: false }),
  } as unknown as RoomsService;
}

/**
 * The controller under test, over a RoomsService double, an empty blocklist by default, and fresh
 * budgets (so one test's charges never leak into another's window).
 */
function controllerFor(
  rooms: RoomsService,
  denied: string[] = [],
  budgets = new DidBudgets(),
  games = testGameGate(),
  revokedDevices: string[] = [],
): RoomsController {
  const signed = testSignedRequestGate({ blocklist: testBlocklist(denied), revokedDevices });
  return new RoomsController(rooms, signed, games, budgets);
}

/** The HTTP status an HttpException-throwing call rejects with (fails if it resolves or throws otherwise). */
async function rejectStatus(promise: Promise<unknown>): Promise<number> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof HttpException) return err.getStatus();
    throw err;
  }
  throw new Error("expected the call to reject");
}

const REACT_ROOM = "cap1@beacon.example";

/** A signed `react` op for `REACT_ROOM`. `params` overrides the well-formed default. */
function reactEnv(
  actor = createWallet(),
  params: Record<string, unknown> = { target: ulid(), kind: "love" },
): OpEnvelope {
  return signOpWithWallet(actor, {
    op: "react",
    room: REACT_ROOM,
    nonce: ulid(),
    game: TEST_GAME,
    params,
  });
}

/** A RoomsService double whose applyOp() always succeeds — the boundary tests never reach it on a 4xx. */
function okOps(): RoomsService {
  return {
    applyOp: () => Promise.resolve({ result: { ok: true, version: 2 } }),
  } as unknown as RoomsService;
}

/** A RoomsService double whose applyOp() always rejects with `error`, to exercise the status map. */
function failingOps(error: ErrorCode): RoomsService {
  return {
    applyOp: () => Promise.resolve({ result: { ok: false, error } }),
  } as unknown as RoomsService;
}

describe("RoomsController.place — admission", () => {
  it("refuses a blocked actor with the shared 403 denied shape", async () => {
    const env = placeEnv();
    const controller = controllerFor(okRooms(), [env.actor]);
    expect(await rejectStatus(controller.place(env))).toBe(HttpStatus.FORBIDDEN);
  });

  it("leaves an unblocked actor alone", async () => {
    const env = placeEnv();
    const controller = controllerFor(okRooms(), ["did:key:zSomeoneElse"]);
    await expect(controller.place(env)).resolves.toMatchObject({ ok: true });
  });

  it("tests the block before the params parse, so a blocked actor pays for none of the work after it", async () => {
    // Params the schema will refuse, validly signed: normally a 400 from `placeParamsSchema`. From a
    // blocked actor the same envelope is a 403 instead, which is the observable proof that admission
    // runs first — the request never reaches the parse, let alone the provenance verifies below it.
    const actor = createWallet();
    const env = signOpWithWallet(actor, {
      op: "place",
      nonce: ulid(),
      game: TEST_GAME,
      params: {},
    });
    expect(await rejectStatus(controllerFor(okRooms()).place(env))).toBe(HttpStatus.BAD_REQUEST);
    expect(await rejectStatus(controllerFor(okRooms(), [actor.account.did]).place(env))).toBe(
      HttpStatus.FORBIDDEN,
    );
  });
});

describe("RoomsController.place — game admission", () => {
  it("refuses a placement from an unadmitted game with 403 gameNotAdmitted", async () => {
    const env = placeEnv(createWallet(), undefined, "other-game");
    const controller = controllerFor(okRooms(), [], new DidBudgets(), testGameGate(["kites"]));
    const err = await rejectedWith(() => controller.place(env));
    expect(err.getStatus()).toBe(HttpStatus.FORBIDDEN);
    expect(err.getResponse()).toMatchObject({ error: "gameNotAdmitted" });
  });

  it("lets an admitted game place, and refuses a placement naming no game", async () => {
    const controller = controllerFor(okRooms(), [], new DidBudgets(), testGameGate(["kites"]));
    await expect(
      controller.place(placeEnv(createWallet(), undefined, "kites")),
    ).resolves.toMatchObject({ ok: true });
    const err = await rejectedWith(() => controller.place(placeEnv(undefined, undefined, null)));
    expect(err.getResponse()).toMatchObject({
      error: "gameNotAdmitted",
      message: "game slug required",
    });
  });

  it("tests the block first, so a blocked actor gets `denied` even from an unadmitted game", async () => {
    // Both are a 403, so the CODE is the only observable difference — and it is the one that tells
    // the client whether to stop writing to this server or to stop offering it for this game.
    const env = placeEnv(createWallet(), undefined, "other-game");
    const controller = controllerFor(
      okRooms(),
      [env.actor],
      new DidBudgets(),
      testGameGate(["kites"]),
    );
    expect((await rejectedWith(() => controller.place(env))).getResponse()).toMatchObject({
      error: "denied",
    });
  });

  it("refuses before billing, so a rejected application never spends the account's budget", async () => {
    // The ordering claim made executable. If admission ran after the charge, the refusal below
    // would spend a budget of one and the honest placement after it would come back 429.
    const budgets = budgetsWith({ BEACON_OP_RATE_LIMIT_MAX: "1" });
    const alice = createWallet();
    const controller = controllerFor(okRooms(), [], budgets, testGameGate(["kites"]));

    expect(
      (
        await rejectedWith(() => controller.place(placeEnv(alice, undefined, "other-game")))
      ).getStatus(),
    ).toBe(HttpStatus.FORBIDDEN);
    await expect(controller.place(placeEnv(alice, undefined, "kites"))).resolves.toMatchObject({
      ok: true,
    });
  });
});

describe("RoomsController.place — the player budget", () => {
  it("refuses a second placement by the same account past its budget, with 429", async () => {
    const budgets = budgetsWith({ BEACON_OP_RATE_LIMIT_MAX: "1" });
    const alice = createWallet();
    const controller = controllerFor(okRooms(), [], budgets);

    await expect(controller.place(placeEnv(alice))).resolves.toMatchObject({ ok: true });
    expect(await rejectStatus(controller.place(placeEnv(alice)))).toBe(
      HttpStatus.TOO_MANY_REQUESTS,
    );
  });

  it("bills the account, so a second player on the same server is unaffected", async () => {
    // The reason this surface is keyed on the DID at all: two players at one real-world place share
    // a wifi, and the IP guard cannot tell them apart.
    const budgets = budgetsWith({ BEACON_OP_RATE_LIMIT_MAX: "1" });
    const alice = createWallet();
    const bob = createWallet();
    const controller = controllerFor(okRooms(), [], budgets);

    await expect(controller.place(placeEnv(alice))).resolves.toMatchObject({ ok: true });
    await expect(controller.place(placeEnv(alice))).rejects.toThrow();
    await expect(controller.place(placeEnv(bob))).resolves.toMatchObject({ ok: true });
  });

  it("charges nothing for a blocked actor, because admission is settled first", async () => {
    // Ordering matters beyond tidiness: if the block were tested after the charge, a blocked client
    // could still burn its own budget, and the budget map would fill with accounts already refused.
    const budgets = budgetsWith({ BEACON_OP_RATE_LIMIT_MAX: "1" });
    const blocked = placeEnv();
    expect(
      await rejectStatus(controllerFor(okRooms(), [blocked.actor], budgets).place(blocked)),
    ).toBe(HttpStatus.FORBIDDEN);

    // Against the BANNED account's own budget. Asserting that some other account still gets its
    // placement would pass whichever order the two checks ran in, since budgets are keyed per DID.
    expect(budgets.allowPlayerWrite(blocked.actor, "place")).toBe(true);
  });
});

describe("RoomsController.place — the shared signed-request bracket", () => {
  it("denies a revoked device, the last room write one could still make", async () => {
    // `place` verifies its own signature and never reaches the engine as an op, so the engine's
    // `isDeviceRevoked` hook — which covers every other room write — could not see it. A revoked
    // phone could keep placing jars in the operator's world.
    const alice = createWallet();
    const controller = controllerFor(okRooms(), [], new DidBudgets(), testGameGate(), [
      alice.device.did,
    ]);
    expect(await rejectStatus(controller.place(placeEnv(alice)))).toBe(HttpStatus.FORBIDDEN);
    // The account is not blocked — only that device is cut off, so the owner's other device places.
    await expect(controller.place(placeEnv())).resolves.toMatchObject({ ok: true });
  });

  it("charges nothing for a revoked device either, so a stolen phone can't drain the budget", async () => {
    // The same ordering property the block has, and it matters more here: a revoked device presents
    // its OWNER's account DID, so a charge ahead of the consult would let a stolen phone spend the
    // budget the owner's good phone needs.
    const budgets = budgetsWith({ BEACON_OP_RATE_LIMIT_MAX: "1" });
    const alice = createWallet();
    const controller = controllerFor(okRooms(), [], budgets, testGameGate(), [alice.device.did]);

    expect(await rejectStatus(controller.place(placeEnv(alice)))).toBe(HttpStatus.FORBIDDEN);
    expect(budgets.allowPlayerWrite(alice.account.did, "place")).toBe(true);
  });

  it("answers `deviceRevoked` for a revoked device on an unadmitted game, not `gameNotAdmitted`", async () => {
    // The boundary chain is `block -> revocation -> app -> budget`; the engine's is
    // `block -> app -> revocation -> budget`. Decided in `SignedRequestGate`, and asserted here
    // because it is the one place the two brackets give different answers to one request.
    const alice = createWallet();
    const controller = controllerFor(
      okRooms(),
      [],
      new DidBudgets(),
      testGameGate(["other-game"]),
      [alice.device.did],
    );
    const err = await rejectedWith(() => controller.place(placeEnv(alice, undefined, "kites")));
    expect(err.getResponse()).toMatchObject({ error: "deviceRevoked", message: "device revoked" });
  });

  it("refuses an envelope naming another op, before any of the placement work", async () => {
    // The check is not new — `place` always had it — but nothing asserted it on either side of this
    // change, which is how the freshness gap next door stayed invisible too. A `react` envelope
    // posted to /rooms must not reach the provenance verifies below it.
    //
    // Asserted on the MESSAGE, not the status: a `react` envelope carries no place params either, so
    // a version with no op check at all still answers 400 — from the params parse, one step later
    // and after the work this check exists to skip. The status alone cannot tell the two apart.
    const wrong = signOpWithWallet(createWallet(), { op: "react", nonce: ulid(), params: {} });
    const err = await rejectedWith(() => controllerFor(okRooms()).place(wrong));
    expect(err.getStatus()).toBe(HttpStatus.BAD_REQUEST);
    expect(err.getResponse()).toMatchObject({ error: "invalid", message: 'expected op "place"' });
  });

  it("refuses a placement signed outside the replay window, and accepts one inside it", async () => {
    // New behaviour rather than inherited. Without a window a captured `place` replays until the
    // device authorization expires, because the nonce log that would absorb it is pruned at
    // `BEACON_MAX_NONCES`.
    const stale = new Date(Date.now() - 6 * 60_000).toISOString();
    const fresh = new Date(Date.now() - 60_000).toISOString();
    const controller = controllerFor(okRooms());

    const err = await rejectedWith(() =>
      controller.place(placeEnv(createWallet(), undefined, undefined, stale)),
    );
    expect(err.getStatus()).toBe(HttpStatus.BAD_REQUEST);
    // Its own code, at the same status as the `invalid` an older app is sent instead.
    expect(err.getResponse()).toMatchObject({ error: "clockSkew" });
    // Both sides asserted: a window that refused everything would pass the half above on its own.
    await expect(
      controller.place(placeEnv(createWallet(), undefined, undefined, fresh)),
    ).resolves.toMatchObject({ ok: true });
  });
});

describe("RoomsController.place — error classification", () => {
  it("propagates an infra error from place() (→ 500), not a false 400", async () => {
    const rooms = {
      place: () => Promise.reject(new Error("pool down")),
    } as unknown as RoomsService;
    // The rules were pre-validated, so a throw is infrastructure: it must surface as-is (Nest → 500),
    // NOT be swallowed into a permanent, non-retryable `400 invalid placement`.
    await expect(controllerFor(rooms).place(placeEnv())).rejects.toThrow("pool down");
  });

  it("returns ok for a valid placement", async () => {
    const rooms = {
      place: () => Promise.resolve({ id: "x@h", version: 1, room: { id: "x@h" }, replayed: false }),
    } as unknown as RoomsService;
    await expect(controllerFor(rooms).place(placeEnv())).resolves.toMatchObject({
      ok: true,
      id: "x@h",
    });
  });

  it("accepts a placement whose mintedBy is signed by a party other than the placer (minter is decoupled)", async () => {
    // A minter may be a spawn pool / server / another player, not the placer (beacon.core
    // `doc/spec/identity.md` §4.3). The controller verifies the mintedBy signature but does NOT
    // require minter === placer.
    const rooms = {
      place: () => Promise.resolve({ id: "x@h", version: 1, room: { id: "x@h" }, replayed: false }),
    } as unknown as RoomsService;
    await expect(
      controllerFor(rooms).place(placeEnv(undefined, createWallet())),
    ).resolves.toMatchObject({
      ok: true,
      id: "x@h",
    });
  });

  it("maps a PlaceConflictError from place() to a 409 (a different actor owns the id), not a 500 loop", async () => {
    const rooms = {
      place: () => Promise.reject(new PlaceConflictError("x@h")),
    } as unknown as RoomsService;
    const status = await rejectStatus(controllerFor(rooms).place(placeEnv()));
    expect(status).toBe(HttpStatus.CONFLICT);
  });

  it("maps a DerivedRangeError from place() to a 400 naming the reason, such as a transition past the horizon", async () => {
    // The service is a double, so this pins the mapping only; the engine's own refusal is proven in
    // policy-engine's transition-horizon suite.
    const reason = "the locked transition (lockAt) would be more than 10 years after placement";
    const rooms = {
      place: () => Promise.reject(new DerivedRangeError(reason)),
    } as unknown as RoomsService;
    const err = await rejectedWith(() => controllerFor(rooms).place(placeEnv()));
    expect(err.getStatus()).toBe(HttpStatus.BAD_REQUEST);
    expect(JSON.stringify(err.getResponse())).toContain(reason);
  });
});

describe("RoomsController.place — a field this server does not know", () => {
  /** The 400 body a refusal answered with. */
  async function refusal(env: ReturnType<typeof placeEnv>) {
    const err = await rejectedWith(() => controllerFor(okRooms()).place(env));
    expect(err.getStatus()).toBe(HttpStatus.BAD_REQUEST);
    return err.getResponse() as { error: string; message: string; fields?: string[] };
  }

  it("names the field instead of calling the placement forged", async () => {
    const env = newerAppEnv([], "cooldown");
    const { unique, policy, mintedBy } = env.params as {
      unique: string;
      policy: Policy;
      mintedBy: Parameters<typeof verifyRoomProvenance>[1];
    };
    // The minter really did sign this policy, unknown field and all. An earlier boundary stripped
    // the field and then failed THIS check, telling the player their item was forged.
    expect(verifyRoomProvenance({ unique, kind: "jar", policy }, mintedBy)).toBe(true);

    const body = await refusal(env);
    expect(body.error).toBe("invalid");
    expect(body.fields).toEqual(["policy.cooldown"]);
    expect(body.message).toMatch(/does not understand/);
    expect(body.message).not.toMatch(/provenance|mintedBy|forg/i);
  });

  it("names where the field sits, so an operator can read which part of the policy is new", async () => {
    const body = await refusal(newerAppEnv(["ops", "take"], "burst", 2));
    expect(body.fields).toEqual(["policy.ops.take.burst"]);
  });

  it("refuses an unknown top-level param too, rather than placing a room without it", async () => {
    // Not signed, so this one never failed provenance: it was dropped, and the room came back
    // missing whatever the param asked for. A refusal is the honest answer.
    const body = await refusal(
      placeEnv(undefined, undefined, undefined, undefined, (params) => {
        params["region"] = "eu";
      }),
    );
    expect(body.fields).toEqual(["region"]);
  });

  it("answers a new VALUE on a closed set as malformed, not as a version gap", async () => {
    // Deliberate, and the reason a new value needs a `code:` marker: this build cannot tell a role
    // it has never heard of from a client bug, so it must not claim to be the older side.
    const body = await refusal(
      placeEnv(undefined, undefined, undefined, undefined, (params) => {
        const ops = (params["policy"] as { ops: Record<string, { role: unknown }> }).ops;
        ops["take"] = { role: "friends" };
      }),
    );
    expect(body.fields).toBeUndefined();
    expect(body.message).not.toMatch(/does not understand/);
  });

  it("names an unknown envelope key on the op route the same way", async () => {
    const env = { ...reactEnv(), cooldown: "0s" } as unknown as OpEnvelope;
    const err = await rejectedWith(() => controllerFor(okOps()).op(REACT_ROOM, env));
    expect(err.getStatus()).toBe(HttpStatus.BAD_REQUEST);
    expect((err.getResponse() as { fields?: string[] }).fields).toEqual(["cooldown"]);
  });

  it("keeps the parse's own complaint when something else is wrong too", async () => {
    // Both an unknown field and a broken one, signed together so the envelope itself is sound.
    // "This server is behind" would be half the story, and the half the client cannot act on;
    // zod's message carries both, and no `fields` claims a version gap.
    const body = await refusal(
      placeEnv(undefined, undefined, undefined, undefined, (params) => {
        (params["policy"] as Record<string, unknown>)["cooldown"] = "0s";
        params["location"] = { lat: 0 };
      }),
    );
    expect(body.fields).toBeUndefined();
    expect(body.message).not.toMatch(/does not understand/);
    expect(body.message).toContain("lng");
  });

  it("still refuses a malformed placement with the parse's own complaint", async () => {
    // A client bug, not an older server: the message must not claim this build is behind.
    const body = await refusal(
      placeEnv(undefined, undefined, undefined, undefined, (params) => {
        params["unique"] = "not-a-ulid";
      }),
    );
    expect(body.fields).toBeUndefined();
    expect(body.message).not.toMatch(/does not understand/);
  });
});

describe("RoomsController.place — the initialPools boundary (the multi-step challenge wire shape)", () => {
  it("accepts a ladder placement whose pools match the policy's grant rules", async () => {
    await expect(controllerFor(okRooms()).place(challengePlaceEnv())).resolves.toMatchObject({
      ok: true,
      id: "x@h",
    });
  });

  it("rejects a pool key no grant rule draws from — a client bug is a 400, never a silent drop", async () => {
    const organizer = createWallet();
    const env = challengePlaceEnv((params) => {
      params.initialPools["bonus"] = [poolItem(organizer)];
    });
    expect(await rejectStatus(controllerFor(okRooms()).place(env))).toBe(HttpStatus.BAD_REQUEST);
  });

  it("rejects a pool item whose provenance doesn't verify (no smuggling forged rewards)", async () => {
    const env = challengePlaceEnv((params) => {
      const pool = params.initialPools[POOL1]!;
      // Tamper the signed birth AFTER minting: the signature no longer covers what's claimed.
      pool[0] = { ...pool[0]!, birth: { ...pool[0]!.birth, class: "SomethingShinier" } };
    });
    expect(await rejectStatus(controllerFor(okRooms()).place(env))).toBe(HttpStatus.BAD_REQUEST);
  });

  it("rejects a policy whose grant rule names a reserved state key, at the boundary (clean 400)", async () => {
    const env = challengePlaceEnv((params) => {
      // A pool named `contributors` would let a seeded placement forge the member ledger; the
      // engine's policy invariant refuses it, and the boundary pre-check turns that into a 400.
      (params.policy.grant as { from: string }[])[0]!.from = "contributors";
      const pools = params.initialPools;
      pools["contributors"] = pools[POOL1]!;
      delete pools[POOL1];
    });
    expect(await rejectStatus(controllerFor(okRooms()).place(env))).toBe(HttpStatus.BAD_REQUEST);
  });
});

describe("RoomsController.op: the boundary stays op-agnostic (room-operation.md §9.6)", () => {
  it("passes a well-formed react through to the engine", async () => {
    await expect(controllerFor(okOps()).op(REACT_ROOM, reactEnv())).resolves.toMatchObject({
      ok: true,
    });
  });

  it("refuses an op this route does not take as 400 invalid at the door, like every signed route", async () => {
    // `mailbox.send` is a real op, just not a room op: the request is malformed for this route,
    // which is the 400 every other signed route answers, not the 403 the engine gives a room that
    // refuses an op it does know.
    for (const op of ["mailbox.send", "place", "noSuchOp"]) {
      const env = signOpWithWallet(createWallet(), {
        op,
        room: REACT_ROOM,
        nonce: ulid(),
        game: TEST_GAME,
        params: {},
      });
      const err = await rejectedWith(() => controllerFor(okOps()).op(REACT_ROOM, env));
      expect(err.getStatus()).toBe(HttpStatus.BAD_REQUEST);
      expect(err.getResponse()).toMatchObject({ ok: false, error: "invalid" });
    }
  });

  it("hands malformed react params to the engine rather than pre-checking them here", async () => {
    // The boundary knows no op's params, on purpose: `place` parses because it USES the parsed
    // value, `op` never would. A door check would not shed load either (an attacker sends
    // well-shaped params with a junk signature and pays for the verifies anyway), and it would be a
    // third copy of `reactParamsSchema` kept in sync by nobody touching it. The engine rejects
    // these as `invalid`, which `statusForError` already maps to the same 400.
    const bad: Record<string, unknown>[] = [
      { kind: "love" }, // no target
      { target: ulid() }, // no kind
      { target: ulid(), kind: "" }, // empty kind
      { target: ulid(), kind: "k".repeat(MAX_REACTION_KIND_LEN + 1) },
      { target: "", kind: "love" },
      { target: "t".repeat(MAX_REACTION_TARGET_LEN + 1), kind: "love" },
    ];
    for (const params of bad) {
      // Reaching a succeeding applyOp IS the assertion: the door let it through for the engine.
      await expect(
        controllerFor(okOps()).op(REACT_ROOM, reactEnv(undefined, params)),
      ).resolves.toMatchObject({ ok: true });
    }
  });

  // The other half of the same call: with no door check, the client-visible answer to bad params is
  // whatever the engine says, and the controller's only job is `statusForError`'s mapping.
  it.each([
    ["invalid", HttpStatus.BAD_REQUEST],
    ["rateLimited", HttpStatus.TOO_MANY_REQUESTS],
  ] as const)("surfaces the engine's %s verdict as a %i", async (error, status) => {
    const call = controllerFor(failingOps(error)).op(REACT_ROOM, reactEnv());
    expect(await rejectStatus(call)).toBe(status);
  });
});

describe("RoomsController.resolve — the games filter", () => {
  const asked: (readonly string[] | undefined)[] = [];
  const controller = controllerFor({
    resolve: (_id: string, games?: readonly string[]) => {
      asked.push(games);
      return Promise.resolve(games?.includes("game-c") ? undefined : { id: "r@h" });
    },
  } as unknown as RoomsService);

  it("hands the service the listed games, a repeated key included", async () => {
    await controller.resolve("r@h");
    await controller.resolve("r@h", "game-a,game-b");
    await controller.resolve("r@h", ["game-a", "game-b"]);
    expect(asked).toEqual([undefined, ["game-a", "game-b"], ["game-a", "game-b"]]);
  });

  it("answers unknownRoom (404) when the service holds nothing for those games", async () => {
    const err = await rejectedWith(() => controller.resolve("r@h", "game-c"));
    expect(err.getStatus()).toBe(HttpStatus.NOT_FOUND);
    expect(err.getResponse()).toEqual({ ok: false, error: "unknownRoom" });
  });

  it("rejects a malformed games filter with 400", async () => {
    expect(await rejectStatus(controller.resolve("r@h", "Game A"))).toBe(HttpStatus.BAD_REQUEST);
  });
});
