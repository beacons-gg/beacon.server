# Beacon integration

This spec covers how a Beacon server imports an Atlas volume. The spec covers trust and the
connector. The spec also covers the cells an import reads, how an imported place finds the place the
server already has and how photos move. The admin routes and the import options are in the server's
[places](../../../../doc/spec/places.md) spec, §6. What a volume holds is in the [volume
format](volume-format.md).

Checked against Beacon 0.3.

## 0. Overview

An Atlas volume is one of the three inputs a Beacon server takes places from. The other two are
player contributions and the operator's own edits. Importing a volume is a runtime admin operation:
the operator points the server at a volume, confirms who signed it and imports. No setting names a
volume, and adding one needs no redeploy.

Atlas lands on machinery the server already has:

- **The connector seam.** A connector maps one source's data to source places. The server's run
  engine does the rest: chunking, the merge, conflicts, retirement and progress. The Atlas connector
  is that seam's implementation.
- **A source that supplies its own photos.** A volume's tiles name photo bytes the builder already
  fetched, checked and encoded. The server copies those bytes and calls no third party.
- **Geohash chunks.** A volume tiles at geohash precision 5, the precision of the server's import
  chunks. One chunk is one tile.

Three precisions are easy to confuse. The volume's `cellPrecision` (5) is its tile grid. The import
chunk precision (5) is the server's fetch unit. `BEACON_PLACES_CELL_PRECISION` (default 6) is the
server's own spatial index. Only the first two need to agree, and the server refuses a volume whose
tile grid differs from its chunk precision.

## 1. The Atlas connector

The server builds one `AtlasConnector` per import run from the volume's verified root. The connector
is discarded when the run ends. The connector's id is `atlas:<volume>`, so each volume writes source
records of its own. Two volumes that describe the same place produce two source records that the
merge ranks against each other, and the console names each record's volume.

The connector receives a root that is already verified: the signature, the format, the taxonomy, the
index and the dictionary (volume format §8). The connector has no store access and so can't decide
trust. The import service verifies before it queues the run.

`fetchChunk` reads one tile:

- A cell the index doesn't list returns no places. The volume has no data there, and retirement is
  scoped to the cells the run read (§3).
- A listed tile whose bytes don't match the index hash is a thrown error and never an empty result.
  An empty result for an unreadable tile would mark the chunk done and then retire every place in
  it.

Each tile record becomes a source place:

| Source place field            | From the tile record                                                                 |
| ----------------------------- | ------------------------------------------------------------------------------------ |
| `sourceId`                    | derived from `upstream` by the fixed order in [place identity](place-identity.md) §6 |
| `aliasSourceIds`              | the record's `aliases`, for the run to follow (§4)                                   |
| `fields.category`             | `dict.categories[category]`, checked against the server's category list (§7)         |
| `fields.subcategory`          | `dict.subcategories[subcategory]`, checked against the slug pattern                  |
| `fields.point`                | `point`, flipped from `[lng, lat]` to `{ lat, lng }` and range-checked               |
| `fields.name`, `altNames`     | as published                                                                         |
| `fields.description`          | as published, with `descriptionCredit` from the dictionary or inline                 |
| `fields.website`, `wikipedia` | as published                                                                         |
| `fields.media`                | one entry per tile media entry, addressed at the volume (§5)                         |
| `attribution`                 | the `attribution` lines of the record's `sources`, deduplicated and joined           |

The connector leaves three things out on purpose:

- **No `raw` payload.** A tile record holds dictionary indices, which are per version. A new version
  that only re-interned its dictionary would change `raw` for every place, defeat the run's
  "unchanged" check and log every admin conflict again.
- **No image tags.** The server resolves nothing from a third party. The photos are already in the
  volume.
- **No polygons.** The connector doesn't read geometry tiles (§8).

## 2. Trust and import

Importing a volume takes up to three signed admin calls. The operator console makes them, and
[places](../../../../doc/spec/places.md) §6.2 lists them.

1. `places.atlas.inspect` reads the manifest and answers a preview. The preview names the volume and
   version with its place and photo counts. The preview also lists the sources with their licenses
   and names the publisher who signed the volume. The preview verifies the signature against the
   `did:key` the manifest names. The question the operator is answering is who signed the volume.
2. `places.atlas.survey` counts the places in an area by type and by content, so the operator picks
   filters with the numbers in view.
3. `places.atlas.import` restates the publisher the operator confirmed. The server verifies the
   manifest against that publisher before it queues the run.

**The first import of a volume pins its publisher.** The server stores the `did:key` for that volume
name, and every later import of the volume must be signed by the same key. A different key refuses
the run. Changing the key takes a deliberate `places.atlas.unpin`, never an override on an import.
The pin is trust on first use: the operator sees the key at the moment of the decision. A configured
allowlist would put that decision in a deploy, away from the evidence.

There is no unsigned mode. A volume whose signature doesn't verify against the pinned key is not
read at all.

**Three ways to reach a volume** share one verification chain:

| Input   | The operator gives                         | The server needs                                    |
| ------- | ------------------------------------------ | --------------------------------------------------- |
| URL     | a hosted volume's root or one version      | the host reachable for the length of the run        |
| path    | a directory under the mounted root         | `BEACON_ATLAS_VOLUMES_DIR` set                      |
| archive | a volume zip, uploaded through the console | nothing more; the server stages the archive on disk |

A URL may name the volume root. The server then reads `latest.json` and answers the version it
resolved as the preview's `versionUrl`. The console imports that URL, so the run imports the version
the operator reviewed even if a newer one lands in between.

A path is refused while `BEACON_ATLAS_VOLUMES_DIR` is unset. A set path names a directory under that
root only. A URL import makes one request per tile and per photo, so a mounted tree imports far
faster.

An uploaded archive carries its signed envelope in the `x-beacon-op` header, which states the
archive's hash and size. The server refuses bytes that don't match. The staged tree is deleted when
the run ends in any way. The server stages in a subdirectory of its own inside
`BEACON_ATLAS_STAGING_DIR` and clears only that subdirectory at boot. Every path read from
an archive must resolve inside the extracted tree.

The import ops need no capability of their own. They ride on `BEACON_PLACES` and the `BEACON_ADMINS`
allowlist like every other places admin route, and the server's descriptor advertises nothing new.

## 3. Import only your own cells

A volume covers a region, and a server usually covers less of it. An import is scoped by `cells`: a
list of geohash prefixes in the same form as a server's `coverage`. A server's own coverage copies
straight in. A prefix matches a volume cell in either direction, so coverage finer than the tile
grid still selects the tile that contains it. The match uses the same rule that discovery uses to
match coverage. An optional `boundary` narrows the scope further with a bounding box or a polygon.
The two combine with AND.

The run's chunks are the volume's own index cells inside that scope. A volume's bounding box covers
ocean and empty land the index never lists, so the run never walks a grid of empty cells.

**Retirement is scoped to the cells the run read.** A record of `atlas:<volume>` is marked gone only
when its point lies in a cell the run read and the new tile no longer holds it. A server that
imports half a volume never retires the places it didn't ask for. A cell the volume stopped holding
doesn't appear in the index, so the run doesn't read that cell and retires nothing there (§8 names
the case this leaves open).

The import options narrow what a run takes from the cells it reads, and two options can retire more.
Their scope rules are in [places](../../../../doc/spec/places.md) §6.2.

**A re-import of an unchanged version writes nothing.** The run fetches every tile in scope, and the
byte-identical check on each source record turns the run into a no-op. The server doesn't keep the
index it last imported, so the run doesn't skip unchanged cells (§8).

## 4. Landing on the right place

A server may already hold a place under another source: a volume of a neighboring region, or records
an earlier release's connector wrote. Without a cross-source lookup each new source would mint a
second copy of the place.

So the run resolves a record's place in this order:

1. The place that holds this `(source, sourceId)` record already.
2. A place the input states outright, as an imported list's `unique` does.
3. The place a **live** record of any source holds under the same `sourceId`.
4. The place a live record holds under one of the record's `aliasSourceIds`, tried in order.
5. A new place.

A statement beats an inference, so step 2 comes before step 3. Steps 3 and 4 follow live records
only. A gone record belongs to a source that stopped carrying the place, and attaching a new source
to it would bring back an identity the retirement deliberately let go. An indexed column on
`place_sources.source_id` serves the lookup.

**The `sourceId` spelling carries the whole match**, because the lookup is string equality. An
OpenStreetMap id is rendered in the form the server's older OSM connector wrote, `way/586464226`.
The volume's own `osm:w/586464226` form would match nothing. Every other namespace keeps its prefix
(`wd:Q2680081`) and can't collide with the OSM form. The builder and the server share the derivation
in `@beaconsgg/atlas-volume`. The order is fixed so two volumes derive the same key on their own
([place identity](place-identity.md) §6).

**Aliases follow merges.** When Atlas merges two places, the losing id becomes an alias of the
survivor. A place with no upstream id is keyed by its Atlas id, so an alias is a `sourceId` the
server may hold. Following it turns an upstream merge into a field update on the same place. A
retire and a create would lose the operator's edits and the players' contributions tied to the old
place.

The server never asks an operator to decide whether two places are duplicates. The conflict queue is
for an import that disagrees with an operator's own edit, and dataset hygiene is Atlas's job ([place
identity](place-identity.md) §0).

## 5. Media: ingest the bytes, own the result

For each photo entry of an imported place the run:

1. skips the download when the server already holds the advertised hash;
2. fetches the bytes from `media.base` and the hash on the host or in the staged tree, up to
   `BEACON_PLACES_IMAGE_MAX_BYTES`;
3. checks the bytes for embedded metadata and drops the entry when it finds any;
4. stores the bytes unmodified with `ingestTrusted`, which hashes them on the server;
5. drops the entry when that hash differs from the advertised one;
6. rewrites the entry's address to the server's own copy (`<hash>@<host>`), served at `GET
/media/:hash`.

A dropped entry costs the photo and never the place.

A hash the server already holds costs no download, so a re-import downloads nothing new. The
connector declares the media type from the format itself (`image/webp`). A static host often answers
with `application/octet-stream`, which the media capability refuses. A correctly published volume on
such a host would otherwise lose every photo.

The connector supplies the address of each file and never accepts one from the tile. A photo URL is
derived from the verified hash and the volume's own `media.base`, so a photo fetch can only reach
the volume being imported. An Atlas run uses an outbound client of its own with no pacing, because
static files owe nobody a rate limit. The paced client for other servers' media stays separate.

**The server never re-encodes.** Re-encoding would change the bytes and lose the hash check that
makes imported bytes trustworthy. A volume whose `mediaProfile` differs from the server's sizes
imports with a warning, and its photos keep the volume's sizes.

**The server never hot-links.** Serving a photo from the volume's host would send that host a
request each time a player looked at a place, which tells the host which places players visit. The
server stores the bytes and serves its own copy.

With media off the server can't hold photos, so an import takes the places without them. With
`importPhotos` set to `false` an import downloads no photos, and photos a place already holds stay.

## 6. Source priority

A Beacon server takes places from three inputs: Atlas volumes, player contributions (`contrib`) and
the operator's edits (`admin`). An imported list, `list:<name>`, is the operator's bulk mechanism
and ranks with the operator's choices. The merge ranks sources per field:

| Rank | Source        | Why it ranks here                                       |
| ---- | ------------- | ------------------------------------------------------- |
| 1    | `admin`       | the operator's manual edit                              |
| 2    | `list:<name>` | a list the operator chose to import                     |
| 3    | `contrib`     | a player's approved contribution beats the bulk dataset |
| 4    | `atlas:<vol>` | the bulk dataset is the floor                           |

Every volume shares the one `atlas:` rank. The server's own merge and retirement rules apply as
[places](../../../../doc/spec/places.md) §3 describes them. Atlas records are not protected from
retirement: when a volume stops carrying a place, the place goes unless another source still holds
it.

The three inputs keep every third-party call out of the server. Lookups against Wikidata, Wikipedia
and Wikimedia Commons happen once in the offline build. A throttled request there can wait and
retry.

## 7. Trust, and the one thing a check can't verify

A valid signature proves that a volume came from the pinned publisher and arrived intact. The
signature doesn't prove the publisher is right. The server adds two defenses and has one limit.

**The server checks again what it can.** The category must parse against the server's own category
list, the subcategory must match the slug pattern and the point must be in range. A record with a
bad category or point is dropped. A bad subcategory is dropped and the place imports without one.
Nothing is coerced. The connector counts the drops per chunk and logs them, because a volume that
quietly imports fewer places than it holds would look like a smaller volume.

**The limit: the sensitive-place exclusion can't be checked.** The place taxonomy keeps sensitive
locations such as schools, hospitals and places of worship out of the dataset. That rule applies to
OpenStreetMap tags during classification, and a published `category` carries no trace of whether the
rule ran. A server handed `category: "landmark"` can't tell.

So the exclusion holds through shared code and the operator's trust. Cartographer classifies with
the same `@beaconsgg/place-taxonomy` package the server uses. The manifest records the taxonomy
version. The operator pinned the publisher's key. This is the one place where the signature does
work a check can't do.

**A taxonomy mismatch is a documented behavior.** A volume built with a newer taxonomy than the
server's imports with a warning. The server drops each place whose category it can't parse and
counts the drop. A volume built with an older taxonomy imports normally.

## 8. What an import doesn't do

- **The server doesn't retire places in a cell the volume dropped.** Retirement works by cell (§3).
  When a new version holds no place in a cell, the version writes no tile for that cell and the
  index drops the cell. No run reads the cell, so the places the server holds there stay live. The
  common case is a reviewer removing a place that was alone in its cell. The manifest's `retired`
  list names such a place, and the server doesn't sweep that list. The preview reports how many ids
  a version retires.
- **The server doesn't import polygons.** The connector reads no geometry tiles, so imported places
  carry points only. Polygons come from operator edits and imported lists.
- **The server doesn't skip unchanged cells.** A re-import fetches every tile in scope, and the
  unchanged check turns the run into a no-op (§3).
- **The server doesn't re-import on a schedule.** An operator imports the next version to refresh.
  The merge takes in the changes and the scoped retirement removes what vanished.

## 9. The contribution round trip

Players are the one source that reaches the places no institution describes, such as trailheads and
neighborhood parks. The round trip carries approved contributions from a Beacon server into the next
volume. This is the one path where player-derived data travels toward a central party, so the server
keeps it off unless the operator turns it on.

**The export.** With `BEACON_PLACES_PROPOSALS_EXPORT` on, `places.contrib.export` writes a GeoJSON
file with the `beacon-contrib/1` profile. The license grant and the export's exact contents are in
[place proposals](../../../../doc/spec/place-proposals.md) §9a. In short:

| Travels                                                     | Stays on the server                                  |
| ----------------------------------------------------------- | ---------------------------------------------------- |
| the `contrib` record's own fields                           | every other source's fields                          |
| the id `contrib:<host>/<unique>`                            | the reviewer's note                                  |
| the ids of the place's other sources, for a builder to join | the DID of any contributor who didn't ask for credit |
| the license, CC0 1.0 or CC BY 4.0                           | any contribution with no license grant               |
| the DIDs of credited contributors                           | anything not approved                                |

**The consent model** fits in one sentence: a contribution may be published under CC BY 4.0 only
when its contributor chose to be credited and otherwise goes out under CC0 1.0. No share-alike
license is offered. A volume is redistributed by parties who never saw the form, and a copyleft
obligation they can't meet helps the contributor less than the weaker grant.

**The builder ingests the file as a source of its own.** An operator hands the file to Cartographer,
which never calls a Beacon server's API. The media stage fetches contributed photos from the
addresses the file names. Cartographer records the file as a build input and stages it
([Cartographer](cartographer.md) §1.2):

- An **improvement** to a known place joins that place by naming one of its records, and asserts no
  identifiers. A record that restated the place's identifiers would count as a second source
  agreeing with the volume's own earlier output ([place identity](place-identity.md) §7).
- A **new place** asserts `contrib:<host>/<unique>` and becomes a place of its own.

Contributed places and photos go through the same review console as every other source before they
publish ([Cartographer](cartographer.md) §5).

**The place comes home without a duplicate.** A volume keeps `contrib:<host>/<unique>` in a new
place's `upstream` forever. The server that issued the id renders it back to its own place `unique`
and lands the record on the original place. The server does this for its own host only, because a
ULID minted on another server belongs to an id space this server doesn't share. Without this step
the server would find no record under the new Atlas id and create a second copy of a place it
already holds, beside the edits and contributions tied to the original.
