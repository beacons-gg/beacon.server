import { describe, expect, it } from "vitest";
import { loadMigrations } from "../migrations/runner";
import { testConfig } from "./test-config";

/**
 * Atlas ships as code only: nobody publishes a volume this server should reach for by default, and
 * trust in a publisher is the operator's decision at the moment of the first import
 * (`apps/atlas/doc/spec/beacon-integration.md` §2). These tests fail the day a default appears, so
 * adding one is a decision someone makes on purpose and not a line that slips into `config.ts` or a
 * migration.
 */
describe("Atlas has no default volume and no default publisher", () => {
  const config = testConfig();

  it("mounts no volume directory until the operator sets one", () => {
    expect(config.atlasVolumesDir).toBeUndefined();
  });

  it("has no setting for a volume URL or a publisher", () => {
    expect(Object.keys(config).filter((key) => /publisher|volumeUrl/i.test(key))).toEqual([]);
  });

  it("carries no publisher key in any default", () => {
    expect(JSON.stringify(config)).not.toMatch(/did:key:/);
  });

  it("starts every database with no pinned publisher", () => {
    // Any statement that writes rows into the pins table, however it names the table.
    const seeding = loadMigrations()
      .filter(({ sql }) => /\b(insert|copy)\b[^;]*\batlas_publishers\b/i.test(sql))
      .map(({ name }) => name);
    expect(seeding).toEqual([]);
  });
});
