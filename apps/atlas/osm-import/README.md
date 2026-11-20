# osm-import: the OSM extract becomes `beacon_places`

The import is the first job in an Atlas build, and the only one that reads the `.pbf` extract. The
job is an `osm2pgsql` flex import: a Lua style and a Dockerfile that installs osm2pgsql and bakes
the style in. **The job has no TypeScript and no `package.json`.** This is the one directory under
`apps/atlas/` that isn't a pnpm workspace member.

The design is in Atlas's Cartographer spec ([`cartographer.md`](../doc/spec/cartographer.md) §1.1).
Cartographer's stage 1 consumes the output, as the
[Cartographer README](../cartographer/README.md) describes.

## Run the import

Download a regional extract from [Geofabrik](https://download.geofabrik.de/) and move it into the
input directory. Don't use the full planet: the planet file is about 88 GB and needs a machine to
match.

```bash
cd apps/atlas
docker compose up -d osm-db
mv ~/Downloads/monaco-latest.osm.pbf osm-import/pbf/
PBF_FILE=monaco-latest.osm.pbf docker compose --profile import run --rm -T osm-import
```

> **Warning:** pass `-T`. Without it `docker compose run` creates the container and never starts
> it. The command exits 0 with no output and imports nothing, which looks the same as an import that
> found no rows.

`PBF_FILE` is a **file name inside the mount** and not a path on your host. The mount is
`ATLAS_INPUT_DIR` (default `./osm-import/pbf`), read-only at `/data`. So the same command works
against external storage:

```bash
ATLAS_INPUT_DIR=/run/media/<disk>/atlas-input-data/osm/pbf \
  PBF_FILE=monaco-latest.osm.pbf docker compose --profile import run --rm -T osm-import
```

`<disk>` is the mount point of the external drive. A regional extract imports in minutes.

Check the result:

```bash
docker compose exec -T osm-db psql -U beacon -d beacon_osm \
  -c "SELECT osm_type, count(*) FROM beacon_places GROUP BY 1;"
```

## What the import keeps

`beacon-places.lua` is a **coarse filter**, and the precise classification happens later. The
filter admits an object that has a `name` **and** any taxonomy _key_. The decision from a tag value
to a category happens downstream, through the shared `@beaconsgg/place-taxonomy` matcher.

That split matters: **a growing taxonomy re-runs a downstream stage and never needs a new import.**
So the table holds several times as many rows as the dataset ends up with. That shape is expected.

```lua
KEYS         = amenity, shop, leisure, tourism, natural, historic, man_made, railway, waterway
NAMELESS_OK  = man_made=surveillance, highway=speed_camera
```

`NAMELESS_OK` lists exact `key=value` pairs and not keys. The list exists because surveillance gear
almost never has a name. A bare _key_ such as `highway` would flood the import with every named
road.

`KEYS` mirrors the keys of the taxonomy's entries that need a name. `NAMELESS_OK` mirrors the
taxonomy's `nameless: true` pairs. **A test in `packages/server/place-taxonomy` pins both lists
against this file.** A key added to the taxonomy and forgotten here fails the build instead of
importing less. A change to either list needs a new import.

Each OSM object type becomes a geometry:

| OSM type | Becomes                                                    | Why                                                 |
| -------- | ---------------------------------------------------------- | --------------------------------------------------- |
| node     | a point                                                    | a node is a point                                   |
| way      | a polygon, **only when the way is closed**                 | a named linear feature such as a road isn't a place |
| relation | a multipolygon, only for `type=multipolygon` or `boundary` | osm2pgsql assembles the member rings itself         |

## The table

```sql
beacon_places (
  osm_id   bigint,      -- with osm_type, a per-namespace id: the connector rebuilds "node/123"
  osm_type char,
  name     text,        -- NULL only for NAMELESS_OK objects
  tags     jsonb NOT NULL,
  geom     geometry(4326) NOT NULL
)
```

The table has two indexes:

- **A GiST index on `geom`** for spatial queries.
- **A B-tree index on `(osm_type, osm_id)`.** Cartographer's stage 1 pages this table with
  `ORDER BY osm_type, osm_id` and a keyset cursor. The index keeps each page an index scan instead
  of a sort over the whole table. osm2pgsql builds an id index only when it expects updates, and
  `--create` without `--slim` expects none. So the style asks for the index explicitly.

## What survives `--create`

The import runs `--create`, which **replaces the table**. That is how a refresh works. `--create`
drops only the tables its own Lua declares. So **Cartographer's tables in the same database survive
a new import**, which is why the builder shares this database.

The negative caches (`wikidata_entities`, `wiki_articles` and `media_files`) survive a new import.
So do the identity tables `entities`, `entity_upstream` and `entity_aliases`. Those tables can't be
rebuilt. A refresh is cheap because of that.

## What the import records

After a **successful** import the job writes `/state/osm.input.json`:

```json
{
  "source": "osm",
  "artifact": "monaco-latest.osm.pbf",
  "sha256": "…",
  "bytes": 1234567890,
  "mtimeMs": 1753305600000
}
```

Cartographer's stage 0 _adopts_ that record instead of taking the path a second time. If you name
the extract twice, nothing checks that the two names agree. A build could then hash extract A while
`beacon_places` holds extract B. The manifest would then claim a reproducible build, and that claim
is the one stage 0 exists to make.

The shell line that writes the record makes three choices:

- **The job writes the record after the import succeeds**, so the record never claims an import
  that didn't happen.
- **The hash is plain `sha256sum` output in hex, with no pipeline.** `/bin/sh` here is dash, which
  has no `pipefail`. `set -e` doesn't catch a failure in the middle of a pipeline. A hash piped
  through `base64` or `tr` could come out empty and still exit 0. Cartographer converts the hex to
  the base64url form the rest of the platform prints.
- **The job keeps one record per _source_, named `osm.input.json`.** `--create` replaces the table,
  so the table holds one extract at a time. A record per file name would leave a stale record behind
  after an import of another extract. Stage 0 would then adopt both records, and the manifest would
  name an input the build wasn't made from.

## The image

The image is `debian:bookworm-slim` with osm2pgsql installed from apt. Bookworm ships osm2pgsql 1.8.
That release has flex output with jsonb columns and assembles multipolygons itself, which is all the
style needs. The image pins no third-party image.

The Dockerfile copies the Lua into the image at `/lua/beacon-places.lua`, so a **pulled** image
needs no checkout of the repository. So **an edit to the Lua needs a rebuilt image**:

```bash
docker compose --profile import build osm-import
```

The image builds from the **repository root** (`context: ../..` in `apps/atlas/docker-compose.yml`),
as the `cartographer` image does. The root `LICENSE` and `COPYRIGHT` then reach the image, next to
the Lua in `/lua/`. The root `.dockerignore` excludes `pbf/` and `data/` by their full path, so the
extracts of several GB stay out of the build context.

## Raw inputs live elsewhere

`pbf/` and `data/` are working copies that git ignores. You can keep the originals on other storage
sorted by source. Then point `ATLAS_INPUT_DIR` and `ATLAS_DATA_DIR` there:

```text
<disk>/atlas-input-data/
  osm/pbf/monaco-latest.osm.pbf
  wikimedia/commonswiki/commonswiki-latest-geo_tags.sql.gz
```

`data/` holds the files Cartographer opens itself: the Commons `geo_tags` dump (about 0.7 GB, for
the `commons-geo` stage) and any contribution file. Atlas doesn't download the Wikidata truthy dump,
the mediainfo dump or the article XML. No bulk download of Commons images exists.
