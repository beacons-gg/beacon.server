# Location lookups

The `geocode` capability turns a geohash into a human place label, and this spec covers it with the
outbound HTTP rules it follows. The server's own place dataset is a separate capability with a spec
of its own: [places](places.md).

Checked against Beacon 0.3.

Geocoding is a platform capability. The server proxies public geodata and caches it, and holds no
game rules.

## 0. Overview

| Capability | Input     | Proxies                                  | Returns                                                    | Cached by                  |
| ---------- | --------- | ---------------------------------------- | ---------------------------------------------------------- | -------------------------- |
| `geocode`  | a geohash | a reverse geocoder, Nominatim by default | `{ neighborhood?, city?, state?, country?, countryCode? }` | the coarsened geohash cell |

The capability is opt-in and advertised in the signed descriptor as `geocode`. The route is an
unsigned `GET` limited per IP address. An upstream failure answers `503` and never `500`. Each
result carries the data's attribution.

## 1. Principles

A read proxy belongs on the server when it meets five tests: addressed, game-agnostic, cached,
advertised and at risk. `geocode` is addressed by geohash and serves public geodata. The cache is a
store, and a miss fetches again: the server owns nothing durable here.

**Outbound HTTP has one seam.** Every call the server makes to a geocoder, a volume host or another
Beacon server goes through `common/outbound-http.ts`. The S3 client of the media store and of
backups is separate. Nominatim asks for fair use, and so does any host the server fetches volumes or
photos from. The seam gives every call these properties:

- an identifying `User-Agent` with a contact, `BEACON_GEOCODE_USER_AGENT`;
- a timeout on each request, so a slow upstream can't hold a client's request open;
- a minimum interval between calls to one upstream, so the server keeps the upstream's rate;
- a size limit on downloads, checked against `Content-Length` and again while reading;
- one typed error for every failure, so an upstream fault never becomes a `500`.

A request-path call fails fast on a `429` or a `503` from the upstream. Background work may wait out
a `Retry-After` within a budget. The photo transfer of an import is such work.

## 3. Shared foundation

- **Descriptor.** `geocode` joins the descriptor's `capabilities` while the capability is on.
- **No auth.** The route is a public read. Three things contain abuse:
  - the reference-data read budget per IP address, shared with the places reads;
  - the coarse cache key, since a caller can't bypass the cache with a finer geohash;
  - the outbound throttle, which protects the upstream even under a flood of misses.
- **One cache shape.** The cache answers a miss for an expired row, stores a result with its expiry
  and sweeps expired rows. A result with no label is cached on a shorter TTL, so an ocean cell
  doesn't call the upstream on every request.

## 4. `geocode`

### 4.1 Wire

`GET /geocode?geohash=<cell>` answers `geocodeResultSchema` from `@beaconsgg/protocol-types`:

```ts
{
  geohash: string,       // the coarsened cell this label is for
  neighborhood?: string, // neighborhood, suburb, quarter, city district or borough
  city?: string,         // city, town, village or municipality
  state?: string,        // state, region or province
  country?: string,
  countryCode?: string,  // ISO 3166-1 alpha-2, upper case
  displayName?: string,  // the provider's full label
  source: string,        // the provider, such as "nominatim"
  attribution: string,   // such as "© OpenStreetMap contributors (ODbL)"
  cachedAt: string,      // when the label was fetched
}
```

Every label field is optional, because coverage varies. An ocean cell resolves to a country at best,
and often to nothing.

| Status | When                                           |
| ------ | ---------------------------------------------- |
| `400`  | `geohash` isn't a valid geohash cell           |
| `404`  | the capability is off                          |
| `503`  | the provider failed and no cached label exists |

### 4.2 The provider seam

```ts
interface GeocodeProvider {
  reverse(lat: number, lng: number): Promise<PlaceLabel | undefined>;
}
```

`BEACON_GEOCODE_PROVIDER` picks the provider, and `nominatim` is the one this release builds. The
Nominatim provider calls `<endpoint>/reverse?format=jsonv2&addressdetails=1&zoom=14` and maps the
structured `address` to the label fields. Zoom 14 names the suburb or neighborhood. The structured
address still carries the city, the state and the country. An operator points
`BEACON_GEOCODE_ENDPOINT` at a self-hosted Nominatim or a paid host without a code change. Another
provider is one more implementation of the interface.

The settings schema accepts only a provider the server can build. A stored override naming any other
would stop the server at boot, and a stopped server can't serve the reset.

### 4.3 Flow

1. Coarsen the geohash to `BEACON_GEOCODE_PRECISION` (default 7). The coarsened cell is the cache
   key. A geohash already coarser stays as it is.
2. Answer a cached label that hasn't expired.
3. On a miss, reverse-geocode the cell's center through the outbound seam.
4. Store the label for `BEACON_GEOCODE_TTL` (default 30 days) and answer it. An empty result is
   stored for `BEACON_GEOCODE_NEGATIVE_TTL` (default 1 day).

**The label is only as fine as its cell.** The server labels the center of the cache cell and not
the point that asked. A geohash-7 cell is about 150 m across, and its center shares a neighborhood
with anywhere in the cell. A coarser cell's center often sits in a different neighborhood. A cell
coarser than geohash-7 therefore gets no `neighborhood`, and a city still names correctly at that
size. A precision setting below 7 logs a warning, because every label would then lose its
neighborhood.

While the server is locked read-only a lookup still answers and stores nothing.

### 4.4 Store

The `geocode_cache` table is keyed by `cell_key` and holds `result` as JSON text with `cached_at`
and `expires_at`. The table is indexed on `expires_at`. A sweep deletes expired rows once a minute.
The sweep checks the capability on each tick and waits while the server is locked.

A change to the provider's zoom changes the question every cached row answered, so such a change
ships with a migration that empties the cache. Emptying it costs one upstream call per cell, behind
the throttle.

## 5. Places from a third party

### 5.4 Trusted media ingest

The media service has a second ingest path for bytes the server itself produced or verified, such as
a place photo from an import. `ingestTrusted(bytes, type)` stores the bytes content-addressed with
the server's DID as owner, and computes the hash on the server. The path skips three checks of a
player's upload:

- the signed attestation, since no client signed anything;
- the per-DID quota, since the server owns the bytes;
- the EXIF check, since the bytes are a re-encoded WebP or already passed the media transfer's
  metadata check.

The type allowlist, the size limit and the store's limit still apply. Identical bytes dedupe by
hash.

## 6. Settings

| Setting                          | Default                                       | Meaning                                                   |
| -------------------------------- | --------------------------------------------- | --------------------------------------------------------- |
| `BEACON_GEOCODE`                 | `off`                                         | turns the capability on                                   |
| `BEACON_GEOCODE_PROVIDER`        | `nominatim`                                   | the provider                                              |
| `BEACON_GEOCODE_ENDPOINT`        | `https://nominatim.openstreetmap.org`         | the provider's base URL; self-host it for production load |
| `BEACON_GEOCODE_PRECISION`       | `7`                                           | the geohash precision of the cache key                    |
| `BEACON_GEOCODE_TTL`             | `2592000` (30 days)                           | how long a label stays cached, in seconds                 |
| `BEACON_GEOCODE_NEGATIVE_TTL`    | `86400` (1 day)                               | how long an empty result stays cached, in seconds         |
| `BEACON_GEOCODE_MIN_INTERVAL_MS` | `1000`                                        | the spacing between calls to the provider                 |
| `BEACON_GEOCODE_TIMEOUT_MS`      | `8000`                                        | the timeout of each call                                  |
| `BEACON_GEOCODE_USER_AGENT`      | `beacon-server/<version> (<contact or host>)` | the identifying User-Agent of every outbound call         |

Every geocode setting is a runtime setting ([runtime settings](runtime-settings.md) §3.2). The
public Nominatim asks for at most one request a second, which the default interval keeps.
