import { describe, expect, it } from "vitest";
import { parseEnv, UsageError } from "../main";

describe("parseEnv", () => {
  it("needs the server and passes the windows through as numbers", () => {
    expect(
      parseEnv({
        BEACON_FLOWS_SERVER: "http://localhost:3001",
        BEACON_FLOWS_LOCK_SEC: "3",
        BEACON_FLOWS_UNLOCK_SEC: "4",
        BEACON_FLOWS_WAIT_MS: "20000",
      }),
    ).toEqual({
      server: "http://localhost:3001",
      lockDelaySec: 3,
      unlockDelaySec: 4,
      waitMs: 20000,
    });
  });

  it("leaves an unset or empty window to the driver's default", () => {
    expect(parseEnv({ BEACON_FLOWS_SERVER: "http://h", BEACON_FLOWS_LOCK_SEC: "" })).toEqual({
      server: "http://h",
    });
  });

  it("refuses a missing server and a window that is not a positive number", () => {
    expect(() => parseEnv({})).toThrow(UsageError);
    expect(() =>
      parseEnv({ BEACON_FLOWS_SERVER: "http://h", BEACON_FLOWS_LOCK_SEC: "soon" }),
    ).toThrow(/BEACON_FLOWS_LOCK_SEC must be a positive number/);
    expect(() => parseEnv({ BEACON_FLOWS_SERVER: "http://h", BEACON_FLOWS_WAIT_MS: "0" })).toThrow(
      UsageError,
    );
  });
});
