import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { installedVersion, oldClientDependencies } from "../oldClient";

describe("oldClientDependencies", () => {
  const installed = (name: string) => ({ ulid: "2.3.0", zod: "3.25.76" })[name] ?? "MISSING";

  it("pins every core package to the edge, whatever it was", () => {
    expect(
      oldClientDependencies(
        { "@beaconsgg/client-sdk": "workspace:*", "@beaconsgg/geo": "1.0.0-rc.9" },
        "1.0.0-rc.1",
        installed,
      ),
    ).toEqual({ "@beaconsgg/client-sdk": "1.0.0-rc.1", "@beaconsgg/geo": "1.0.0-rc.1" });
  });

  it("gives each catalogued dependency its own installed version, and keeps a written range", () => {
    expect(
      oldClientDependencies(
        { ulid: "catalog:", zod: "catalog:", "socket.io-client": "^4.8.3" },
        "1.0.0-rc.1",
        installed,
      ),
    ).toEqual({ ulid: "2.3.0", zod: "3.25.76", "socket.io-client": "^4.8.3" });
  });

  it("refuses a workspace link that is not a core package", () => {
    expect(() =>
      oldClientDependencies({ "@kites/game": "workspace:*" }, "1.0.0-rc.1", installed),
    ).toThrow(/@kites\/game is a workspace link/);
  });
});

describe("installedVersion", () => {
  const packageDir = join(dirname(__filename), "..", "..");

  it("finds what this workspace installed, from the package's directory upward", () => {
    expect(installedVersion("ulid", packageDir)).toMatch(/^\d+\.\d+\.\d+/);
    expect(installedVersion("vitest", packageDir)).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("says so when the package is not installed", () => {
    expect(() => installedVersion("not-a-real-package-152", packageDir)).toThrow(
      /is not installed above/,
    );
  });
});
