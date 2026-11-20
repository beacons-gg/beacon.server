/**
 * The descriptor carries the engine's `op:` / `policy:` / `rule:` markers. The engine advertises
 * none today, since the baseline is implied, so the engine's answer is stood in for by an addition.
 */
import { describe, expect, it, vi } from "vitest";
import { testConfig } from "./test-config";

vi.mock("@beaconsgg/policy-engine", async (original) => ({
  ...(await original<typeof import("@beaconsgg/policy-engine")>()),
  acceptedMarkers: () => ["op:unreact", "policy:onEmpty.archive"],
}));

describe("the engine's markers in the descriptor", () => {
  it("are advertised unconditionally, whatever the operator enabled", () => {
    expect(testConfig({}).capabilities).toEqual(
      expect.arrayContaining(["op:unreact", "policy:onEmpty.archive"]),
    );
  });
});
