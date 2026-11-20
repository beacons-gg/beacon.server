# Atlas volume format

An Atlas volume is a signed dataset of real-world places, published as static files. Cartographer
writes a volume, and a Beacon server's Atlas connector reads one. This spec is the contract between
the two. The `id`, `upstream` and `aliases` fields only make sense with the rules in [place
identity](place-identity.md).

Checked against Beacon 0.3.

The format has one design constraint, and the rest follows from it: a volume is files on a static
host. There is no server, no database and no query parameter. Every affordance a reader needs is
"fetch this path".

The types, the paths, the hash spelling and the signature check live in one package that both the
writer and the reader import: `@beaconsgg/atlas-volume`. A published version's bytes never change,
so a disagreement between two copies of the format could never be corrected in place.

## 0. What a volume is

A volume is one region at one version, written `<volume>@<version>` as in `cascadia@2026-11`. A
version holds these files:

- a signed **manifest**, small, which is the root of trust and the root of the hash tree;
- a **cell index**, which lists the geohash cells that hold data with a hash and a size for each;
- an interning **dictionary** of categories, subcategories, credits and source terms;
- one **tile** per non-empty geohash cell, plus a **geometry tile** for a cell with polygons;
- **content-addressed media**, already encoded to the Beacon place media profile.

A published version is immutable. A correction ships as a new version. Immutability lets a reader
cache a tile forever, and lets a mirror be a byte-for-byte copy.

The format doesn't decide how large a region is. One large volume is one build and one mirror. A
server covering a small area still reads only the cells it wants, through the index (§3). A server
can import as many volumes as it likes.

## 1. Layout

```text
<volume>/
  latest.json                    { "version": "2026-11", "manifest": "2026-11/manifest.json" }
  media/                         shared by every version that references a file
    9f/9f2c1e….webp              content-addressed, sharded by the first two characters
  2026-11/
    manifest.json                signed; hashes everything below, directly or through the index
    index.json                   the cell list
    dict.json                    the interning tables
    cells/
      c22zn.json                 one tile per non-empty geohash cell
      c22zn.geom.json            that cell's polygons, when it has any
```

`latest.json` is the only mutable file in a volume, and the file holds nothing but a pointer. A
publisher writes `latest.json` last, after every file the new version names exists. A reader that
follows the pointer therefore never meets a manifest that names a missing tile. A reader that names
a version never reads `latest.json` at all.

Media sits outside the version directory because most photos are identical between versions, and
content addressing makes sharing them free. A new version uploads its tiles and only the photos that
are new. The manifest names the media location in `media.base` instead of fixing a convention, so a
publisher can also point at a CDN or at a pool several volumes share. A reader follows `media.base`
and never builds the path on its own.

## 2. `manifest.json`

The manifest is the signed root, so the manifest stays small. Anything that grows with the dataset
lives in a file the manifest hashes.

```jsonc
{
  "format": 1, // this specification's version
  "volume": "cascadia",
  "version": "2026-11",
  "revision": 3, // rises across this volume's versions; fixed per version
  "createdAt": "2026-11-02T04:11:22.000Z",
  "publisher": "did:key:z6Mk…",

  "bounds": { "minLat": 41.0, "minLng": -125.0, "maxLat": 49.5, "maxLng": -116.0 },
  "coverage": ["c2", "c0", "9r"], // geohash prefixes, 2 characters, that hold data
  "cellPrecision": 5, // the tile grid
  "places": 132904,

  "index": { "path": "index.json", "hash": "sha256:1f0c…", "bytes": 6428423 },
  "dict": { "path": "dict.json", "hash": "sha256:77ab…", "bytes": 1738230 },
  "media": { "base": "../media/", "count": 48221, "bytes": 3478764676 },
  "retired": ["01K9Q7M4ZB8X2VNR5T0P0WR3AC"], // absent when no place was removed

  "taxonomy": 3, // the place taxonomy version the volume was classified with
  "mediaProfile": { "thumbPx": 256, "fullPx": 1024, "format": "image/webp" },

  "inputs": [{ "source": "osm", "artifact": "cascadia-261101.osm.pbf", "hash": "sha256:aa12…" }],
  "licenses": [
    {
      "id": "osm",
      "name": "OpenStreetMap",
      "license": "ODbL 1.0",
      "licenseUrl": "https://opendatacommons.org/licenses/odbl/1-0/",
    },
  ],
  "signature": "…",
}
```

**Hashes are `sha256:<base64url-nopad>` throughout.** Every hash names its algorithm, so a later
format can change the algorithm and a reader can tell. The algorithm is SHA-256 because a volume's
media hash is the Beacon server's media identity. The server re-hashes the bytes it ingests with
SHA-256 and refuses a mismatch, so a media hash in any other algorithm could never be ingested.
Hashing tiles one way and media another would trap every reader, so the whole tree uses one.

**The signature** is Ed25519 over the JCS canonicalization of the manifest with `signature` removed,
by the key that `publisher` names as a `did:key`. The signature is base64url without padding. There
is no unsigned mode. A reader reads a volume only when its publisher is one the reader was told to
trust (§8).

**`revision`** is a counter that rises across one volume's versions. A version owns its revision:
publishing the same version again returns the revision that version already has. Every tile repeats
the revision. A counter that rose with each publish attempt would rewrite every tile and the
signature for content that didn't change.

**The content is reproducible and the manifest records when it was made.** Publishing one version
twice from the same build database writes byte-identical tiles, index and dictionary. The two
manifests differ only in `createdAt` and so in their signatures.

**`coverage`** is the set of 2-character geohash prefixes the volume holds data in. A Beacon server
compares the set with its own coverage to pick what to import. The set is a claim about scope. Not
every cell under a prefix holds places.

**`retired`** lists place ids this version deliberately stopped publishing, because a reviewer
removed the place (see [Cartographer](cartographer.md) §5). Two readers need the list, and neither
can ask the builder. Cartographer's own continuity check reads only the published tree, so without
the list a deliberate removal would look like a place that vanished by mistake. A server's
retirement works by cell, so a removed place that was the only place in its cell leaves no tile and
no index entry to sweep. The list is signed with the rest of the manifest.

**`taxonomy`** is the version of the place taxonomy in `@beaconsgg/place-taxonomy` that classified
the volume. The number matters to a reader. A reader with an older taxonomy can meet a category it
has no case for, and one with a newer taxonomy can expect subcategories the volume doesn't carry. A
mismatch is a documented behavior with a warning, and never a silent coercion ([Beacon
integration](beacon-integration.md) §7).

**`mediaProfile`** says how the photos were encoded, so a reader can decide before downloading
whether to ingest the bytes as published (§6). The profile carries no aspect ratio, because place
photos are resized to fit inside one maximum dimension with no crop.

**`media.count` and `media.bytes`** count the distinct files this version's tiles reference, and
their total size. They don't count the contents of `media/`, which other versions share. Publishing
a version again writes no new media, so a count of what the publish wrote would change the manifest
and its signature for the same content.

**`inputs`** records the exact artifacts the build consumed, by SHA-256. The list makes a volume
auditable: the record answers which extract placed a park where it is. A reader doesn't need
`inputs` to import.

**`licenses`** restates the source terms from `dict.sources` at volume level, for the person who
decides whether they may redistribute the whole volume.

## 3. `index.json`

The index has one entry per non-empty cell.

```jsonc
{
  "cellPrecision": 5,
  "cells": [
    {
      "cell": "c22zn",
      "places": 143,
      "hash": "sha256:4c9e…", // of cells/c22zn.json
      "bytes": 18422,
      "geomHash": "sha256:0a71…", // of cells/c22zn.geom.json; absent when the cell has no polygons
      "geomBytes": 90218,
    },
  ],
}
```

The index does two jobs.

**Discovery.** A server covering the prefix `c0` would otherwise probe 32,768 possible precision-5
cells to find the few hundred that exist. The server reads the index once and fetches exactly those.

**Deltas without a delta format.** A cell whose hash is unchanged between two versions holds the
same bytes. A reader can keep the index it last imported and fetch only the cells whose hash
changed. A place gone from a re-read cell is absent from its tile, and the reader's own retirement
handles it. There is no delta artifact to build or publish.

The grid is geohash precision 5, the same precision a Beacon server uses for its import chunks. The
format package takes the number from `@beaconsgg/geo`, so one chunk is one tile by construction. The
index is a separate file because the index grows with the dataset and the signed root must not.

## 4. Cell tiles

```jsonc
{
  "cell": "c23nb",
  "revision": 3,
  "places": [
    {
      "id": "01KZACBCJFMHG7Q4CND9SJHWJN",
      "upstream": ["gnis:1531329", "nrhp:77001360", "osm:w/586464226", "wd:Q2680081"],
      "aliases": ["01K8H2A1YY4RM0QD7C6T9E1B5F"],

      "category": 2, // dict.categories index
      "subcategory": 7, // dict.subcategories index

      "name": "Mukilteo Lighthouse",
      "altNames": ["Mukilteo Light"],
      "description": "The Mukilteo Light is an operational navigation aid…",
      "descriptionCredit": 1, // dict.credits index, or an inline credit object
      "website": "https://mukilteohistorical.org/",
      "wikipedia": "https://en.wikipedia.org/wiki/Mukilteo_Light",

      "point": [-122.30474, 47.94766], // GeoJSON order [lng, lat], 5 decimals

      "media": [
        {
          "hash": "sha256:9f2c1e…",
          "role": "thumb",
          "credit": 4,
          "author": "…",
          "sourceUrl": "https://commons.wikimedia.org/wiki/File:…",
          "source": 3,
        },
        {
          "hash": "sha256:31aa08…",
          "role": "full",
          "credit": 4,
          "author": "…",
          "sourceUrl": "https://commons.wikimedia.org/wiki/File:…",
          "source": 3,
        },
      ],

      "sources": [0, 2], // dict.sources indices of the sources that won a field
    },
  ],
}
```

### Field notes

**`id`** is the place's Atlas id, a ULID that never moves and is never reused. **`upstream`** lists
the source identifiers the place was built from, and **`aliases`** lists the former Atlas ids of
places merged into this one. [Place identity](place-identity.md) §1 and §5 give the rules.

**`point` is always present, and a tile never carries a polygon.** Polygons live in the geometry
sibling (§5). Coordinates are in GeoJSON `[lng, lat]` order with 5 decimals (about 1 m) for points
and polygons alike.

**A place appears in exactly one tile**, the tile of the cell that holds its representative point.
For an area the representative point is a point inside the area (`ST_PointOnSurface`). A park whose
boundary spans four cells is not duplicated. The tile is a unit of distribution, and a reader keeps
its own spatial index. A server that imports only one cell therefore gets a large park whose polygon
reaches into that cell only when the park's point lies inside the cell.

**A place's cell comes from the published coordinate.** The writer rounds the point to 5 decimals
first and derives the cell from the rounded value. Near a cell edge the rounding can move a point
into the next cell, and partial import relies on every point lying in its own tile's cell.

**`media`** is absent for a place with no photos, and never `[]`. A Beacon server reads an empty
array as "this source supplies media", which would blank photos another source already gave the
place.

**A photo is two adjacent entries with the thumb first.** `role` is `thumb` or `full`. A Beacon
server's `Media[]` has the same shape and no group id. Adjacency is the only thing that joins a pair
at either end of the wire. A place carries at most 4 photos, so 8 entries. The writer caps by pair
and never splits one.

**`credit` is an integer or an object.** An integer indexes `dict.credits`. An object is an inline
credit for a one-off, so the dictionary never holds single-use entries. A credit carries the license
pair. `author` and `sourceUrl` sit outside the credit because they vary per file, and interning them
would make the dictionary as long as the media list.

**`source` on a media entry** indexes `dict.sources` and names the corpus the file came from. The
place's own `sources` can't stand in for it, because a place described by OpenStreetMap can carry a
photo from Wikimedia Commons. The field makes a source's files identifiable. A content hash says
what a file is and never where the file came from. A later version can therefore withdraw one
source's files, and a reader can rank a photo by where the photo came from.

**`descriptionCredit` travels with `description`.** The credit comes from the source whose
description won the merge, and the writer drops the credit with the text. A credit merged on its own
rank would put one source's license on another source's words.

**`sources`** lists every source that won at least one field of the place. A media-only source
doesn't join the list. A photo's attribution rides in its own credit. **`sources`** is what makes
attribution derivable for any place (§7).

**Length limits are applied by the writer**, so no reader ever rejects a place for its shape. A name
holds up to 256 characters and a description up to 500. A place has up to 8 alternative names. A
description over the limit is shortened, at a word boundary when one falls near the limit. A URL
over 300 characters is dropped, because a shortened URL is a wrong URL. The writer counts every
value it shortens or drops, and reports the counts.

## 5. Geometry tiles

```jsonc
{
  "cell": "c23nb",
  "revision": 3,
  "geometry": {
    "01KZACBCJFMHG7Q4CND9SJHWJN": {
      "type": "Polygon",
      "coordinates": [
        [
          [-122.3051, 47.9474],
          [-122.3049, 47.9474],
          [-122.3049, 47.9476],
          [-122.3051, 47.9474],
        ],
      ],
    },
  },
}
```

A geometry tile is keyed by place id, and a reader joins the polygons onto the tile it already
holds. Geometry is split from the main tile because polygons make up most of the JSON. A park
boundary of 200 positions at 5 decimals is about 4.4 KB, several times the rest of the place's
record. A reader that wants map pins and descriptions doesn't pay for boundaries, and a reader that
wants boundaries can fetch them later.

A polygon is a `Polygon` or a `MultiPolygon` within the Beacon wire caps. A ring holds up to 4096
positions, a polygon up to 16 rings and a multipolygon up to 64 polygons. The writer drops a polygon
over a cap instead of simplifying it, because a thinned boundary is a shape no source asserted. A
place without a polygon is still complete, and the place is published with its point. The writer
counts the dropped polygons.

## 6. Media

```text
media/9f/9f2c1e….webp
```

The file name is the content hash without its `sha256:` prefix, and the directory is the hash's
first two characters. Media therefore verifies itself and deduplicates across places and versions:
one logo shared by 200 stores is one file. The `.webp` extension is part of the address. A host may
answer with any `Content-Type`, including `application/octet-stream`: a Beacon server takes the
media type from the format and checks the bytes themselves ([Beacon integration](beacon-integration.md)
§5).

**Photos are published already encoded** to the Beacon place media profile. Each photo is a WebP
`thumb` that fits inside 256 px and a WebP `full` that fits inside 1024 px, with no crop. The
re-encode discards EXIF and other metadata. A photo is never enlarged. A source image smaller than a
size is published at its own size. Originals are never republished.

Publishing encoded bytes lets a Beacon server ingest **the bytes as received**, so the hash it
stores is the hash the manifest chain vouched for. A reader that re-encoded the bytes would change
them and lose that check. The sizes are constants in `@beaconsgg/protocol-types`, shared by every
producer of place photos. A server whose own profile differs learns so from `mediaProfile` before it
downloads anything. The Beacon server warns and ingests the bytes as published ([Beacon
integration](beacon-integration.md) §5).

**`media.base` resolves against the version directory.** The default `../media/` reaches the
volume's shared `media/` directory. Against a URL, `../` resolves correctly only when the base URL
ends in a slash. `mediaUrl()` in the format package adds the slash. An operator can type a version
URL either way, and the wrong form fails with a `404` that reads like "this volume has no photos".

**Partial import bounds media too.** A tile lists the hashes its places need, so importing four
cells downloads four cells' photos. Media is most of a volume's bytes, and no separate media
manifest is needed.

## 7. Attribution and licenses

`dict.sources` carries the terms a reader must honor for each source:

```jsonc
{
  "sources": [
    {
      "id": "osm",
      "name": "OpenStreetMap",
      "attribution": "© OpenStreetMap contributors (ODbL)",
      "license": "ODbL 1.0",
      "licenseUrl": "https://opendatacommons.org/licenses/odbl/1-0/",
    },
    {
      "id": "wikipedia",
      "name": "English Wikipedia",
      "attribution": "Wikipedia contributors",
      "license": "CC BY-SA 4.0",
      "licenseUrl": "https://creativecommons.org/licenses/by-sa/4.0/",
    },
    {
      "id": "nps",
      "name": "US National Park Service",
      "attribution": "Courtesy of the National Park Service",
      "license": "Public domain",
    },
  ],
}
```

`licenseUrl` is absent for public domain, because there is no license to link. Some sources carry a
license per file, as Wikimedia Commons does. Such a source states that in its `license` text and
names no single license. Each file's credit carries the license instead.

Three things together let a reader build a correct attribution line for any place, any field and any
photo:

- each place's `sources`, which name the corpora that won its fields;
- `descriptionCredit`, which credits the description's own text;
- each photo's `credit`, `author` and `sourceUrl`.

The Beacon wire already has a slot for each: the attribution line per source record,
`descriptionCredit` and `Media.credit`. The volume fills them.

The writer refuses to publish a volume that holds data from a source with no declared terms. A field
published without its license can't be fixed later, because a version's bytes never change. The
obligations of each source and what a redistributor inherits are in [sources](sources.md) §7.

## 8. Verification, in order

A reader verifies a volume with a SHA-256 function and one public key, in this order:

1. Fetch `manifest.json`. Verify the signature over the JCS canonicalization of the manifest without
   `signature`, against the `did:key` the reader was configured to trust. A volume from any other
   publisher is not read at all.
2. Check that `format` is a version the reader knows and that `taxonomy` is compatible. A Beacon
   server also requires `cellPrecision` to equal its own.
3. Fetch `index.json` and `dict.json`, and check each against its hash in the manifest.
4. For each wanted cell, fetch the tile and check it against the hash in the index. Check a geometry
   tile the same way against `geomHash`.
5. For each wanted media hash, fetch the file and check that the bytes hash to the name.

Everything below the manifest is hash-chained to it, so a signature over about a kilobyte covers a
volume of several gigabytes. A compromised or misconfigured host can withhold content and can't
substitute it.

The manifest check is fail-closed and never throws. The check parses the manifest from its own bytes
and reports one of these reasons, because each one is a different problem for the operator:

| Reason                     | Meaning                                                          |
| -------------------------- | ---------------------------------------------------------------- |
| `malformed`                | the file isn't JSON, names no publisher or has no canonical form |
| `unsigned`                 | the manifest carries no signature                                |
| `publisher-undecodable`    | `publisher` isn't a `did:key` the reader can decode              |
| `signature-invalid`        | the signature doesn't verify against `publisher`                 |
| `publisher-not-configured` | the volume is signed by a publisher the reader doesn't trust     |

A reader may verify the signature against the `did:key` the manifest itself names, to show an
operator who signed a volume before the operator trusts it. An import always verifies against the
publisher the operator confirmed.

## 10. Compatibility rules

- **`format` is the breaking-change lever.** A reader refuses a `format` it doesn't know. Adding an
  optional field doesn't change `format`, and a reader ignores fields it doesn't know. Changing the
  meaning of an existing field does change `format`.
- **Dictionary indices are per version.** `category: 2` can mean different things in two versions. A
  reader resolves every index through that version's own `dict.json`.
- **Place ids are stable forever**, across versions and across format changes ([place
  identity](place-identity.md) §5). A reader's stored state depends on this guarantee.
- **A version's bytes never change** once anyone could have fetched them. Not for a typo fix, and
  not for a re-signed manifest. Publish a new version instead. Mirrors and caches depend on this.
- **`latest.json` is the only mutable file**, and a publisher writes it last.
