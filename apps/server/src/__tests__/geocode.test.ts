import { beforeEach, describe, expect, it, vi } from "vitest";
import { OutboundError } from "../common/outbound-http";
import { normalize, type GeocodeProvider, type PlaceLabel } from "../geocode/geocode-provider";
import { GeocodeService, type GeocodeConfig } from "../geocode/geocode.service";
import type { GeocodeCacheStore } from "../stores/geocode-cache-store";
import { memoryGeocodeCache } from "./memory-stores";

describe("normalize — Nominatim reverse response → PlaceLabel", () => {
  it("maps a full address, upper-casing the country code", () => {
    expect(
      normalize({
        display_name: "SF, CA, US",
        address: {
          city: "San Francisco",
          state: "California",
          country: "United States",
          country_code: "us",
        },
      }),
    ).toEqual({
      city: "San Francisco",
      state: "California",
      country: "United States",
      countryCode: "US",
      displayName: "SF, CA, US",
    });
  });

  it("falls back through town/village/municipality/hamlet for the city", () => {
    expect(normalize({ address: { town: "Ashland", state: "Oregon" } })?.city).toBe("Ashland");
    expect(normalize({ address: { village: "Talent" } })?.city).toBe("Talent");
    expect(normalize({ address: { municipality: "Metro" } })?.city).toBe("Metro");
    expect(normalize({ address: { hamlet: "Wee" } })?.city).toBe("Wee");
  });

  it("reads the neighbourhood, finest tag first", () => {
    // OSM tags the same idea half a dozen ways and a place can carry several at once.
    const addr = { city: "Seattle", state: "Washington" };
    expect(
      normalize({ address: { ...addr, neighbourhood: "Pike-Market", suburb: "Downtown" } })
        ?.neighborhood,
    ).toBe("Pike-Market");
    expect(normalize({ address: { ...addr, suburb: "Ballard" } })?.neighborhood).toBe("Ballard");
    expect(normalize({ address: { ...addr, quarter: "Belltown" } })?.neighborhood).toBe("Belltown");
    expect(normalize({ address: { ...addr, city_district: "North" } })?.neighborhood).toBe("North");
    expect(normalize({ address: { ...addr, borough: "Brooklyn" } })?.neighborhood).toBe("Brooklyn");
    expect(normalize({ address: addr })?.neighborhood).toBeUndefined();
  });

  it("counts a neighbourhood as nameable on its own", () => {
    // Somewhere nameable is somewhere nameable, whatever rung it arrived at — otherwise this would be
    // negative-cached as "nothing here" for a day.
    expect(normalize({ address: { suburb: "Ballard" } })).toEqual({ neighborhood: "Ballard" });
  });

  it("returns undefined when there is no address or nothing useful", () => {
    expect(normalize({})).toBeUndefined();
    expect(normalize({ address: { country_code: "us" } })).toBeUndefined(); // nothing nameable
  });
});

describe("GeocodeService — cached reverse-geocode (`doc/spec/location-lookups.md` §4)", () => {
  const cfg: GeocodeConfig = {
    writeLocked: false,
    enabled: true,
    precision: 6,
    ttlSeconds: 100,
    negativeTtlSeconds: 10,
  };
  let store: GeocodeCacheStore;
  let clock: number;
  let reverse: ReturnType<typeof vi.fn<GeocodeProvider["reverse"]>>;
  let provider: GeocodeProvider;
  let svc: GeocodeService;

  const LABEL: PlaceLabel = {
    city: "San Francisco",
    state: "California",
    country: "United States",
    countryCode: "US",
  };

  beforeEach(() => {
    store = memoryGeocodeCache();
    clock = 1_000_000;
    reverse = vi.fn<GeocodeProvider["reverse"]>().mockResolvedValue(LABEL);
    provider = { id: "nominatim", attribution: "© OpenStreetMap contributors (ODbL)", reverse };
    svc = new GeocodeService(provider, store, cfg, () => clock);
  });

  it("fetches on a cache miss, stamps source/attribution, and stores the coarsened cell", async () => {
    const out = await svc.lookup("9q8yyk8yt"); // precision-6 cell = "9q8yyk"
    expect(out).toMatchObject({ ok: true, cached: false });
    if (!out.ok) throw new Error("expected ok");
    expect(out.result).toMatchObject({
      geohash: "9q8yyk",
      city: "San Francisco",
      countryCode: "US",
      source: "nominatim",
      attribution: "© OpenStreetMap contributors (ODbL)",
    });
    expect(reverse).toHaveBeenCalledTimes(1);
  });

  describe("a neighbourhood is only as precise as the cell it belongs to", () => {
    const FINE_LABEL: PlaceLabel = { ...LABEL, neighborhood: "Mission" };

    const serviceAt = (precision: number) =>
      new GeocodeService(
        { ...provider, reverse: vi.fn<GeocodeProvider["reverse"]>().mockResolvedValue(FINE_LABEL) },
        store,
        { ...cfg, precision },
        () => clock,
      );

    it("keeps it for a cell fine enough to support one", async () => {
      const out = await serviceAt(7).lookup("9q8yyk8yt");
      if (!out.ok) throw new Error("expected ok");
      expect(out.result.neighborhood).toBe("Mission");
    });

    it("drops it for a coarse cell, because we label the cell CENTER", async () => {
      // At ~1.2km that center is routinely in a different neighbourhood than the point that asked,
      // so the honest answer is to say nothing rather than name the wrong one.
      const out = await serviceAt(6).lookup("9q8yyk8yt");
      if (!out.ok) throw new Error("expected ok");
      expect(out.result.neighborhood).toBeUndefined();
      expect(out.result.city).toBe("San Francisco"); // ...without costing the caller the rest
    });

    it("stores what it serves, so a cache hit makes the same claim as the miss did", async () => {
      const svc6 = serviceAt(6);
      await svc6.lookup("9q8yyk8yt");
      const hit = await svc6.lookup("9q8yyk8yt");
      expect(hit).toMatchObject({ ok: true, cached: true });
      if (!hit.ok) throw new Error("expected ok");
      expect(hit.result.neighborhood).toBeUndefined();
    });
  });

  it("serves a cache hit without re-calling the provider", async () => {
    await svc.lookup("9q8yyk8yt");
    const hit = await svc.lookup("9q8yyk8yt");
    expect(hit).toMatchObject({ ok: true, cached: true });
    expect(reverse).toHaveBeenCalledTimes(1);
  });

  it("coarsens to the cache cell so nearby geohashes share one entry", async () => {
    await svc.lookup("9q8yyk111"); // → "9q8yyk"
    await svc.lookup("9q8yyk999"); // → "9q8yyk" (same cell)
    expect(reverse).toHaveBeenCalledTimes(1);
  });

  it("negative-caches an empty result (no re-fetch within the negative TTL)", async () => {
    reverse.mockResolvedValue(undefined);
    const out = await svc.lookup("9q8yyk8yt");
    expect(out).toMatchObject({ ok: true, cached: false });
    if (!out.ok) throw new Error("expected ok");
    expect(out.result.city).toBeUndefined();
    const hit = await svc.lookup("9q8yyk8yt");
    expect(hit).toMatchObject({ ok: true, cached: true });
    expect(reverse).toHaveBeenCalledTimes(1);
  });

  it("re-fetches after the entry expires", async () => {
    await svc.lookup("9q8yyk8yt");
    clock += cfg.ttlSeconds * 1000 + 1; // past the positive TTL
    await svc.lookup("9q8yyk8yt");
    expect(reverse).toHaveBeenCalledTimes(2);
  });

  it("returns a soft 503 on an upstream error and caches nothing", async () => {
    reverse.mockRejectedValueOnce(new OutboundError("http", "boom", 502));
    const fail = await svc.lookup("9q8yyk8yt");
    expect(fail).toEqual({
      ok: false,
      status: 503,
      error: "upstreamUnavailable",
      message: "geocoder unavailable",
    });
    // The next call retries the provider (nothing was cached) and succeeds.
    reverse.mockResolvedValue(LABEL);
    const ok = await svc.lookup("9q8yyk8yt");
    expect(ok).toMatchObject({ ok: true, cached: false });
    expect(reverse).toHaveBeenCalledTimes(2);
  });

  it("sweeps expired rows", async () => {
    await svc.lookup("9q8yyk8yt");
    clock += cfg.ttlSeconds * 1000 + 1;
    expect(await store.sweepExpired(new Date(clock).toISOString())).toBe(1);
  });
});
