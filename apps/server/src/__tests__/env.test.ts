import { afterEach, describe, expect, it } from "vitest";
import { boolEnv, intEnv } from "../common/env";

const KEY = "BEACON_TEST_ENV_TMP";

afterEach(() => {
  delete process.env[KEY];
});

describe("boolEnv", () => {
  it("is true for on/1/true/yes, case-insensitive and trimmed", () => {
    for (const v of ["on", "ON", "1", "true", "TRUE", "yes", "  Yes  ", "tRuE"]) {
      process.env[KEY] = v;
      expect(boolEnv(KEY)).toBe(true);
    }
  });

  it("is false for anything else, empty, or unset", () => {
    for (const v of ["0", "false", "no", "off", "2", ""]) {
      process.env[KEY] = v;
      expect(boolEnv(KEY)).toBe(false);
    }
    delete process.env[KEY];
    expect(boolEnv(KEY)).toBe(false);
  });
});

describe("intEnv", () => {
  it("parses a positive integer, flooring a fraction", () => {
    process.env[KEY] = "120";
    expect(intEnv(KEY, 60)).toBe(120);
    process.env[KEY] = "10.9";
    expect(intEnv(KEY, 60)).toBe(10);
  });

  it("falls back when unset, empty, non-finite, or <= 0", () => {
    delete process.env[KEY];
    expect(intEnv(KEY, 60)).toBe(60);
    for (const v of ["", "abc", "NaN", "-5", "0"]) {
      process.env[KEY] = v;
      expect(intEnv(KEY, 60)).toBe(60);
    }
  });
});
