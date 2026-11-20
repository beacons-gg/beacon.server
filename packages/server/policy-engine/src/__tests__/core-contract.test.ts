/**
 * Core's published JSONLogic vectors, run here over the evaluator this engine installs. A policy's
 * `accept`, capacity and derived formulas are evaluated by a client to preview an op and by this
 * engine to decide it; the vectors are the answers both must give. Core's suite holds them against
 * its source, this against the registry copy the engine is built on.
 */
import { CONFORMANCE_VECTORS, evaluate, validateRule } from "@beaconsgg/jsonlogic-profile";
import { describe, expect, it } from "vitest";

describe("JSONLogic conformance vectors over the installed evaluator", () => {
  it("has vectors to run", () => {
    expect(CONFORMANCE_VECTORS.length).toBeGreaterThan(0);
  });

  it.each(CONFORMANCE_VECTORS)("$name", ({ rule, data, expected }) => {
    expect(validateRule(rule).ok).toBe(true);
    expect(evaluate(rule, data)).toBe(expected);
  });
});
