# Atlas: build and publish a place volume

Atlas is the toolchain that builds **place volumes** for Beacon servers. A volume is a signed set of
static files that holds the places of one region at one version. A Beacon server imports a volume
into its own places dataset from the operator console.

Beacon publishes no volumes. To give your server places from Atlas you build and sign a volume
yourself, or you import a volume that someone else publishes. This runbook covers both on a machine
of your own, from an OpenStreetMap extract to a server import.

Checked against Beacon 0.3.

| Topic                                         | Where                                                     |
| --------------------------------------------- | --------------------------------------------------------- |
| What a volume holds and what a reader checks  | [`volume-format.md`](doc/spec/volume-format.md)           |
| How the build works, stage by stage           | [`cartographer.md`](doc/spec/cartographer.md)             |
| Every source, its join and its license        | [`sources.md`](doc/spec/sources.md)                       |
| How a place keeps one id across versions      | [`place-identity.md`](doc/spec/place-identity.md)         |
| How a Beacon server imports and trusts a file | [`beacon-integration.md`](doc/spec/beacon-integration.md) |
| The server's places dataset and its admin ops | [`doc/spec/places.md`](../../doc/spec/places.md)          |
| Every Cartographer flag, table and error      | [`cartographer/README.md`](cartographer/README.md)        |
| The OpenStreetMap import job                  | [`osm-import/README.md`](osm-import/README.md)            |

## What a volume is

A volume is one region at one version, written `<volume>@<version>` as in `monaco@2026-11`. The
version directory holds a signed manifest and a cell index. The directory also holds a dictionary
and one tile per geohash cell. Photos sit beside the versions under `media/` and are addressed by
their SHA-256 hash. So versions share them. `latest.json` points at the current version.

```text
published/
  latest.json
  media/9f/9f2c1e….webp
  2026-11/manifest.json
  2026-11/index.json
  2026-11/dict.json
  2026-11/cells/c22zn.json
```

The manifest is signed with an Ed25519 key that the manifest names as a `did:key`. A server reads a
volume only when the operator trusts that key, and the first import of a volume pins the key. A
published version never changes. A correction ships as a new version.

One build database and one output directory hold one volume. To build a second region, copy this
directory and set a Compose project name of its own in the copy's `.env` file. An example is
`COMPOSE_PROJECT_NAME=atlas-iberia`. The project name gives the copy its own database. Both projects
publish port 5433, so stop one project's `osm-db` before you start the other.

## The toolchain

| Path                 | Role                                                                               |
| -------------------- | ---------------------------------------------------------------------------------- |
| `docker-compose.yml` | `osm-db` (PostGIS) and two jobs, each behind a profile: `import` and `cartograph`  |
| `osm-import/`        | the `osm2pgsql` import of a `.pbf` extract into the `beacon_places` table          |
| `cartographer/`      | **Cartographer**: the builder, with one subcommand per stage                       |
| `osm-import/pbf/`    | the default input directory for extracts (`ATLAS_INPUT_DIR`), which git ignores    |
| `osm-import/data/`   | the default directory for the files Cartographer reads (`ATLAS_DATA_DIR`), ignored |
| `state/`             | where the import records which extract the database holds, ignored                 |
| `published/`         | the volume Cartographer writes (`ATLAS_OUT_DIR`), ignored                          |
| `secrets/`           | the signing key (`ATLAS_SECRETS_DIR`), ignored and mounted read-only               |
| `doc/spec/`          | the Atlas specs                                                                    |

The toolchain runs apart from any game server. A game server never needs PostGIS and never reads the
build database. The server imports only the published volume.

## Before you start

You need:

- Docker with the Compose plugin;
- a checkout of this repository, to build the images and the signing key;
- Node.js 22 and pnpm 10 on the host, to create the signing key there (the container route below
  needs neither);
- the disk space in the next table;
- outbound HTTPS to the sources you turn on.

| What                                | Size                                                                        |
| ----------------------------------- | --------------------------------------------------------------------------- |
| the OpenStreetMap extract           | as Geofabrik lists it: under 1 MB for Monaco and several GB for a US region |
| the build database                  | a few times the extract, in the `osm-db-data` Docker volume                 |
| the Commons `geo_tags` dump         | about 0.7 GB to download and about 5.3 GB once loaded into the database     |
| the photos under `published/media/` | most of a volume: the format spec's example holds 48,221 photos in 3.5 GB   |
| a packed archive                    | the version's files plus every photo the version references                 |

The planet file is about 88 GB and needs a large machine. Start with a regional extract.

## Build the images

```bash
cd apps/atlas
docker compose --profile import --profile cartograph build
```

The build makes two local images tagged `latest`: `beacon-atlas-import` and
`beacon-atlas-cartographer`. Cartographer's image installs the `@beaconsgg/*` packages from the
registry that the repository's `.npmrc` names. Your npm user config is mounted as a build secret, so
the config must hold a token for that registry when the registry needs one. The secret file is
`~/.npmrc` unless `BEACON_NPMRC` names another file. The file must exist. The same packages are what
`pnpm install` fetches on the host.

`docker compose run` reuses an image that exists. Build again after you change the source, or pass
`--build` to `run`.

### Use an image registry

`ATLAS_REGISTRY` (default none) puts a registry in front of both image names, and `ATLAS_TAG`
(default `latest`) picks the tag. Write the registry without a trailing slash. With
`ATLAS_REGISTRY=registry.example.com` the images are
`registry.example.com/beacon-atlas-import:latest` and
`registry.example.com/beacon-atlas-cartographer:latest`.

Use a registry to run the build on another host from images you built here. On the machine with the
checkout, log in to your registry and push:

```bash
export ATLAS_REGISTRY=registry.example.com
docker compose --profile import --profile cartograph build
docker compose --profile import --profile cartograph push
```

On the build host copy `docker-compose.yml`, create the directories it mounts and pull:

```bash
mkdir -p state published secrets osm-import/pbf osm-import/data
export ATLAS_REGISTRY=registry.example.com
docker compose --profile import --profile cartograph pull
docker compose up -d osm-db
```

The images hold everything they run, so the build host needs no checkout. Never pass `--build`
there. A `run` pulls only when the image is missing and not when the image is stale, so `pull` again
after every push. When a pull fails, Compose falls back to a build and stops with
`failed to read dockerfile`. The registry's own error is a few lines above.

## Configure

Cartographer reads its settings from the environment. `docker compose run` passes them through from
your shell, so `export` them or put them in a `.env` file beside `docker-compose.yml`. Keep `.env`
out of git.

| Setting                          | Default                  | Used by                | What it is                                                     |
| -------------------------------- | ------------------------ | ---------------------- | -------------------------------------------------------------- |
| `CARTOGRAPHER_USER_AGENT`        | none                     | every network stage    | a descriptive agent with your contact details                  |
| `CARTOGRAPHER_NPS_API_KEY`       | none                     | `nps`                  | an api.data.gov key                                            |
| `CARTOGRAPHER_RIDB_API_KEY`      | none                     | `ridb`                 | a Recreation.gov RIDB key                                      |
| `CARTOGRAPHER_INTERVAL_MS`       | `200`                    | the Wikimedia stages   | milliseconds between Wikimedia API requests                    |
| `CARTOGRAPHER_BYTES_INTERVAL_MS` | `200`                    | `media`                | milliseconds between image downloads                           |
| `CARTOGRAPHER_MEDIA_MAX_BYTES`   | `12582912` (12 MiB)      | `media`                | the largest source image `media` downloads                     |
| `CARTOGRAPHER_KEY_FILE`          | `/secrets/publisher.key` | `publish`              | the signing key's path inside the container                    |
| `CARTOGRAPHER_S3_*`              | none                     | `upload`               | the bucket, as [Upload to a bucket](#upload-to-a-bucket) lists |
| `ATLAS_INPUT_DIR`                | `./osm-import/pbf`       | `osm-import`           | the host directory mounted read-only at `/data`                |
| `ATLAS_DATA_DIR`                 | `./osm-import/data`      | `cartographer`         | the host directory mounted read-only at `/data`                |
| `ATLAS_OUT_DIR`                  | `./published`            | `cartographer`         | the host directory mounted at `/out`                           |
| `ATLAS_SECRETS_DIR`              | `./secrets`              | `cartographer`         | the host directory mounted read-only at `/secrets`             |
| `ATLAS_REGISTRY`                 | none                     | both images            | the registry in front of the image names                       |
| `ATLAS_TAG`                      | `latest`                 | both images            | the image tag                                                  |
| `BEACON_NPMRC`                   | `~/.npmrc`               | the Cartographer build | the npm user config mounted as a build secret                  |

The two `/data` mounts differ on purpose. The import reads the extract from `ATLAS_INPUT_DIR`.
Cartographer reads the files it opens itself from `ATLAS_DATA_DIR`, such as the `geo_tags` dump and
a contribution file.

The Cartographer container runs as uid 1000. That uid must be able to write `published/` and read
the key file. When your own uid isn't 1000, add `--user "$(id -u):$(id -g)"` to every
`docker compose run ... cartographer` command.

> **Warning:** `osm-db` publishes port 5433 on every interface with the user and password `beacon`.
> On a host that others can reach, change the mapping to `127.0.0.1:5433:5432` and change the
> credentials.

### Optional sources and their keys

OpenStreetMap is the only source a build needs. Each optional source adds descriptions, photos or
links. Each one also costs network time and a share of the license obligations ([Data
licenses](#data-licenses)).

| Source                   | Stage         | What you need                                                         |
| ------------------------ | ------------- | --------------------------------------------------------------------- |
| Wikidata                 | `concordance` | `CARTOGRAPHER_USER_AGENT`                                             |
| English Wikipedia        | `wikipedia`   | `CARTOGRAPHER_USER_AGENT`                                             |
| US National Park Service | `nps`         | `CARTOGRAPHER_USER_AGENT` and an api.data.gov key                     |
| Recreation.gov (RIDB)    | `ridb`        | `CARTOGRAPHER_USER_AGENT` and an RIDB key                             |
| Wikimedia Commons        | `commons-geo` | `CARTOGRAPHER_USER_AGENT` and the `geo_tags` dump in `ATLAS_DATA_DIR` |
| KartaView                | `kartaview`   | `CARTOGRAPHER_USER_AGENT`                                             |
| Player contributions     | `contrib`     | a `beacon-contrib/1` file from a Beacon server                        |

The photos themselves come in the `media` stage, which also needs `CARTOGRAPHER_USER_AGENT`. `media`
fetches Commons photos named by tags, Wikidata and Wikipedia whether or not `commons-geo` runs. The
`commons-geo` stage adds the photos taken inside a place's own area.

`CARTOGRAPHER_INTERVAL_MS` paces `concordance`, `wikipedia`, `commons-geo` and the metadata pass of
`media`.

- **User agent.** Wikimedia's policy asks every client for a descriptive agent with a way to reach
  you. Set `CARTOGRAPHER_USER_AGENT` to your own tool name and contact address, such as
  `my-atlas-build/1.0 (ops@example.com)`. Every network stage refuses to run without the setting and
  never invents one.
- **NPS.** Get a free api.data.gov key from the [NPS developer
  page](https://www.nps.gov/subjects/developer/get-started.htm). The key allows 1000 requests an
  hour, and the stage makes one request per run. `DEMO_KEY` works for a test at 30 requests an hour.
- **RIDB.** Sign in at [ridb.recreation.gov](https://ridb.recreation.gov) and copy the API key from
  your profile. A run makes about 150 requests.
- **Commons `geo_tags` dump.** Download the dump into `ATLAS_DATA_DIR`:

  ```bash
  curl -L -o osm-import/data/commonswiki-latest-geo_tags.sql.gz \
    https://dumps.wikimedia.org/commonswiki/latest/commonswiki-latest-geo_tags.sql.gz
  ```

- **KartaView.** The API is anonymous and needs no key. The sweep is slow and resumes.

Keep both API keys out of git and out of `docker-compose.yml`.

## Create the signing key

Atlas has no unsigned mode, so create the key before the first publish. On the host, from the root
of the checkout:

```bash
pnpm install
pnpm --filter "@beaconsgg/cartographer..." build
node apps/atlas/cartographer/dist/main.js keygen --file apps/atlas/secrets/publisher.key
```

`keygen` writes a BIP39 recovery phrase with mode `600` and prints the key's public identity, a
`did:key`. Give that `did:key` to every operator who imports your volume. They confirm the key on
the import preview.

A host without Node.js can run `keygen` from the image. The `/secrets` mount is read-only, so mount
the directory a second time. Run the command in `apps/atlas`, or in the directory that holds your
copy of `docker-compose.yml`:

```bash
docker compose --profile cartograph run --rm -T --no-deps --user "$(id -u):$(id -g)" \
  -v "$PWD/secrets:/keys" cartographer keygen --file /keys/publisher.key
```

- `keygen` never overwrites. Run against an existing file, the command prints that key's `did:key`
  and stops.
- `publish` refuses a key file with any permission for the group or others. Keep the mode at `600`.
- Back the file up off this machine. The key can't be generated again, and git ignores `secrets/`.

> **Warning:** anyone who holds the key can publish places into the maps of every operator who
> trusts the key. Never commit the key or copy the key into an image. A new key makes every server
> that pinned the old key refuse your next version until the server's operator unpins by hand.

## Import the OpenStreetMap extract

Download a regional extract from [Geofabrik](https://download.geofabrik.de/) into
`osm-import/pbf/`, then import the extract:

```bash
cd apps/atlas
docker compose up -d osm-db
curl -L -o osm-import/pbf/monaco-latest.osm.pbf \
  https://download.geofabrik.de/europe/monaco-latest.osm.pbf
PBF_FILE=monaco-latest.osm.pbf docker compose --profile import run --rm -T osm-import
docker compose exec -T osm-db psql -U beacon -d beacon_osm \
  -c "SELECT osm_type, count(*) FROM beacon_places GROUP BY 1;"
```

`PBF_FILE` is a file name inside `ATLAS_INPUT_DIR` and not a host path. To import from other
storage, point the mount there:

```bash
ATLAS_INPUT_DIR=/mnt/atlas-input/osm \
  PBF_FILE=monaco-latest.osm.pbf docker compose --profile import run --rm -T osm-import
```

The last command of the first block counts what the import found. After a successful import the job
writes `state/osm.input.json`, the hash of the extract it read. Cartographer's first stage adopts
that record, so you never name the extract to Cartographer.

> **Warning:** pass `-T` to every `docker compose run`. On some hosts a run without `-T` creates the
> container and never starts the container. The command then exits 0 with no output and imports
> nothing.

## Run the build

Each stage is one run of Cartographer. A stage keeps its work as it goes, so an interrupted stage
resumes on the next run. Run the stages in this order and leave out the sources you don't use:

```bash
docker compose --profile cartograph run --rm -T cartographer inputs
docker compose --profile cartograph run --rm -T cartographer normalize
docker compose --profile cartograph run --rm -T cartographer concordance
docker compose --profile cartograph run --rm -T cartographer wikipedia
docker compose --profile cartograph run --rm -T cartographer nps
docker compose --profile cartograph run --rm -T cartographer ridb
docker compose --profile cartograph run --rm -T cartographer commons-geo --dump /data/commonswiki-latest-geo_tags.sql.gz
docker compose --profile cartograph run --rm -T cartographer kartaview --sweep
docker compose --profile cartograph run --rm -T cartographer resolve
docker compose --profile cartograph run --rm -T cartographer merge
docker compose --profile cartograph run --rm -T cartographer media
```

Some notes on the stages:

- `normalize`, `concordance`, `wikipedia`, `merge` and `media` take `--limit N` for a trial pass.
  Most stages take `--dry-run`. `cartographer/README.md` lists every flag.
- `commons-geo --dump` loads the dump once and replaces an earlier load. Run the stage without
  `--dump` to join again against the loaded dump.
- `kartaview --sweep --limit N` bounds the sweep to N sequences. Run the command again to resume.
  Without `--sweep` the stage joins the catalog the sweep already holds.
- To add player contributions, run the `contrib` stage before `resolve`
  ([Take in player contributions](#take-in-player-contributions)).

Four rules set the order. Only the last rule can produce a wrong volume. Breaking one of the others
only costs a second run.

1. Run `concordance` before `wikipedia`, `nps`, `ridb` and `media`. Those stages read the
   concordance to know which article, park, facility or logo a place is about. A concordance built
   before a newer source lacks that source's claims, so run `concordance --refresh` once.
2. Run every source before `resolve`. A source added afterwards means running `resolve` again, which
   takes under a minute.
3. Run `media` after every source has staged its photo references, so one crawl sees them all.
4. Never bound `resolve`. Identity is global, and a partial pass mints ids for wrong places.
   Cartographer refuses `--limit` on `resolve` for that reason.

| Stage                | Typical time                                |
| -------------------- | ------------------------------------------- |
| `osm-import`         | minutes for a regional extract              |
| `inputs`             | seconds                                     |
| `normalize`          | about a minute                              |
| `concordance`        | minutes of paced requests                   |
| `wikipedia`          | minutes of batched requests                 |
| `nps`                | seconds                                     |
| `ridb`               | about a minute                              |
| `commons-geo --dump` | about 20 minutes, once                      |
| `kartaview --sweep`  | hours against a slow API                    |
| `resolve`            | under a minute                              |
| `merge`              | about a minute                              |
| `media`              | hours                                       |
| `publish`            | minutes                                     |
| `verify`             | minutes, because every file is hashed again |

### Review the build

The review console serves on port 3200. Start the console any time after `resolve`, and press
Ctrl+C to stop the console:

```bash
docker compose --profile cartograph run --rm -T --service-ports cartographer review --reviewer <name>
```

`<name>` is the name your verdicts are recorded under, and the console refuses to start without one.
Plain `run` publishes no ports, so keep `--service-ports`. Open `http://localhost:3200`.

The console has three tabs:

- **Queue** lists the identifiers the merge gate refused to merge on. Your verdicts apply at the
  next `resolve`.
- **Decisions** lists the identity verdicts already recorded, so you can withdraw one.
- **Media** shows every photo that would publish. Reject a photo, unlink the photo from the wrong
  place or remove a place. Your verdicts apply at the next `publish`.

Wait for `media` to finish before you review photos. The crawl links photos to places once per page
of 500 places. In the middle of a crawl some photos show as `(unnamed place)` until their page
finishes. Nothing in the console blocks a volume, and you can withdraw any verdict later.

### Prune, publish and verify

```bash
docker compose --profile cartograph run --rm -T cartographer prune --dry-run
docker compose --profile cartograph run --rm -T cartographer prune
docker compose --profile cartograph run --rm -T cartographer publish --volume monaco --version 2026-11
docker compose --profile cartograph run --rm -T cartographer verify
```

- `prune` deletes the photo bytes that your verdicts withheld and the bytes nothing references. The
  stage keeps every photo a published version on disk references. Read the `--dry-run` report first.
- `publish` needs `--volume` and `--version`. The volume name must stay the same across versions,
  because servers pin the publisher per volume name. A version is any name you choose, such as the
  month.
- `publish` refuses to run while `merge` is incomplete or while the key file is readable by others.
- `verify` reads the published tree back as a server would and exits 1 on a failure.
  `--previous <version>` also checks that no place id vanished since that version. Pass the flag
  for every version after the first, as [Refresh a volume](#refresh-a-volume) shows.

> **Warning:** `prune --unlinked` also deletes photos that have no place link yet. A crawl in
> progress leaves photos in that state, so pass the flag only when no `media` run is going. To get a
> lost photo back, run `media` to link the photo again and `publish` to mark the missing bytes. Then
> run `media --retry`.

### Recover from a failed stage

Run the failed stage again. Every stage resumes from what the last run committed, and running a
later stage again never requires an earlier one.

| Symptom                                     | What to do                                                                                 |
| ------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `media` stopped before the end              | Run `media` again. The crawl resumes where the last run committed.                         |
| Upstreams throttled or deferred some photos | Run `media --retry`, which takes only the files still outstanding.                         |
| `published/media/` was lost or moved        | Run `publish` for a version you haven't shipped, then `media --retry` and `publish` again. |
| `nps` or `ridb` matches almost nothing      | The concordance predates the stage. Run `concordance --refresh`, then the stage again.     |
| A source was added after `resolve`          | Run `resolve`, `merge` and `media` again.                                                  |
| `publish` says the merge is incomplete      | A bounded `merge` ran last. Run `merge` without `--limit`.                                 |
| `verify --previous` reports vanished ids    | Don't ship the version. Check that the identity tables survived, as the next row says.     |
| Places come back with new ids               | The identity tables were lost. Stop, restore the backup and run `resolve` again.           |

Use `--retry` and not `--refresh` to recover photos. `media --refresh` asks again about every file
an earlier run settled, which repeats the whole crawl. The [Cartographer
README](cartographer/README.md#when-something-goes-wrong) lists more symptoms.

## Back up what can't be rebuilt

Most of the build database derives from the inputs. Place identity and the reviewers' verdicts
derive from nothing. Lose the identity tables and every place gets a new Atlas id, so
`verify --previous` fails. A server keys most places by their OpenStreetMap or Wikidata id, but a
place with no such id is keyed by its Atlas id. On every server that imported an earlier version
those places retire and come back as new places. The operator's edits and the players'
contributions stay with the retired copy. Back up these tables after every build:

```bash
docker compose exec -T osm-db pg_dump -U beacon -d beacon_osm \
  -t entities -t entity_upstream -t entity_aliases \
  -t decisions -t media_decisions -t place_decisions \
  -t publish_log > atlas-irreplaceable.sql
```

`publish_log` holds each version's revision number, which must keep rising across a volume's
versions. Keep the dump with three more things:

- the signing key, `secrets/publisher.key`;
- every published version under `published/`, since `verify --previous` and `prune` read them;
- the `state/` directory and the inputs you want to rebuild from.

## Publish a volume

A server can take a volume three ways: a zip archive, a hosted URL or a directory on its own disk.
The server checks every byte against the signed manifest in each case, so the host needs no trust.

### Pack an archive

```bash
docker compose --profile cartograph run --rm -T cartographer pack --version 2026-11
```

`pack` writes `published/2026-11.zip` with the version's files and every photo the version
references. Without `--version` the command packs the version `latest.json` names. Send the file to
an operator, who uploads the archive in the console. Nothing needs hosting.

### Upload to a bucket

`upload` copies a version to any S3-compatible bucket, such as AWS S3 or Cloudflare R2:

```bash
export CARTOGRAPHER_S3_BUCKET=my-atlas
export CARTOGRAPHER_S3_PREFIX=monaco
export CARTOGRAPHER_S3_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com
export CARTOGRAPHER_S3_ACCESS_KEY_ID=<access-key-id>
export CARTOGRAPHER_S3_SECRET_ACCESS_KEY=<secret-access-key>
docker compose --profile cartograph run --rm -T cartographer upload --dry-run
docker compose --profile cartograph run --rm -T cartographer upload
```

`<account-id>` is your Cloudflare account, and the two keys are a key pair for the bucket.

| Setting                             | Default         | What it is                                                       |
| ----------------------------------- | --------------- | ---------------------------------------------------------------- |
| `CARTOGRAPHER_S3_BUCKET`            | none, required  | the bucket                                                       |
| `CARTOGRAPHER_S3_PREFIX`            | the bucket root | the key prefix for the volume; `--prefix` overrides the setting  |
| `CARTOGRAPHER_S3_ENDPOINT`          | AWS             | the S3 API endpoint; set the endpoint for R2 and other hosts     |
| `CARTOGRAPHER_S3_REGION`            | `auto`          | the region; AWS needs a real one                                 |
| `CARTOGRAPHER_S3_ACCESS_KEY_ID`     | none, required  | a key that may list and write the bucket                         |
| `CARTOGRAPHER_S3_SECRET_ACCESS_KEY` | none, required  | the key's secret                                                 |
| `CARTOGRAPHER_S3_FORCE_PATH_STYLE`  | off             | `1` for hosts that want path-style URLs                          |
| `CARTOGRAPHER_S3_PUBLIC_URL`        | none            | the bucket's public origin, for the import URL the upload prints |

How the upload behaves:

- The upload sends the files `pack` would zip. Without `--version` the upload sends the version
  `latest.json` names.
- A run resumes. Version files and photos never change, so a second run sends only what is missing.
- `latest.json` goes last, so a reader never follows the pointer into a version still arriving.
- Every file except `latest.json` is sent with a one-year `immutable` cache header.
- The command prints the import URL at the end: the volume's root, where `latest.json` lives. A
  server follows `latest.json` from the root, so a later import from the same URL takes the newest
  upload. Set `CARTOGRAPHER_S3_PUBLIC_URL` to print the full URL; without the setting the
  origin is a placeholder.

The bucket must serve public reads, through a public bucket or a CDN in front. A server sends no
credentials when the server imports. Photos are most of a volume's bytes, so a host without egress
fees costs least. Keep the key pair out of git, and give the pair write access to this bucket only.

`aws s3 sync published/ s3://my-atlas/monaco/` also works. That command skips the upload order and
the cache headers.

## Import a volume into a Beacon server

The server needs `BEACON_PLACES=on` and your DID in `BEACON_ADMINS`. For photos the server also
needs `BEACON_MEDIA=on`. Without the media store an import brings in the places and drops every
photo. Photos count against `BEACON_MEDIA_LIMIT_BYTES` when that limit is set, and a run that fills
the store reports the photos it left out as `imagesStorageFull`. An import needs no restart. The
[server README](../server/README.md) lists the places and media settings.

In the operator console open **Places** and the **Atlas: import a volume** card. Choose one input:

| Input          | What you give                                                                   | What the server needs                              |
| -------------- | ------------------------------------------------------------------------------- | -------------------------------------------------- |
| Hosted URL     | the volume root such as `https://atlas.example.com/monaco/`, or one version URL | the host reachable for the whole run               |
| Volume archive | the `.zip` from `pack`                                                          | disk for the archive in `BEACON_ATLAS_STAGING_DIR` |
| Mounted path   | a directory name under `BEACON_ATLAS_VOLUMES_DIR`                               | `BEACON_ATLAS_VOLUMES_DIR` set                     |

A root URL follows `latest.json` to the current version. A version URL imports that version only.
Then work through the card's steps:

1. **Review the volume.** The preview shows the volume, the version, the counts, the sources with
   their licenses and the `did:key` that signed the volume. Confirm the key with the publisher on a
   channel you trust.
2. **Choose the area.** Leave the geohash prefixes blank for the whole volume, or survey an area to
   see what the volume holds there.
3. **Choose what to import.** Leave out types. You can also leave out places without a photo, a name
   or a description.
4. **Confirm and import.** The run shows under Recent runs with progress and a cancel button.

[`places.md`](../../doc/spec/places.md) §6.2 describes every import option and the retirement
rules.

### Trusted publishers

The server keeps no list of trusted publishers in its settings. The first import of a volume name
pins the `did:key` that signed the volume. Every later import of that volume name must carry a
signature by the same key, and the server refuses any other key.

The **pinned publishers** card lists each pinned volume with who pinned the volume and when.
**Unpin** forgets a pin, and the next import of that volume asks you to confirm a key again. Unpin
only when the publisher tells you the key changed on purpose.

### Mount volumes on the server

A URL import makes one request per tile and per photo. A volume on the server's own disk imports at
disk speed:

1. Copy each volume's output directory under one root with one directory per volume, such as
   `/srv/atlas/monaco/`. Copy the whole tree, including `latest.json` and `media/`.
2. Mount the root into the server's container read-only, and set `BEACON_ATLAS_VOLUMES_DIR` to the
   path inside the container.
3. In the console enter `monaco` as the mounted path. Enter `.` when the root itself is one volume.

The server refuses a path outside the root, and refuses every path while the setting is unset.

### Replace places from an older source

This step matters only on a server upgraded from a release whose own OpenStreetMap connector
imported places. Such a server keeps those places until the source is retired. Import the Atlas
volume over the same area first, so each place adopts its new record and keeps its id. Then retire
the old source in the **Retire a source** card. Retiring first gives every such place a new identity
and drops the edits and contributions tied to the place.

## Refresh a volume

1. Download the extract again and run `osm-import` again. The import replaces `beacon_places` and
   keeps every Cartographer table.
2. Run the stages again from `inputs` to `media`. The network stages keep their answers in the
   database and ask only about what is new.
3. Review the new photos and run `prune`.
4. Publish a new version under the same volume name, and verify the new version against the last.
5. Back up the tables in [Back up what can't be rebuilt](#back-up-what-cant-be-rebuilt).
6. Run `pack` or `upload` for the new version.

```bash
docker compose --profile cartograph run --rm -T cartographer publish --volume monaco --version 2026-12
docker compose --profile cartograph run --rm -T cartographer verify --previous 2026-11
docker compose --profile cartograph run --rm -T cartographer upload
```

Servers pick up the new version when their operators import again. The merge per field takes in the
changes, and the import retires what vanished from the cells the import read.

## Take in player contributions

A Beacon server can export the player contributions its operator approved. The export is off by
default. On the server:

1. Set `BEACON_PLACES_PROPOSALS_EXPORT=on`, or turn on **Contribution export** in the console's
   settings.
2. On the **Places** page open **Share contributions** and choose **Export contributions**. The
   console saves a `beacon-contrib/1` file.

The file carries the contributed fields, each contributor's license grant and the DIDs of the
contributors who asked for credit. [`beacon-integration.md`](doc/spec/beacon-integration.md) §9
lists what stays on the server.

On the build machine, put the file in `ATLAS_DATA_DIR`. Record the file and stage the file before
`resolve`:

```bash
docker compose --profile cartograph run --rm -T cartographer inputs --input contrib=/data/contrib.json
docker compose --profile cartograph run --rm -T cartographer contrib --file /data/contrib.json
docker compose --profile cartograph run --rm -T cartographer resolve
```

Then run `merge` and `media` and the rest of the build. `media` downloads the contributed photos
from the addresses the file names. Contributed places go through the review console like every other
source. A new place carries its server's own id `contrib:<host>/<unique>` among its upstream ids.
When that server imports the volume, the server lands the place on the original instead of adding a
copy.

## Data licenses

> **Note:** this section describes how Atlas handles each source's terms. The section isn't legal
> advice. Read each source's terms before you distribute a volume, and ask a lawyer when you are
> unsure.

When you publish a volume you are the one who distributes the data, and the obligations of every
source in the volume apply to you. They also apply to every operator who imports the volume and
shows or passes on its data.

| Source                | License              | What a publisher owes                                                       |
| --------------------- | -------------------- | --------------------------------------------------------------------------- |
| OpenStreetMap         | ODbL 1.0             | attribution to OpenStreetMap contributors, and share-alike for the database |
| English Wikipedia     | CC BY-SA 4.0         | attribution and share-alike for each Wikipedia description                  |
| Wikimedia Commons     | per file             | what each photo's own license asks, as its credit states                    |
| KartaView             | CC BY-SA 4.0         | attribution and share-alike for each KartaView photo                        |
| Park Service and RIDB | public domain (US)   | nothing in the US; the volume credits the source as a courtesy              |
| Player contributions  | CC0 1.0 or CC BY 4.0 | attribution as CC BY 4.0 for every contributed field, which always suffices |
| Wikidata              | CC0 1.0              | nothing; Wikidata adds links and no published fields                        |

A volume is a database derived from OpenStreetMap, so the
[ODbL](https://opendatacommons.org/licenses/odbl/1-0/) covers the place records as a database. The
descriptions and photos keep their own licenses. Under the ODbL a publisher offers the volume under
the ODbL and keeps the OpenStreetMap attribution and license notice with the volume. A game that
shows places from a volume shows the OpenStreetMap attribution.

The ODbL also reaches whoever uses a derived database in public. Public use of a volume or of a
produced work made from one obliges you to offer its recipients the derived database or the method
that made the database (ODbL §4.6). For a server that shows places to players, that obligation may
cover the server's own dataset with its edits. Read the [OpenStreetMap copyright
page](https://www.openstreetmap.org/copyright) for the exact terms.

Each photo from Commons carries its own license. Some of those licenses are share-alike, and some
ask for the author's name. The credit on the photo says which. A brand logo comes with its file's
copyright license and no trademark clearance. The NPS API and RIDB come with their own terms of
service for the keys you use. The Wikimedia, KartaView and Geofabrik sites state their terms too. [`sources.md`](doc/spec/sources.md) §7 sets out each obligation in more detail.

### What a volume carries for attribution

Cartographer writes the attribution that these licenses ask for into every volume:

- `dict.sources` names each source with its attribution line, its license and a license link;
- `manifest.licenses` repeats the source terms at the top of the signed manifest;
- each description carries `descriptionCredit`, the credit of the text's own source;
- each photo carries a `credit` with its license, plus its `author` and its `sourceUrl`;
- `manifest.inputs` names the exact extract and dumps the build read, by hash.

`publish` refuses a volume that holds data from a source with no declared terms. A Beacon server
keeps each source's attribution line and serves the credits with the places it imports.

A volume doesn't state the license under which you offer the volume as a whole. Say so where you
publish the volume, for example on the download page or in a notice beside the bucket. Name the
ODbL, credit OpenStreetMap contributors and link the source terms in `sources.md` §7.
