import { OutboundHttp, OutboundLimiter } from "../common/outbound-http";
import type { ServerConfig } from "../config";

/**
 * The reverse-geocode provider seam (`doc/spec/location-lookups.md` §4.2). Mirrors the media
 * blob-backend seam (`media/media-blob.ts`): the interface the {@link GeocodeService} depends on,
 * the concrete provider(s), and the config selector all live together here. Config selects a
 * concrete provider, so an operator can point at a self-hosted Nominatim or a paid host — or add a
 * second provider — without touching the service.
 */

/** A coarse, human place label for a point. All fields optional — coverage varies by location. */
export interface PlaceLabel {
  neighborhood?: string; // the named area inside a city (neighbourhood | suburb | quarter | …)
  city?: string;
  state?: string;
  country?: string;
  countryCode?: string; // ISO-3166-1 alpha-2, upper-cased
  displayName?: string; // the provider's full formatted label
}

/** A reverse-geocoder the service can swap by config. */
export interface GeocodeProvider {
  /** Stable provider id recorded on the result (`source`), e.g. "nominatim". */
  readonly id: string;
  /** Data attribution to attach to every result (ODbL for OSM-derived data). */
  readonly attribution: string;
  /** Reverse-geocode a point → a label, or `undefined` when the point has none. Throws on upstream error. */
  reverse(lat: number, lng: number): Promise<PlaceLabel | undefined>;
}

/** The `address` subset of a Nominatim `jsonv2` reverse response we read (all fields optional).
 *  British spellings because they're Nominatim's, not ours — {@link normalize} maps them out. */
interface NominatimAddress {
  neighbourhood?: string;
  suburb?: string;
  quarter?: string;
  city_district?: string;
  borough?: string;
  city?: string;
  town?: string;
  village?: string;
  municipality?: string;
  hamlet?: string;
  state?: string;
  region?: string;
  province?: string;
  country?: string;
  country_code?: string;
}
interface NominatimReverse {
  display_name?: string;
  address?: NominatimAddress;
}

/**
 * Which rung of Nominatim's place hierarchy `/reverse` resolves to. Their ladder: 10 = city,
 * 12 = town/borough, 14 = suburb, 16 = major street, 17 = building.
 *
 * **14.** A find is a place you stood, and a city is too big to be one — a whole day's play in one
 * town produced the same three words on every memory. 14 names the suburb or neighbourhood, which is
 * the finest rung still honest about the cache cell whose center we actually send. Going finer would
 * mean tightening that cell, which multiplies both cache rows and upstream calls against a 1 req/s
 * budget — and naming the street someone was standing on is a step in privacy this label deliberately
 * doesn't take.
 *
 * `addressdetails=1` returns the full structured hierarchy regardless of zoom, so the coarser fields
 * stay populated: raising this refines the label without dropping city/state/country.
 *
 * **Changing this invalidates every cached row** — they answer the old question, on a TTL of up to 30
 * days. It needs a cache-flush migration; `0017_geocode_zoom` is the one that did it last.
 */
const REVERSE_ZOOM = 14;

/**
 * The coarsest cache cell an answer from {@link REVERSE_ZOOM} may be attached to: geohash-7, ~150 m.
 *
 * The pair of them is one judgement, which is why they're declared together — there is no arithmetic
 * from a Nominatim zoom to a geohash length, so nothing but proximity keeps them honest. We label the
 * **center** of the cache cell, not the point that asked: at 150 m the center shares a neighbourhood
 * with anywhere in the cell, while one character coarser is ~1.2 km, whose center routinely sits in a
 * *different* neighbourhood — confidently wrong rather than usefully vague. Raise the zoom and this
 * has to rise with it.
 *
 * Only the neighbourhood is affected. A 1.2 km cell still names its city perfectly well.
 */
export const NEIGHBORHOOD_MIN_PRECISION = 7;

/**
 * The default reverse-geocode provider: Nominatim's `/reverse` endpoint. Calls go through the shared
 * {@link OutboundHttp} (identifying User-Agent + timeout) behind the outbound {@link OutboundLimiter}
 * (Nominatim asks for ≤1 req/s). {@link REVERSE_ZOOM} picks the rung; `addressdetails=1` returns the
 * structured `address` we normalize into neighbourhood/city/state/country.
 */
export class NominatimProvider implements GeocodeProvider {
  readonly id = "nominatim";
  readonly attribution = "© OpenStreetMap contributors (ODbL)";

  constructor(
    private readonly http: OutboundHttp,
    /** A thunk: the endpoint is operator-editable, so it is read per request, not captured. */
    private readonly endpoint: () => string,
    private readonly limiter: OutboundLimiter,
  ) {}

  async reverse(lat: number, lng: number): Promise<PlaceLabel | undefined> {
    const url =
      `${this.endpoint()}/reverse?format=jsonv2&addressdetails=1&zoom=${REVERSE_ZOOM}` +
      `&lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lng)}`;
    const body = await this.http.getJson<NominatimReverse>(url, { limiter: this.limiter });
    return normalize(body);
  }
}

/** Normalize a Nominatim reverse response into a {@link PlaceLabel}; `undefined` when nothing useful. */
export function normalize(body: NominatimReverse): PlaceLabel | undefined {
  const a = body.address;
  if (!a) return undefined;
  // Finest first. OSM tags the same idea half a dozen ways and a place may carry several at once —
  // `suburb` is the common one in US cities, `neighbourhood` in dense cores, `borough` where the
  // administrative division is the thing people name.
  const neighborhood = a.neighbourhood ?? a.suburb ?? a.quarter ?? a.city_district ?? a.borough;
  const city = a.city ?? a.town ?? a.village ?? a.municipality ?? a.hamlet;
  const state = a.state ?? a.region ?? a.province;
  const country = a.country;
  const countryCode = a.country_code?.toUpperCase();
  // Nothing worth caching as a "label" → treat as no-result (the service negative-caches it). A
  // neighbourhood counts: somewhere nameable is somewhere nameable, whatever level it came in at.
  if (!neighborhood && !city && !state && !country) return undefined;
  return {
    ...(neighborhood !== undefined ? { neighborhood } : {}),
    ...(city !== undefined ? { city } : {}),
    ...(state !== undefined ? { state } : {}),
    ...(country !== undefined ? { country } : {}),
    ...(countryCode !== undefined ? { countryCode } : {}),
    ...(body.display_name !== undefined ? { displayName: body.display_name } : {}),
  };
}

/**
 * Select the reverse-geocode provider from config (the same "one switch picks the backend" shape as
 * `createMediaBlob`). Builds the shared outbound client (identifying User-Agent + timeout) and the
 * outbound throttle (min interval), then wires the chosen provider.
 */
/**
 * Every provider {@link createGeocodeProvider} can actually build.
 *
 * Declared here, beside the switch that consumes it, because it is also what the settings registry
 * validates an admin write against (`settings/registry.ts`). Those two must not drift: an override
 * naming a provider this switch rejects would be accepted at write time, persist, and then fail the
 * *next* boot — from an `app.module` factory, so the server would not come up, and a server that is
 * down cannot serve the admin op that would undo it.
 */
export const GEOCODE_PROVIDERS = ["nominatim"] as const;

export function createGeocodeProvider(cfg: ServerConfig): GeocodeProvider {
  // Accessors throughout, so the User-Agent, the timeout, the pacing and the endpoint all track an
  // operator's edit (`doc/spec/runtime-settings.md` §5). Which *class* gets built is still decided
  // here, at boot — `GEOCODE_PROVIDERS` has one entry, so it cannot change in this build, and the
  // day it has two the choice needs re-creating the provider rather than another accessor.
  const http = new OutboundHttp({
    get userAgent(): string {
      return cfg.geoUserAgent;
    },
    get timeoutMs(): number {
      return cfg.geocodeTimeoutMs;
    },
  });
  const limiter = new OutboundLimiter(() => cfg.geocodeMinIntervalMs);
  switch (cfg.geocodeProvider) {
    case "nominatim":
      return new NominatimProvider(http, () => cfg.geocodeEndpoint, limiter);
    default:
      throw new Error(
        `unknown BEACON_GEOCODE_PROVIDER: ${cfg.geocodeProvider} ` +
          `(expected ${GEOCODE_PROVIDERS.map((p) => `"${p}"`).join(" | ")})`,
      );
  }
}
