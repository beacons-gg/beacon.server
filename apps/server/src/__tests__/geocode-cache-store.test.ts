import type { GeocodeResult } from "@beaconsgg/protocol-types";
import { beforeEach, describe, expect, it } from "vitest";
import type { GeocodeCacheStore } from "../stores/geocode-cache-store";
import { PgGeocodeCacheStore } from "../stores/geocode-cache.pg.store";
import { memoryGeocodeCache } from "./memory-stores";
import { memoryTwin, pgTwin, type StoreTwin } from "./pg-twin";

/**
 * The geocode cache (`0005_geocode`, `doc/spec/location-lookups.md` §4.4), run against Postgres and
 * the memory fake the service suites use.
 *
 * The label is stored as a JSON string in a TEXT column, and the migrations say in as many words
 * that TEXT was chosen over JSONB "so both dialects decode identically". That is a claim about
 * runtime behaviour written in a comment, which is the sort of claim that stops being true
 * quietly: `pg` hands back a parsed object for a JSON column and a string for a TEXT one, and the
 * shared decoder calls `JSON.parse` either way. These tests are what makes the comment checkable.
 */

const T0 = "2026-07-01T00:00:00.000Z";
const T1 = "2026-07-01T01:00:00.000Z";
const T2 = "2026-07-01T02:00:00.000Z";

function result(over: Partial<GeocodeResult> = {}): GeocodeResult {
  return {
    geohash: "c23nb62",
    city: "Seattle",
    source: "nominatim",
    attribution: "© OpenStreetMap contributors (ODbL)",
    cachedAt: T0,
    ...over,
  } as GeocodeResult;
}

const twins: StoreTwin<GeocodeCacheStore>[] = [
  memoryTwin(memoryGeocodeCache),
  pgTwin((pool) => new PgGeocodeCacheStore(pool), ["geocode_cache"]),
];

describe.each(twins)("GeocodeCacheStore parity ($name)", (twin) => {
  beforeEach(() => twin.reset());

  it("round-trips the whole label, including the fields a coarse cell omits", async () => {
    const store = await twin.open();
    const full = result({ neighborhood: "Capitol Hill", state: "WA", countryCode: "US" });
    await store.put("c23nb62", full, T2);

    // A cached label is served verbatim to the client, so an optional that vanished or arrived as
    // null in one backend would change what a player reads under a find.
    expect(await store.get("c23nb62", T1)).toEqual(full);
  });

  it("a coarse cell's absent neighborhood stays absent", async () => {
    const store = await twin.open();
    await store.put("c23nb6", result({ geohash: "c23nb6" }), T2);

    const got = await store.get("c23nb6", T1);
    expect(got).not.toHaveProperty("neighborhood");
  });

  it("copies in and out: changing a label after put, or after get, does not reach the cache", async () => {
    const store = await twin.open();
    const label = result();
    await store.put("c23nb62", label, T2);
    label.city = "Tacoma";
    const got = await store.get("c23nb62", T1);
    got!.city = "Spokane";
    expect(await store.get("c23nb62", T1)).toEqual(result());
  });

  it("re-caching a cell replaces the label and moves its expiry", async () => {
    const store = await twin.open();
    await store.put("c23nb62", result({ city: "Seattle" }), T1);
    await store.put("c23nb62", result({ city: "Tacoma", cachedAt: T1 }), T2);

    // The refresh path: one row per cell, and the new expiry has to land or the refreshed label
    // would be evicted on the old schedule.
    expect((await store.get("c23nb62", T1))?.city).toBe("Tacoma");
  });

  it("an expired cell misses at exactly its expiry, and the sweep reclaims it there", async () => {
    const store = await twin.open();
    await store.put("live", result(), T2);
    await store.put("stale", result(), T1);

    expect(await store.get("stale", T0)).toBeDefined();
    expect(await store.get("stale", T1)).toBeUndefined(); // `expires_at > now`

    expect(await store.sweepExpired(T1)).toBe(1); // `expires_at <= now`: the same instant
    expect(await store.get("live", T1)).toBeDefined();
  });
});
