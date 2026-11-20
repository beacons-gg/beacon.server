import { HttpException, HttpStatus } from "@nestjs/common";
import { describe, expect, it } from "vitest";
import { GameGate } from "../common/game-gate";
import { testConfig } from "./test-config";

const gate = (admitted: string[]) => new GameGate({ admitted });

/** The 403 body a refusal throws, or `undefined` when the call returned quietly. */
function refusal(call: () => void): unknown {
  try {
    call();
    return undefined;
  } catch (err) {
    expect(err).toBeInstanceOf(HttpException);
    expect((err as HttpException).getStatus()).toBe(HttpStatus.FORBIDDEN);
    return (err as HttpException).getResponse();
  }
}

describe("GameGate — the truth table", () => {
  it("admits every game when no list is configured", () => {
    const open = gate([]);
    expect(open.admits("kites")).toBe(true);
    expect(open.admits("something-nobody-has-heard-of")).toBe(true);
  });

  it("admits a listed slug and refuses an unlisted one", () => {
    const closed = gate(["kites"]);
    expect(closed.admits("kites")).toBe(true);
    expect(closed.admits("kites-fork")).toBe(false);
    // No prefix or fuzzy matching: `kites/2` is a different game to `kites` unless the operator
    // says otherwise, which is the whole point of leaving the meaning to the list.
    expect(closed.admits("kites/2")).toBe(false);
  });

  it("refuses a write that names no game, open or not", () => {
    // Every game write names its game (`doc/spec/room-operation.md` §5): there is no knob for it.
    expect(gate([]).admits(undefined)).toBe(false);
    expect(gate(["kites"]).admits(undefined)).toBe(false);
  });
});

describe("GameGate — the HTTP form", () => {
  it("returns quietly on an admitted game", () => {
    const g = gate(["kites"]);
    expect(refusal(() => g.assertAdmits("kites"))).toBeUndefined();
  });

  it("throws 403 gameNotAdmitted for an unlisted game, a code of its own inside the shared status", () => {
    // Distinct from `denied` on purpose: a blocked actor should retry nothing anywhere on this
    // server, while an unwelcome game should stop offering it for writes and say why.
    const g = gate(["kites"]);
    expect(refusal(() => g.assertAdmits("other"))).toEqual({
      ok: false,
      error: "gameNotAdmitted",
      message: "game not admitted",
    });
  });

  it("says what is missing when no game is named, on a write and on a game-scoped read", () => {
    const g = gate([]);
    const missing = { ok: false, error: "gameNotAdmitted", message: "game slug required" };
    expect(refusal(() => g.assertAdmits(undefined))).toEqual(missing);
    expect(refusal(() => g.requireGame(undefined))).toEqual(missing);
    // A read only needs a game; admission is the writes' question.
    const closed = gate(["kites"]);
    expect(refusal(() => closed.requireGame("other"))).toBeUndefined();
  });
});

describe("BEACON_GAMES", () => {
  it("advertises one marker per admitted game, and none when open to every game", () => {
    expect(testConfig({ BEACON_GAMES: "kites,other" }).capabilities).toEqual(
      expect.arrayContaining(["game:kites", "game:other"]),
    );
    expect(testConfig({}).capabilities.some((c) => c.startsWith("game"))).toBe(false);
  });
});
