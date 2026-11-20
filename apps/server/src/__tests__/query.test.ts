import { geohashCellSchema } from "@beaconsgg/protocol-types";
import { HttpException } from "@nestjs/common";
import { describe, expect, it } from "vitest";
import { csvParam, validatedCsvParam } from "../common/query";

describe("csvParam", () => {
  it("splits, trims, and drops empties", () => {
    expect(csvParam(" a, b ,,c ")).toEqual(["a", "b", "c"]);
    expect(csvParam(undefined)).toEqual([]);
    expect(csvParam("")).toEqual([]);
  });
});

describe("validatedCsvParam (cells against the geohash allowlist)", () => {
  const cells = (v?: string): string[] =>
    validatedCsvParam(v, geohashCellSchema, { label: "cells", min: 1, max: 4 });

  it("accepts valid geohash cells", () => {
    expect(cells("gcpv,u4pr")).toEqual(["gcpv", "u4pr"]);
  });

  it("rejects LIKE/GLOB wildcards and other out-of-charset input (allowlist, not escaping)", () => {
    expect(() => cells("%")).toThrow(HttpException);
    expect(() => cells("_")).toThrow(HttpException);
    expect(() => cells("gcpv,%")).toThrow(HttpException);
    expect(() => cells("'; DROP TABLE rooms;--")).toThrow(HttpException);
    expect(() => cells("ai")).toThrow(HttpException); // a, i excluded from the geohash alphabet
  });

  it("enforces the count cap", () => {
    expect(() => cells("gc,u4,ez,sp,dr")).toThrow(HttpException); // 5 > max 4
  });

  it("enforces the minimum (cells required)", () => {
    expect(() => cells("")).toThrow(HttpException);
    expect(() => cells(undefined)).toThrow(HttpException);
  });
});
