# Places

The places capability serves a server's own curated dataset of real-world places. This spec covers
how the dataset is stored, merged, read and filled. This spec also covers the operator's curation
tools. Player submissions have a spec of their own: [place proposals](place-proposals.md).

Checked against Beacon 0.3.

Places are platform data. A place is a real-world point of interest with a neutral category, and the
server never interprets what a game does with one.

## 0. Overview

The server owns its place dataset and serves every read from its own store. No read calls a third
party, and no read has a cache or a freshness rule for a game to handle. Keeping the data current is
the operator's job: each server curates the areas it covers, which is the `coverage` it advertises
in its descriptor.

The dataset has three inputs, each written as a source record:

| Source        | What writes it                                                                      |
| ------------- | ----------------------------------------------------------------------------------- |
| `atlas:<vol>` | an import of an Atlas volume, a signed dataset built offline by the Atlas toolchain |
| `contrib`     | a player's proposal, once an operator approves it                                   |
| `admin`       | the operator's own edits and hand-made places                                       |

An operator can also import a GeoJSON file as a named list. A list is the `list:<name>` source, and
lists are how places move between servers.

| Feature         | Behavior                                                                                    |
| --------------- | ------------------------------------------------------------------------------------------- |
| Record identity | a permanent ULID per place, addressable as `unique@host` and kept through export and import |
| Several sources | one record per source and a per-field merge by source priority                              |
| Manual edits    | per-field operator overrides that no import can overwrite                                   |
| Geometry        | a point on every place, with an optional GeoJSON polygon for an area                        |
| Query           | several geohash cells and categories per request, with light lists and a detail route       |
| Portability     | GeoJSON export and import between servers                                                   |

## 1. Principles

- **The server can't verify a location claim.** Reads are public and limited per IP address. A check
  such as "is the player inside this park" runs on the client. The containment math is shared code
  in `@beaconsgg/geo` with conformance vectors, so the client and the server agree on every input
  (§9).
- **The capability is opt-in.** `BEACON_PLACES` turns places on. The signed descriptor advertises
  `places`, and every places route answers `404` while the capability is off.
- **Games code against the taxonomy.** A game reads `category` and `subcategory`. A source's raw
  tags stay on its source record. Each source maps its tags to the taxonomy when the data is built
  or imported, so adding or changing a source doesn't change what a game sees.
- **Attribution is a legal record.** A dataset that includes OpenStreetMap data is a derivative
  database under the ODbL. Each source record keeps its own attribution line. Every read result and
  every export carries the attribution of the sources it holds.
- **Reads never populate the dataset.** Data arrives only through an operator's run or edit, outside
  the request path. A read of an empty area returns an empty list.

## 3. Data model

The places tables live in the server's Postgres database. JSON values are stored as text.

| Table              | Holds                                                                                                      |
| ------------------ | ---------------------------------------------------------------------------------------------------------- |
| `places`           | the canonical dataset that queries serve: one row per place, keyed by its ULID `unique_id`                 |
| `place_sources`    | one row per `(source, source_id)`: the fields that source contributes, its raw payload and its attribution |
| `place_cells`      | the spatial index: geohash cells at `BEACON_PLACES_CELL_PRECISION` mapped to places                        |
| `place_snapshots`  | durable runs: the audit trail and progress of every import and sweep                                       |
| `place_conflicts`  | values an import brought for a field the operator holds, kept for review                                   |
| `atlas_publishers` | the publisher pinned for each Atlas volume (§6.2)                                                          |
| `place_proposals`  | player submissions, which no read path sees ([place proposals](place-proposals.md) §3)                     |

A canonical place carries these fields:

- `category` and `subcategory`;
- `name` and `altNames`;
- `description` and its `descriptionCredit`;
- `website` and `wikipedia`;
- a representative `point` and an optional `geometry`;
- `media`, its photos.

The `status` field is `active` or `retired`. A place is never deleted, because games may hold
references to it. `createdAt` is written once and kept on every later update.

One transaction commits a place together with its source records, its cell index and any new
conflicts. The store persists and queries. The merge is a pure function that runs before the write.

### 3.1 The merge

The canonical row is recomputed from the live source records whenever one of them changes. Each
field takes the value of the highest-priority live source that has one:

| Rank | Source        | Why it ranks here                                                                 |
| ---- | ------------- | --------------------------------------------------------------------------------- |
| 1    | `admin`       | the operator's manual edit                                                        |
| 2    | `list:<name>` | a list the operator chose to import                                               |
| 3    | `contrib`     | a player's approved contribution beats the bulk dataset                           |
| 4    | `atlas:<vol>` | the bulk dataset is the floor; every volume shares this rank                      |
| 5    | anything else | a source with no rank, such as records an earlier release's connector left behind |

Sources match by prefix, so every volume lands at the one `atlas:` rank. A source with no rank still
contributes below every input until the operator retires it (§6.3).

- **The merge is per field.** An operator who replaces a restaurant's photo holds `media` and
  nothing else. A later import that fixes the name still reaches the place. The `admin` record holds
  only the fields the operator set.
- **A credit travels with the text it credits.** `descriptionCredit` always comes from the record
  that won `description`. Merging the two on their own would put one source's license on another
  source's words.
- **Conflicts form a review queue.** When an import brings a value that differs from a field the
  `admin` record holds, the merge keeps the operator's value and the server writes a
  `place_conflicts` row. Collisions between other sources resolve by rank without a row, because
  only manual work is protected by review. The operator resolves a conflict by editing the field or
  by marking the row reviewed (§6.3).

### 3.2 Identity and adoption

- Within a source a record's identity is `(source, source_id)`, so a repeated import updates in
  place.
- Across sources the server looks up the place that any live record already holds under the same
  `source_id`. Then the server tries each former id the source lists. A match adopts that place
  instead of creating a second one. Source ids are namespaced so that two sources share an id only
  when they describe the same thing (the core identity spec, §6).
- A place this server created from a player's contribution returns in a volume as
  `contrib:<host>/<unique>`. The server recognizes its own host and lands the record on the original
  place.
- An imported list carries each place's `unique` (§7), so a re-import updates the same places.
- The server doesn't match places by name and distance. A source that describes a place under an
  unrelated id creates a new place.

### 3.3 Retirement

A run may retire only what it could have seen. A record of the run's source is marked gone when its
point lies in a cell the run read, its category was in the run's filter and the fresh data no longer
holds it. The import options can retire more, and the same scope rules hold them (§6.2).

When a record goes, the server merges the place's remaining live records again. A place retires when
no live record is left, or when the rest can't produce a category and a point and none of them is an
`admin` record. A place the operator has edited therefore never retires on its own. A retired place
leaves the queries and the cell index, and its rows stay.

## 4. Wire

The shapes are zod schemas in `@beaconsgg/protocol-types` (`places.ts`), and the server's OpenAPI
document is generated from them.

- `placeCategorySchema` is the category list: `park`, `nature`, `landmark`, `history`, `culture`,
  `entertainment`, `music`, `community`, `wildlife`, `sports`, `sweets`, `shopping`, `transport` and
  `surveillance`. Adding a category is compatible with older clients.
- `placeSubcategorySchema` is a short snake_case slug. Subcategories are namespaced by their
  category, so a client always reads the pair. `GET /places/taxonomy` lists the server's vocabulary.
- `placeGeometrySchema` is a bare GeoJSON geometry of type `Polygon` or `MultiPolygon`. Coordinates
  are in GeoJSON `[lng, lat]` order, and a game uses the `@beaconsgg/geo` helpers instead of reading
  them. A ring holds up to 4096 positions, a polygon up to 16 rings and a multipolygon up to 64
  polygons.
- `placeSummarySchema` is a list row: `unique`, `category`, `subcategory`, `name`, `point`,
  `hasGeometry`, `hasDescription`, `media` and `updatedAt`. A list row carries no polygon and no
  description.
- `placeDetailSchema` adds the polygon and the descriptive fields: `geometry`, `description`,
  `descriptionCredit`, `website`, `wikipedia` and `altNames`. The detail's `sources` lists the live
  sources with their attribution lines. With `?contributors=1` the detail also lists the credited
  contributors' DIDs in `contributors`.
- `placesQueryResultSchema` is `{ places, attribution, truncated, cursor? }`. `attribution` comes
  from the sources the page holds, and `truncated` says the page was full.

A description holds up to 500 characters, a URL up to 300 and a name up to 256. A place has up to 8
alternative names and up to 8 media entries.

## 5. Read API

| Route                                                   | Answers                   | Notes                                                                                     |
| ------------------------------------------------------- | ------------------------- | ----------------------------------------------------------------------------------------- |
| `GET /places?cells=&categories=&cursor=&limit=&spread=` | `placesQueryResultSchema` | `cells` is a comma-separated list of geohash cells, up to `BEACON_PLACES_QUERY_MAX_CELLS` |
| `GET /places/:unique`                                   | `placeDetailSchema`       | an unknown or retired place answers `404` `unknownPlace`                                  |
| `GET /places/taxonomy`                                  | `placeTaxonomySchema`     | the category and subcategory vocabulary                                                   |

The reads are public and unsigned. The places reads and `GET /geocode` share one budget per IP
address of `BEACON_PLACES_READ_RATE_LIMIT_MAX` requests (default 120) per
`BEACON_PLACES_READ_RATE_LIMIT_WINDOW_MS` (default 60000 ms).

- A cell finer than the index precision is coarsened to it. A coarser cell matches every indexed
  cell under it, down to a floor of the index precision minus 2. A coarser cell answers `400`.
- `categories` is optional and filters by category.
- A read is one indexed query against the store, with nothing upstream.

**Pages are keyset pages.** Places come in `unique` order. A page holds up to
`BEACON_PLACES_PAGE_SIZE` places (default 1000), and `limit` asks for a smaller page. When the page
is full and more places exist, the result sets `truncated` and returns a `cursor`. The cursor is the
last place's `unique`. Send the same query with `cursor` to read the next page, and stop when no
`cursor` comes back. Each page is an index range read with no offset scan.

**A spread page is for a map.** In ULID order the first page after a bulk import sits in one corner
of the area. With `spread=1` the server divides the query cells into about `limit` sub-cells and
takes a place from each in turn, in an order hashed from `unique`. A spread page is the only page,
so it returns no `cursor` and refuses one.

## 6. Population

### 6.1 The connector seam

A connector turns one source's data into taxonomy-mapped source places. A source place carries its
`sourceId` and the mapped fields. A source place may also carry the raw payload, an attribution line
and the ids the place had before. The run engine does the rest: reading chunk by chunk, the merge,
the conflicts, retirement and progress.

The Atlas connector is the one implementation. The server builds one from the volume being imported
and discards it after the run. A volume is static files: a signed manifest, a cell index and one
tile per geohash cell. The connector verifies each file's hash, so a tile it can't read is an error
and never an empty result. A cell the volume doesn't hold returns no places.

The connector checks every record again against the server's own rules: the category against the
category list, the subcategory against the slug pattern and the point against its range. A record
that fails is dropped and counted.

### 6.2 Runs

A run is durable. The server writes a `queued` row, and runs execute one at a time in the order they
were queued. One run at a time keeps retirement deterministic. An Atlas import reads the volume's
own index cells as its chunks. For each element the run takes these steps:

1. Skip the element when the stored record is identical.
2. Re-host the element's photos (§7).
3. Log a conflict for each field the operator holds and the element changes.
4. Merge the place's records again.

Writes land in batches of 500 elements per transaction, and progress is written to `stats` at most
once a second. After the last chunk comes the scoped retirement (§3.3).

A failed run is marked `failed` with an `error`. Running it again is safe, because every write is an
idempotent upsert. A restart marks any run left `queued` or `running` as failed. A canceled run
stops at its next chunk.

**Importing a volume** takes up to three signed calls, which the operator console makes:

1. The operator names a hosted volume URL, a directory under `BEACON_ATLAS_VOLUMES_DIR` or an
   uploaded archive. `places.atlas.inspect` answers a preview: the publisher who signed it, the size
   and how the publisher compares with the pin.
2. `places.atlas.survey` counts the places in an area by type and by content, so the operator picks
   filters with the numbers in view.
3. `places.atlas.import` restates the publisher the operator confirmed. The server verifies the
   signature against that publisher before it queues the run.

The first import of a volume pins its publisher. Every later import of that volume must match the
pin, and a mismatch refuses the run. Changing publishers takes a deliberate `places.atlas.unpin`.

An import can be scoped to coverage-style geohash prefixes (`cells`), a `boundary` and a list of
`categories`. The import's `options` filter and clean up:

| Option                  | Effect                                                                       |
| ----------------------- | ---------------------------------------------------------------------------- |
| `skipTypes`             | leaves out these category and subcategory pairs                              |
| `requirePhotos`         | leaves out places without a photo                                            |
| `requireName`           | leaves out places without a name                                             |
| `requireDescription`    | leaves out places without a description                                      |
| `importPhotos`          | `false` imports no photos and keeps the photos places already hold           |
| `retireMissing`         | `false` keeps records the new version no longer holds (default retires them) |
| `retireFiltered`        | retires records in the area that the content filters now leave out           |
| `retireUnselectedTypes` | retires records in the area whose type the import left out                   |

The last two hold to the exact area the operator asked for, so a place that shares a cell with the
area without lying inside it is never retired.

### 6.3 Admin surface

Every admin route is a signed `POST` that passes the shared admin gate ([admin API](admin-api.md)
§2). The gate needs these:

- a valid signature with a fresh `issuedAt`;
- a sender who isn't blocked;
- a device that isn't revoked;
- a DID on `BEACON_ADMINS`.

With places off or no admins configured the routes answer `404` `unknownRoute` as if absent. A
verified DID that isn't on the list gets `403`. Every write is idempotent: `places.snapshot.cancel`
and `places.atlas.unpin` by nature, and the rest by nonce. Params that don't parse answer `400`
`invalid`, with `fields` naming the keys this server doesn't know. A route that names something
missing answers `404` with a code for it: `unknownPlace` from `places.edit`, `unknownRun` from
`places.snapshot.cancel` and `unknownProposal` from `places.proposals.review`.

| Route                             | Op                         | Does                                                                       |
| --------------------------------- | -------------------------- | -------------------------------------------------------------------------- |
| `/places/admin/atlas/upload`      | `places.atlas.upload`      | streams a volume archive to disk and answers its preview                   |
| `/places/admin/atlas/inspect`     | `places.atlas.inspect`     | previews a hosted, mounted or uploaded volume                              |
| `/places/admin/atlas/survey`      | `places.atlas.survey`      | counts what a volume holds in an area                                      |
| `/places/admin/atlas/import`      | `places.atlas.import`      | queues an import run                                                       |
| `/places/admin/atlas/pins`        | `places.atlas.pins.fetch`  | lists every pinned publisher with who pinned it and when                   |
| `/places/admin/atlas/unpin`       | `places.atlas.unpin`       | forgets a volume's pin                                                     |
| `/places/admin/snapshots/fetch`   | `places.snapshots.fetch`   | reads one run by id, or the 50 most recent                                 |
| `/places/admin/snapshots/cancel`  | `places.snapshot.cancel`   | stops a run                                                                |
| `/places/admin/sources/retire`    | `places.source.retire`     | retires every live record of a source that is no longer an input           |
| `/places/admin/create`            | `places.create`            | makes a place by hand as an `admin` record                                 |
| `/places/admin/edit`              | `places.edit`              | sets or clears fields on a place's `admin` record                          |
| `/places/admin/conflicts/fetch`   | `places.conflicts.fetch`   | reads the conflict queue, unresolved first, for one place or all           |
| `/places/admin/conflicts/resolve` | `places.conflicts.resolve` | marks conflict rows reviewed                                               |
| `/places/admin/export`            | `places.export`            | exports the dataset or an area (§7)                                        |
| `/places/admin/import`            | `places.import`            | imports a file as `list:<name>` (§7)                                       |
| `/places/admin/contrib/export`    | `places.contrib.export`    | exports approved contributions ([place proposals](place-proposals.md) §9a) |

The archive upload carries its signed envelope in the `x-beacon-op` header, because the body is the
archive. The envelope states the archive's hash and size, and the server refuses bytes that don't
match. The route answers its `404` for places off or no admins before it reads the header, so a
request without one gets the same `404` as any other route here.

`places.create` and `places.edit` answer `{ ok, place }`, with `place` in the `placeDetailSchema`
shape that `GET /places/:unique` answers. An edit of a retired place answers that shape too.

**Editing.** `places.edit` takes `set` and `clear`. A set field joins the `admin` record and wins
the merge from then on. A cleared field leaves the record, and the next source in rank reaches the
place again. Clearing the last field marks the `admin` record gone. The place then returns to full
automatic behavior, and that includes retirement. An edit that sets or clears a field also resolves
that field's open conflicts. Editing a retired place brings the place back when the merge can serve
it.

**Creating.** `places.create` needs a category and a point. The new place is an `admin` record, so
the place behaves like an edited one.

**Retiring a source.** `places.source.retire` marks every live record of one source gone as a
durable run. The server refuses this for a living input such as `admin`, `contrib`, `list:*` or
`atlas:*`. Each of those retires through its own lifecycle. Records left by an earlier release's
connector are the case the route exists for. Run an Atlas import over the same area first. Adoption
follows only live records, so the import has to land on those places before their records go.
Otherwise each such place loses its identity and the edits and contributions tied to it.

## 7. Export and import

An imported file is one more source named `list:<name>`. The file goes through the same run, merge
and attribution rules as any other source.

- **The format is a GeoJSON FeatureCollection** with a `beacon` block whose `profile` is
  `beacon-places/1`. Each Feature's properties carry the place's `unique`, `point`, `media` and
  descriptive fields. The properties also list the place's live `sources` with their attribution.
  The geometry is the polygon, or the point when the place has none. The `beacon` block carries the
  exporting `host`, the export time and the dataset attribution. A list built from OpenStreetMap
  data is an ODbL derivative too, so its license travels with the file.
- **An export holds up to 2000 features.** A larger export sets `truncated`. An export may be
  limited to a `boundary`, a bounding box or a polygon.
- **Import replaces the list.** A `list:<name>` record absent from the new file is marked gone.
- **`unique` survives the move.** A place keeps its `unique` and changes its `@host`. Two servers
  that share a list agree on each place's identity, and a re-import updates the same places.
- **Media moves by content address.** An exported photo names its bytes as `hash@host`. The
  importing server fetches the bytes from the exporting server's public `GET /media/:hash`. The
  importer then checks the bytes for embedded metadata, ingests them and verifies the hash. A photo
  whose bytes fail is dropped. A hash the server already holds costs no download. With media off the
  server can't hold photos, so an import drops them. The same transfer re-hosts an Atlas volume's
  photos, so the server never serves bytes it doesn't hold.
- A `beacon-contrib/1` file is a contribution export and can't be imported as a list.

## 8. Settings

| Setting                                   | Default         | Meaning                                                               |
| ----------------------------------------- | --------------- | --------------------------------------------------------------------- |
| `BEACON_PLACES`                           | `off`           | turns the capability on                                               |
| `BEACON_ADMINS`                           | none            | the operator allowlist; with none set the admin routes answer `404`   |
| `BEACON_PLACES_PAGE_SIZE`                 | `1000`          | the largest and the default read page                                 |
| `BEACON_PLACES_QUERY_MAX_CELLS`           | `256`           | the cell limit per read, at most 256                                  |
| `BEACON_PLACES_CELL_PRECISION`            | `6`             | the precision of the cell index, set at deploy time                   |
| `BEACON_PLACES_READ_RATE_LIMIT_MAX`       | `120`           | places and geocode reads per IP address per window                    |
| `BEACON_PLACES_READ_RATE_LIMIT_WINDOW_MS` | `60000`         | the read window                                                       |
| `BEACON_PLACES_TIMEOUT_MS`                | `25000`         | the timeout for each request to a hosted volume                       |
| `BEACON_PLACES_IMAGE_MAX_BYTES`           | `10485760`      | the largest photo an import downloads                                 |
| `BEACON_PLACES_IMAGE_TIMEOUT_MS`          | `15000`         | the timeout for each photo download                                   |
| `BEACON_PLACES_IMAGE_MIN_INTERVAL_MS`     | `250`           | the spacing between photo downloads from another server               |
| `BEACON_ATLAS_STAGING_DIR`                | the OS temp dir | where uploaded archives wait for import, in a subdirectory of its own |
| `BEACON_ATLAS_VOLUMES_DIR`                | none            | a mounted directory of volume trees; set, it allows imports by `path` |

The proposal settings are in [place proposals](place-proposals.md) §8. The cell precision is a
deploy time setting because changing it on a live server would leave old places indexed at the old
precision. The [runtime settings](runtime-settings.md) spec covers which settings an operator can
change without a redeploy.

## 9. Geometry and containment

- Every place has a representative `point`. The point places markers, sorts by distance and keys the
  cell index. `geometry` is present only where an area means something, such as a park.
- `@beaconsgg/geo` exports `containsPoint(point, geometry)` and `geometryBBox(geometry)`. The ray
  cast starts with a bounding-box test and handles the antimeridian. The package ships conformance
  vectors that the client and the server both run, so the two never disagree on whether a player is
  inside a place.
- The database stores geometry as JSON and has no spatial extension. Spatial queries run on
  `place_cells`: the point's cell, plus every cell covering the polygon's bounding box.
- An Atlas volume carries no polygons, so polygons come from operator edits and imported lists.

## 10. What the server does not do

- The server doesn't match places across sources by name and distance (§3.2).
- The server doesn't re-run imports on a schedule. An operator runs an import again to refresh.
- The server doesn't pull lists from other servers. Lists move as files (§7).
- Place names come in one language.
- The read API has no `updatedSince` filter and no ETags, and the server sends no live events when a
  place changes.
