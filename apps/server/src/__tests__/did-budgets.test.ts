import { describe, expect, it } from "vitest";
import { budgetsWith as budgets } from "./test-helpers";

const ALICE = "did:key:zAlice";
const BOB = "did:key:zBob";

describe("DidBudgets — the player class", () => {
  it("refuses a write past the budget, bills each account separately, and pools place with the ops", () => {
    const b = budgets({ BEACON_OP_RATE_LIMIT_MAX: "2" });

    // `place` and `add` take the identical path here, which is the point: both are player-initiated
    // and share one ceiling, so a placement spends what an op would have.
    expect(b.allowPlayerWrite(ALICE, "place")).toBe(true);
    expect(b.allowPlayerWrite(ALICE, "add")).toBe(true);
    expect(b.allowPlayerWrite(ALICE, "take")).toBe(false);

    // The whole point of keying on the DID: Bob standing on the same venue wifi is untouched by
    // Alice exhausting hers, which is the case the IP guard cannot express.
    expect(b.allowPlayerWrite(BOB, "add")).toBe(true);
  });
});

describe("DidBudgets — a per-op override can only tighten", () => {
  it("caps the overridden op below the class without capping the rest", () => {
    const b = budgets({ BEACON_OP_RATE_LIMIT_MAX: "10", BEACON_REACT_RATE_LIMIT_MAX: "2" });

    expect(b.allowPlayerWrite(ALICE, "react")).toBe(true);
    expect(b.allowPlayerWrite(ALICE, "react")).toBe(true);
    expect(b.allowPlayerWrite(ALICE, "react")).toBe(false); // the override, not the class

    // The class still has room, so an op without an override goes through.
    expect(b.allowPlayerWrite(ALICE, "add")).toBe(true);
  });

  it("charges the class too, so an override is never room beyond the ceiling", () => {
    const b = budgets({ BEACON_OP_RATE_LIMIT_MAX: "3", BEACON_REACT_RATE_LIMIT_MAX: "10" });

    expect(b.allowPlayerWrite(ALICE, "react")).toBe(true);
    expect(b.allowPlayerWrite(ALICE, "react")).toBe(true);
    expect(b.allowPlayerWrite(ALICE, "react")).toBe(true);

    // Three reacts spent the class budget even though the override had seven left, so the next
    // write of ANY op is refused. Without this an override would be a way to buy extra writes.
    expect(b.allowPlayerWrite(ALICE, "add")).toBe(false);
    expect(b.allowPlayerWrite(ALICE, "react")).toBe(false);
  });

  it("charges both counters even when the class is what refuses", () => {
    // Not short-circuited: the override's window reflects every attempt, so what it holds never
    // depends on whether the class happened to refuse first.
    const b = budgets({ BEACON_OP_RATE_LIMIT_MAX: "1", BEACON_REACT_RATE_LIMIT_MAX: "2" });
    expect(b.allowPlayerWrite(ALICE, "react")).toBe(true);
    expect(b.allowPlayerWrite(ALICE, "react")).toBe(false); // class exhausted; override charged too
    expect(b.allowPlayerWrite(ALICE, "react")).toBe(false); // now both are
  });
});

describe("DidBudgets — the relay class is separate, which is the point of having classes", () => {
  it("does not let a runaway scout heartbeat spend a player's room writes", () => {
    // The failure this prevents is concrete and has happened: a re-entrant relay effect turned the
    // 60s heartbeat into an RTT-bound loop, and what the player saw was an unrelated jar take
    // failing as `rateLimited` off the shared IP budget.
    const b = budgets({ BEACON_SCOUT_RATE_LIMIT_MAX: "2", BEACON_OP_RATE_LIMIT_MAX: "2" });

    expect(b.allowRelayWrite(ALICE)).toBe(true);
    expect(b.allowRelayWrite(ALICE)).toBe(true);
    expect(b.allowRelayWrite(ALICE)).toBe(false);

    // Taking from a jar still works, which is the whole reason the classes are split.
    expect(b.allowPlayerWrite(ALICE, "take")).toBe(true);
    // And the relay is billed per account too.
    expect(b.allowRelayWrite(BOB)).toBe(true);
  });
});
