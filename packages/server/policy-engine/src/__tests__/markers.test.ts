/**
 * The `op:` and `rule:` markers this engine advertises, and the forward placement they make safe: a
 * policy may name an op its server does not have yet, and the room gains the verb on upgrade; a
 * client can tell a rule operator a server lacks before it places.
 */
import { createWallet, signOpWithWallet } from "@beaconsgg/identity";
import { ALLOWED_OPERATORS } from "@beaconsgg/jsonlogic-profile";
import { type Policy, unsupportedPolicyFeatures } from "@beaconsgg/protocol-types";
import { afterEach, describe, expect, it } from "vitest";
import { acceptedMarkers, HANDLERS, PolicyEngine, type OpContext } from "../index";
import { InMemoryStore, nonce, roomMintedBy, TEST_GAME } from "../testing";

const ROOM_ID = "markers1@beacon.example";

/** The op a later build adds, standing in for any addition. */
const LATER_OP = "unreact";
const addLaterOp = () => {
  HANDLERS[LATER_OP] = (ctx: OpContext) => ({ ok: true, state: ctx.room.state, changes: [] });
};

/** The rule operator a later build adds, standing in for any addition. */
const LATER_OPERATOR = "if";
const addLaterOperator = () => (ALLOWED_OPERATORS as Set<string>).add(LATER_OPERATOR);

afterEach(() => {
  delete HANDLERS[LATER_OP];
  (ALLOWED_OPERATORS as Set<string>).delete(LATER_OPERATOR);
});

describe("acceptedMarkers", () => {
  it("advertises an op the moment the handler table has it, with no list to remember", () => {
    expect(acceptedMarkers()).not.toContain(`op:${LATER_OP}`);
    addLaterOp();
    expect(acceptedMarkers()).toContain(`op:${LATER_OP}`);
  });
});

describe("a rule operator a later build allows", () => {
  it("is advertised once allowed, and a client sees the gap before placing", async () => {
    const engine = new PolicyEngine(new InMemoryStore());
    const alice = createWallet();
    const policy: Policy = {
      ops: { claim: { role: "public" } },
      grant: { op: "claim", from: "rewards", count: 1, when: { if: [{ var: "n" }, 1, 0] } },
    };
    const place = () =>
      engine.placeRoom({
        game: TEST_GAME,
        id: ROOM_ID,
        type: "bag",
        location: { lat: 47.61, lng: -122.34 },
        policy,
        placedBy: alice.account.did,
        mintedBy: roomMintedBy(ROOM_ID, "bag", policy, alice),
      });

    // Today's server: no marker, the client is told, and placement would refuse it.
    expect(acceptedMarkers()).not.toContain(`rule:${LATER_OPERATOR}`);
    expect(unsupportedPolicyFeatures(acceptedMarkers(), policy)).toEqual([
      `rule:${LATER_OPERATOR}`,
    ]);
    await expect(place()).rejects.toThrow(/operator not allowed: "if"/);

    // The build that allows it advertises it, and places the room.
    addLaterOperator();
    expect(acceptedMarkers()).toContain(`rule:${LATER_OPERATOR}`);
    expect(unsupportedPolicyFeatures(acceptedMarkers(), policy)).toEqual([]);
    await expect(place()).resolves.toBeDefined();
  });
});

describe("every rule slot placement validates is a slot the client walk reads", () => {
  const IF = { if: [{ var: "n" }, 1, 0] };
  const grant = (when: unknown) => ({ op: "claim", from: "rewards", count: 1, when });
  it.each<[string, Partial<Policy>]>([
    ["derived", { derived: { k: IF } }],
    ["one grant rule's when", { grant: grant(IF) }],
    ["a grant array's when", { grant: [grant(IF)] }],
    ["an unlock rule's when", { unlockTransform: [{ when: IF, set: {} }] }],
    ["an unlock rule's set", { unlockTransform: [{ set: { k: IF } }] }],
  ])("%s", async (_slot, extra) => {
    const engine = new PolicyEngine(new InMemoryStore());
    const alice = createWallet();
    const policy = { ops: { claim: { role: "public" } }, ...extra } as Policy;
    expect(unsupportedPolicyFeatures(acceptedMarkers(), policy)).toEqual([
      `rule:${LATER_OPERATOR}`,
    ]);
    await expect(
      engine.placeRoom({
        game: TEST_GAME,
        id: ROOM_ID,
        type: "bag",
        location: { lat: 47.61, lng: -122.34 },
        policy,
        placedBy: alice.account.did,
        mintedBy: roomMintedBy(ROOM_ID, "bag", policy, alice),
      }),
    ).rejects.toThrow(/operator not allowed: "if"/);
  });
});

describe("a policy naming an op its server does not handle", () => {
  it("places, refuses the op until a build handles it, then applies it", async () => {
    const engine = new PolicyEngine(new InMemoryStore());
    const alice = createWallet();
    const policy: Policy = { ops: { list: { role: "public" }, [LATER_OP]: { role: "public" } } };
    const send = () =>
      engine.applyOp(
        signOpWithWallet(alice, {
          game: TEST_GAME,
          op: LATER_OP,
          room: ROOM_ID,
          nonce: nonce(),
          params: {},
        }),
      );

    // Placement takes any key under `ops`: this is what lets a game freeze a verb into a room today.
    await engine.placeRoom({
      game: TEST_GAME,
      id: ROOM_ID,
      type: "bag",
      location: { lat: 47.61, lng: -122.34 },
      policy,
      placedBy: alice.account.did,
      mintedBy: roomMintedBy(ROOM_ID, "bag", policy, alice),
    });

    const before = await send();
    expect(before.result).toEqual({
      ok: false,
      error: "denied",
      message: `unsupported op: ${LATER_OP}`,
    });

    addLaterOp();
    const after = await send();
    expect(after.result.ok).toBe(true);
  });

  // Both lookups read own keys: the policy's `ops` (does it name the op?) and the handler table (does
  // this build have it?). A name on `Object.prototype` must answer like any other unknown name.
  it.each([
    ["hasOwnProperty", true, "unsupported op"],
    ["toString", true, "unsupported op"],
    ["constructor", true, "unsupported op"],
    ["toString", false, "op not permitted"],
    ["hasOwnProperty", false, "op not permitted"],
  ])(
    "refuses %s (named by the policy: %s) as %s, rather than finding it on Object.prototype",
    async (op, named, refusal) => {
      const engine = new PolicyEngine(new InMemoryStore());
      const alice = createWallet();
      const policy: Policy = {
        ops: named ? { [op]: { role: "public" } } : { list: { role: "public" } },
      };
      await engine.placeRoom({
        game: TEST_GAME,
        id: ROOM_ID,
        type: "bag",
        location: { lat: 47.61, lng: -122.34 },
        policy,
        placedBy: alice.account.did,
        mintedBy: roomMintedBy(ROOM_ID, "bag", policy, alice),
      });

      const applied = await engine.applyOp(
        signOpWithWallet(alice, { game: TEST_GAME, op, room: ROOM_ID, nonce: nonce(), params: {} }),
      );
      expect(applied.result).toEqual({
        ok: false,
        error: "denied",
        message: `${refusal}: ${op}`,
      });
    },
  );
});
