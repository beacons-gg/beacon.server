import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { corsOriginOption, RETIRED_SETTINGS } from "../config";
import { originAllowed } from "../ws.adapter";
import { testConfig } from "./test-config";

describe("retired setting names", () => {
  it("refuses to start while one is set, naming the setting that replaced it", () => {
    expect(() => testConfig({ BEACON_RATE_LIMIT_MAX: "50" })).toThrow(
      /BEACON_RATE_LIMIT_MAX is now BEACON_WRITE_RATE_LIMIT_MAX/,
    );
  });

  it("names every one that is set, so one restart fixes them all", () => {
    let message = "";
    try {
      testConfig({ BEACON_BLACKLIST: "did:key:z6Mk", BEACON_GEO_USER_AGENT: "me" });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain("BEACON_BLACKLIST is now BEACON_BLOCKLIST");
    expect(message).toContain("BEACON_GEO_USER_AGENT is now BEACON_GEOCODE_USER_AGENT");
  });

  it("lets an empty one pass: it sets nothing either way", () => {
    expect(() => testConfig({ BEACON_PLACES_CONTRIBUTIONS: " " })).not.toThrow();
  });

  it("is read by no server code: the rename reached every place that reads a setting", () => {
    // A limiter names a prefix and adds _MAX and _WINDOW_MS, so the prefix is what to look for.
    const patterns = Object.keys(RETIRED_SETTINGS).map((old) => {
      const prefix = old.replace(/_(MAX|WINDOW_MS|DEBUG)$/, "");
      return new RegExp(`(?<![A-Z_])${prefix}(?![A-Z]|_LIMIT)`);
    });
    const src = join(__dirname, "..");
    const readers = readdirSync(src, { recursive: true, encoding: "utf8" })
      .filter((file) => file.endsWith(".ts") && !file.startsWith("__tests__"))
      .filter((file) => file !== "config.ts");
    const found = readers.flatMap((file) => {
      const text = readFileSync(join(src, file), "utf8");
      return patterns
        .filter((re) => re.test(text))
        .map((re) => `${relative(src, join(src, file))}: ${re.source}`);
    });
    expect(readers.length).toBeGreaterThan(50);
    expect(found).toEqual([]);
  });

  it("maps each old name to a new one that is not itself retired", () => {
    for (const now of Object.values(RETIRED_SETTINGS))
      expect(RETIRED_SETTINGS[now]).toBeUndefined();
  });
});

describe("* means every value", () => {
  it("covers every cell for coverage, alone or in a list", () => {
    expect(testConfig({ BEACON_COVERAGE: "*" }).coverage).toEqual([""]);
    expect(testConfig({ BEACON_COVERAGE: "c23n,*" }).coverage).toEqual([""]);
    expect(testConfig({ BEACON_COVERAGE: "" }).coverage).toEqual([""]);
  });

  it("opens the server to every game", () => {
    expect(testConfig({ BEACON_GAMES: "*" }).games).toEqual([]);
    expect(testConfig({ BEACON_GAMES: "" }).games).toEqual([]);
    expect(testConfig({ BEACON_GAMES: "my-game" }).games).toEqual(["my-game"]);
  });
});

describe("corsOriginOption", () => {
  it("allows no cross-origin request when the list is empty", () => {
    expect(corsOriginOption(testConfig({ BEACON_CORS_ORIGINS: "" }).corsOrigins)).toBe(false);
    expect(corsOriginOption(testConfig().corsOrigins)).toBe(false);
  });

  it("allows every origin for *", () => {
    expect(corsOriginOption(testConfig({ BEACON_CORS_ORIGINS: "*" }).corsOrigins)).toBe(true);
  });

  it("allows the listed origins", () => {
    expect(corsOriginOption(["https://app.example"])).toEqual(["https://app.example"]);
  });
});

describe("originAllowed: the live channel's handshake check", () => {
  const own = "https://beacon.example";

  it("lets a client with no Origin through, as REST does: it is not a browser page", () => {
    expect(originAllowed(undefined, false, own)).toBe(true);
  });

  it("refuses a browser origin when none is allowed, except the server's own", () => {
    expect(originAllowed("https://evil.example", false, own)).toBe(false);
    expect(originAllowed(own, false, own)).toBe(true);
  });

  it("takes a listed origin, or any for *", () => {
    expect(originAllowed("https://app.example", ["https://app.example"], own)).toBe(true);
    expect(originAllowed("https://evil.example", ["https://app.example"], own)).toBe(false);
    expect(originAllowed("https://evil.example", true, own)).toBe(true);
  });
});
