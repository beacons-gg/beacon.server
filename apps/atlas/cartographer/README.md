# Cartographer: Atlas's builder

Atlas is a dataset of places with descriptions and photos. Atlas is built **offline** from many
sources and published per region as signed static tiles. Beacon servers import from those tiles.
Cartographer builds the dataset. This README is the reference for the stages and the command line,
the build database and what to do when a run goes wrong. The [Atlas README](../README.md) is the
runbook for a whole build, from the images and the signing key to publishing and importing.

The specs are in [`apps/atlas/doc/spec/`](../doc/spec/README.md).
[`cartographer.md`](../doc/spec/cartographer.md) describes the builder, and
[`volume-format.md`](../doc/spec/volume-format.md) describes what a volume guarantees.

## Why Cartographer exists

A Beacon server could fetch descriptions and photos from Wikipedia and Wikimedia while it imports
places. A server is the wrong place for a third-party call. An import runs against a clock, and the
upstream throttles image bytes per IP address. A deferred fetch then gets recorded as "this place
has no photo". A server is also the wrong place for entity resolution. Resolution has to happen once
and centrally over all the sources at the same time.

So the work happens offline in a pipeline. The pipeline can take hours, retry and run again.

## Stages

Each stage is a subcommand that you can **run again on its own**. A later stage never needs an
earlier stage to run again. That is why the command line has a subcommand per stage.

| Stage | Command       | What it does                                                                                                                                        |
| ----- | ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0     | `inputs`      | Records the exact bytes the build was made from. The stage adopts what each acquisition step consumed and hashes what Cartographer reads itself.    |
| 1     | `normalize`   | Turns every source into rows in one staging table (`source_records`), classified through the shared taxonomy.                                       |
| 2a    | `concordance` | Asks Wikidata what it knows about the QIDs in staging and stores the answers in a local table.                                                      |
| 2b    | `wikipedia`   | Resolves the articles staging names and stages what they say as a source of its own.                                                                |
| 2b    | `nps`         | Matches staged places to US National Park Service units through each QID's Park Alpha Code.                                                         |
| 2b    | `ridb`        | Matches staged places to Recreation.gov facilities through a `website=` tag or a P6747 claim.                                                       |
| 2b    | `commons-geo` | Joins the Commons `geo_tags` dump against staged polygons by containment and lists the categories mappers tagged.                                   |
| 2b    | `kartaview`   | Sweeps KartaView's street catalog for the region and stages frames _aimed_ at a place.                                                              |
| 2b    | `contrib`     | Stages approved player contributions that a Beacon operator exported. The stage **reads a file**.                                                   |
| 2c    | `resolve`     | Decides which records are the same place and gives each place an Atlas id that never moves.                                                         |
|       | `review`      | Serves the review console in a browser. The console shows the merge gate's refusals and every published photo.                                      |
| 3     | `merge`       | Takes the winner for each field of each place by source priority. A description keeps its credit.                                                   |
| 4     | `media`       | Crawls the media. The stage resolves every photo reference and fetches the bytes, then re-encodes and addresses them by content.                    |
| 5     | `publish`     | Writes the volume. A volume holds a dictionary and one tile per geohash-5 cell. A volume also holds geometry files, an index and a signed manifest. |
|       | `prune`       | Deletes photo bytes that nothing can publish again. **The stage deletes data, so start with `--dry-run`.**                                          |
| 6     | `verify`      | Reads the published tree back as an outside reader would and checks it. The check includes that no place id was lost since the previous version.    |

Stages `concordance`, `wikipedia`, `nps`, `ridb`, `commons-geo`, `kartaview` and `media` **use the
network**. Cartographer never calls a Beacon server.

The numbering follows [`cartographer.md`](../doc/spec/cartographer.md) §1. Wikidata belongs to stage
2 and not stage 1, because Wikidata contributes a _concordance_ and not a place record. `wikipedia`
and `nps` sit inside stage 2 for another reason. They _are_ staging sources, and each needs the
concordance to know which article or unit a place is about. `wikipedia` reads the `enwiki`
sitelinks, and `nps` reads the Park Alpha Code claims. Their records must exist before `resolve`
forms entities. Both are **derived** sources. A derived source writes one record per enriched place.
The record names its parent and asserts no ids.

`contrib` is the one source that is **primary** and not derived. `contrib` is also the one source
that reads a file instead of an API:

1. An operator exports their approved player submissions with `places.contrib.export`, which writes
   a `beacon-contrib/1` file.
2. The operator hands the file over.
3. You record the file with `inputs --input contrib=<path>`, so the manifest names the bytes.

An _improvement_ joins the place it improves by naming one of the place's records. The improvement
asserts no ids. A record that restated its parent's ids would make the dataset count its own
republished output as an independent source that agrees with itself. A _new place_ asserts
`contrib:<host>/<unique>`. The server that the contribution came from uses that id to recognize the
place when the place comes home, instead of adding a duplicate.

### What each network stage calls

| Stage         | What it calls                                                                                                   |
| ------------- | --------------------------------------------------------------------------------------------------------------- |
| `concordance` | Wikidata                                                                                                        |
| `wikipedia`   | the article extracts on en.wikipedia.org                                                                        |
| `nps`         | the NPS API, whose whole corpus of about 474 units comes in one request with a key (`CARTOGRAPHER_NPS_API_KEY`) |
| `ridb`        | Recreation.gov, for federally published text and photos (`CARTOGRAPHER_RIDB_API_KEY`)                           |
| `commons-geo` | Commons, only to resolve the matched page ids and the tagged category listings                                  |
| `kartaview`   | an anonymous API that `--sweep` copies once into a local catalog                                                |
| `media`       | Commons for metadata, and `upload.wikimedia.org`, `www.nps.gov` or the KartaView storage hosts for bytes        |

The discovery in `commons-geo` is a local PostGIS join over the `geo_tags` dump. That join is the
reason to load the dump. The aim gate in `kartaview` is a local join too. `media` keeps a client per
host, because each host's budget is separate. Every other stage is local and deterministic.

`wikipedia` draws its candidates from staging and not from every imported row. That choice cuts the
candidates and the request count by an order of magnitude.

A concordance built before the `nps` stage ran lacks the Park Alpha Code claims. Run
`cartographer concordance --refresh` once so the claims land. `nps` reports the miss and doesn't
spend the requests itself.

`media` counts `--limit` in **files attempted** and not in files fetched. A budget spent only on
successes stops nothing when files are failing. A file that Wikimedia never answered for stays
_scheduled_ and is never recorded as "no photo". `media --retry` picks those files up.

`concordance` and `resolve` are separate stages. The first is a network job of a few minutes. The
second is a local pass you run many times while you tune the merge gate's thresholds. Deriving
identity again must never mean asking Wikidata again about tens of thousands of entities.

### The review console

`review` isn't a pipeline stage. The command serves the console from
[`cartographer.md`](../doc/spec/cartographer.md) §5 until you press Ctrl+C. The console has two
halves. The Decisions tab lists the identity verdicts already recorded.

**Identity** (the Queue tab) lists every identifier the merge gate refused (`ambiguous_ids`). Each
entry shows the asserting records' fields and their pins on a map:

- "Not this id" writes a `distinct` verdict, which cuts one record's claim.
- Checking records and confirming "same place" writes `same` verdicts, which outrank the gate.

The verdicts land in `decisions` under the `--reviewer` name and apply at the **next `resolve`**. A
refusal needs no verdict to stay split, because an undecided refusal is already the safe outcome
([`place-identity.md`](../doc/spec/place-identity.md) §3). So the queue can hold hundreds of entries
without blocking a volume.

**Imagery** (the Media tab) is a contact sheet of every published photo, with the newest crawl
first. You can filter by source, and the console serves the photos from the blob tree under `--out`.
The default action is **Approve these**, which marks the whole page reviewed in one click. So a full
pass over tens of thousands of photos means clicking only the bad ones. A photo you open takes one
of three verdicts:

- **reject**: the photo publishes nowhere. Use this verdict for an image that isn't allowed. One
  verdict removes the photo from every place that shares the photo.
- **not this place**: the photo is fine and doesn't show this place.
- **remove place**: the place shouldn't ship at all.

The verdicts land in `media_decisions` and `place_decisions` and apply at the **next `publish`**.
Nothing has to merge or crawl again. Withdrawing a verdict restores the photo without fetching a
byte.

Both halves have **their own tables on purpose.** `media_files.state` already has a `rejected`
value. `writeMediaFiles` upserts `state`, so a `media --refresh` overwrites the value.
`writePlaceMedia` deletes and inserts the rows of each entity every time. So a verdict written into
either table would be undone by a later crawl without notice. The derived tables are recomputed from
the sources, and a verdict is the one input no run can derive again. That is also why `decisions`,
`media_decisions` and `place_decisions` are the tables to back up.

A removed place goes in the manifest's **`retired`** list. With that list `verify --previous` can
tell "a curator removed this" from "a place vanished". The check reads the published tree and can't
ask the database. Without the list, the first publish after a removal would fail the same gate that
protects operators downstream. `publish` also reports what review withheld, so a volume smaller than
the database never differs without notice.

> **Note:** a Beacon server retires a vanished place through its sweep over the cells it imported.
> The sweep misses a removed place that was the **only** place in its geohash-5 cell. The volume
> then writes no tile for the cell, and the cell drops out of the index. Nothing sweeps the cell,
> and the place stays live on servers that already hold it. The manifest's `retired` list carries
> what would close this gap. The server doesn't read the list yet
> ([`beacon-integration.md`](../doc/spec/beacon-integration.md) §8).

## Run a build

The [Atlas README](../README.md#run-the-build) gives the order of a build and the commands.
Cartographer needs the `osm2pgsql` import from [`../osm-import/`](../osm-import/README.md).
Cartographer reads `beacon_places` directly and keeps its own tables in the same database.

A bounded pass with `--limit` and `--dry-run` shows what a stage would do before a full run:

```bash
docker compose --profile cartograph run --rm -T cartographer normalize --limit 2000 --dry-run
docker compose --profile cartograph run --rm -T cartographer concordance --limit 200 --dry-run
docker compose --profile cartograph run --rm -T cartographer wikipedia --limit 200 --dry-run
docker compose --profile cartograph run --rm -T cartographer nps --dry-run
docker compose --profile cartograph run --rm -T cartographer resolve --dry-run
docker compose --profile cartograph run --rm -T cartographer merge --limit 500 --dry-run
docker compose --profile cartograph run --rm -T cartographer upload --dry-run
```

Some notes on the commands:

- **`kartaview --sweep --limit N`** bounds the sweep by sequences, and the next run resumes. Without
  `--sweep` the stage joins what it already holds.
- **`media --limit N`** counts files attempted, and **`media --retry`** picks up the files that were
  deferred.
- **A bounded `merge` leaves a database that can't publish.** Run `merge` without `--limit` before
  `publish`.
- **`upload`** sends the same file list that `pack` zips. The upload resumes, skips immutable files
  that are present and writes `latest.json` last.

`run` reuses an existing image. So **add `--build` after you change this app's source**, or you run
the previous build.

To run locally without Docker:

```bash
CARTOGRAPHER_DATABASE_URL=postgres://beacon:beacon@localhost:5433/beacon_osm \
  pnpm --filter @beaconsgg/cartographer start normalize --limit 2000 --dry-run
```

## Where things live

Each stage has a file. A stage whose rules are worth testing on their own has a rules file beside
it.

| File                                                                     | What it holds                                                                                              |
| ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| `main.ts`                                                                | The command line. `parseArgs` is pure and exported for tests.                                              |
| `store.ts`                                                               | **Every SQL statement**, from the DDL and the paged reads to the `unnest` writes and the shared fragments. |
| `report.ts`                                                              | Each stage's report at the end of a run, as lines for `main.ts` to print.                                  |
| `inputs.ts`                                                              | Stage 0: adopt what was acquired and hash what Cartographer opens itself.                                  |
| `normalize.ts` and `osm.ts`                                              | Stage 1: the loop, and the rules from an OSM row to a staged record.                                       |
| `concordance.ts`                                                         | Stage 2a: Wikidata.                                                                                        |
| `wikipedia.ts`, `nps.ts`, `ridb.ts`, `commons-geo.ts` and `kartaview.ts` | The derived sources, one file each.                                                                        |
| `upstream.ts`                                                            | The upstream id vocabulary, with namespaces such as `osm:` and `wd:`.                                      |
| `identity.ts` and `resolve.ts`                                           | Stage 2c: the ladder and its gates, and the pass that applies them.                                        |
| `fields.ts` and `merge.ts`                                               | Stage 3: the priority rules per field, and the pass that applies them.                                     |
| `media.ts`                                                               | Stage 4: the crawl, the re-encode and the content addressing.                                              |
| `volume.ts` and `publish.ts`                                             | Stage 5: the format as values, and the writer with `keygen`.                                               |
| `verify.ts`                                                              | Stage 6: the tree read back as an outside reader would.                                                    |
| `tree.ts`, `pack.ts` and `upload.ts`                                     | The volume as a file list, and the two commands that ship it.                                              |
| `review.ts` and `review-page.html`                                       | The console: a small HTTP server and one static page.                                                      |

The format itself **isn't** here. The format lives in `packages/server/atlas-volume`, which the
Beacon server's reader shares. Two implementations of a format that never changes must not declare
it twice.

## The build database

Cartographer owns this database, and the database is **disposable** because the volume is the
artifact. The DDL is idempotent (`CREATE TABLE IF NOT EXISTS` on every run) and isn't a migration
series. The database is the osm2pgsql database. Stage 1 reads `beacon_places` directly, and
`osm2pgsql --create` drops only the tables its Lua declares. So every table below survives a new
import.

| Group          | Tables                                                                             | Rebuild                                              |
| -------------- | ---------------------------------------------------------------------------------- | ---------------------------------------------------- |
| Input record   | `build_inputs`                                                                     | yes: run `inputs` again                              |
| Staging        | `source_records`                                                                   | yes: run `normalize` and the sources again           |
| Answer caches  | `wikidata_entities`, `wiki_articles`, `nps_units`, `ridb_facilities` and five more | yes, at a high cost: hours of paced network requests |
| **Identity**   | `entities`, `entity_upstream` and `entity_aliases`                                 | **no**                                               |
| **Verdicts**   | `decisions`, `media_decisions` and `place_decisions`                               | **no**                                               |
| Gate refusals  | `ambiguous_ids`                                                                    | yes: run `resolve` again                             |
| Output         | `merged_places`, `media_files` and `place_media`                                   | yes, and treat `media_files` as a cache              |
| Publish ledger | `publish_log`                                                                      | no: the revision numbers must keep rising            |

The other five answer caches are `commons_geo_tags`, `commons_geo_pages`, `commons_categories`,
`kartaview_sequences` and `kartaview_photos`. `media_files` holds the crawl's answers.

> **Warning:** back up the six tables in bold and `publish_log`. A place id is derived from nothing,
> and a reviewer's verdict is the one input no run can derive again. The [Atlas
> README](../README.md#back-up-what-cant-be-rebuilt) gives the backup command and what a lost id
> costs on the servers that imported a volume.

A `wiki_cache` table may still exist from an older job. Nothing reads the table.

### Pruning

`prune` isn't a stage. In a build, `prune` runs **after `review` and before `publish`**. A
reviewer's verdict withholds a photo at publish time and doesn't delete the photo. So the bytes sit
on disk until something sweeps them, and a sweep before the volume is written reclaims them.

That order is safe both ways:

- `prune` deletes only what a verdict withheld. The rule for what to keep is the same publishability
  rule `publish` applies, so the two can't disagree.
- `publish` never objects to a missing blob. `publish` demotes a file for a missing blob only when
  the file reached a tile, and a rejected photo never does.

`prune` compares the disk with the claims and doesn't query for what to delete. The database can't
name everything it no longer needs. `refusedRow` rebuilds a row _without_ its hashes. So a photo
that goes from `published` to `rejected` leaves bytes with nothing pointing at them.

A blob stays when **any** row still earns it, by the same publishability rule. A blob also stays
when **any published version on disk references it**. A version's manifest vouches for its photos by
hash. Pruning one of them would leave that version impossible to verify or ship.

On a **fresh build** no version is published yet, so the database's claim alone keeps a blob. The
report says so in words instead of printing a silent zero. After the first `publish` that version's
references add a second and stronger claim. From then on `prune` can't touch anything the version
shipped.

`prune` keeps photos with **no place link** unless you pass `--unlinked`. A page that a crawl hasn't
finished looks unlinked too: `media` commits file rows every 50 files and links them once per page
of 500 entities. So `--unlinked` states that no crawl is running, and only an operator can know
that. A wrong call loses nothing for good, and a free relink becomes a new download. On a fresh
build after a finished crawl the flag reclaims almost nothing, so leave the flag off there.

Withdrawing a verdict after a prune still restores the photo. The bytes are gone, so the restore
costs a new fetch. That trade is why `prune` is a command of its own and not part of `publish`.

## When something goes wrong

| Symptom                                                 | Cause and fix                                                                                                                            |
| ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| A `run` exits 0 at once with no output                  | `-T` is missing. `docker compose run` created the container and never started it.                                                        |
| A fix didn't take                                       | `run` reuses the existing image. Add `--build` after you change this app's source.                                                       |
| Type errors after a change to `@beaconsgg/atlas-volume` | `dist/` is stale. Run `pnpm --filter @beaconsgg/atlas-volume build`.                                                                     |
| The console exits 1 with an empty `AggregateError`      | The `osm-db` container is stopped. Run `docker compose up -d osm-db`.                                                                    |
| `review` serves and the browser can't reach it          | Plain `run` publishes no ports. Use `--service-ports`.                                                                                   |
| `failed to read dockerfile` on a host with no checkout  | The **pull** failed and compose fell back to a build. The registry error is a few lines up.                                              |
| `nps` matches almost nothing                            | The concordance predates the Park Alpha Code claims. Run `concordance --refresh` once.                                                   |
| `publish` refuses to run                                | A `merge` is incomplete or the key file is readable by others. A bounded `merge` leaves a database that can't publish.                   |
| `verify --previous` fails on ids removed on purpose     | Every deliberate removal must appear in the manifest's `retired` list. Check that `publish` ran on the database that holds the verdicts. |
| A photo count dropped after a new crawl                 | Check the withheld-by-review line in `publish`'s report first. A verdict applies at publish time.                                        |
| Places come back with new ids                           | The identity tables were lost, and the loss can't be undone. Stop, and restore the backup before you publish.                            |

Packages downstream of `@beaconsgg/atlas-volume` resolve the package from `dist` and not from
source. A `failed to read dockerfile` error follows a pull that failed because you weren't logged in
to your registry or the tag was wrong.

## Read this before the code

- **Stage 0 doesn't download.** You place an extract by hand. An extract runs to several GB, and
  `curl` already resumes. A build needs a _record_ of which bytes went in. Stage 0 skips the hash
  when the size **and** the modification time both match, because hashing a large extract takes
  minutes.
- **The taxonomy is imported and never restated.** `@beaconsgg/place-taxonomy` is the single source
  of truth, and the Beacon server reads the same package. A second copy would drift and take the
  curation rules with it, such as the rule against sensitive locations.
- **Staging applies no wire caps and no schema validation.** Staging holds what the source said, and
  the publisher is where a field meets a length limit. A clamp in staging would mean a volume could
  never carry a longer field without normalizing the whole extract again.
- **Most rows drop, and that shape is expected.** The Lua import filter works on keys, so the filter
  admits far more than the taxonomy classifies. The report says so in plain words. A scary number
  dressed as a warning trains an operator to skip the line that matters.
- **Upstream ids are never invented.** An id in `upstream_ids` means a source asserted that this
  record is that entity. Stage 2 treats a shared id as tier-1 evidence and _merges_ on it. A wrong
  merge is a parking lot with a lighthouse's description. `brand:wikidata` is excluded for this
  reason: the tag names the chain and not the place.
- **Two id forms, on purpose.** `source_id` keeps the `way/586464226` shape that a Beacon server's
  records use. `upstream_ids` uses the namespaced `osm:w/586464226`. Those ids share an array with
  the `wd:`, `nrhp:`, `gnis:` and `commons:` ids.
- **Media references are collected and not chosen.** Ranking is stage 4's job, so a later change to
  the ranking costs a new run of stage 4 alone.
- **Reads are paged, and writes are durable per page.** An interrupted run has already committed
  what it read, so the next run continues. Writes go through one `unnest` statement per page. A
  statement per row costs orders of magnitude more on a table this size.
- **The DDL is idempotent and isn't a migration series.** Cartographer owns this database, and the
  database is disposable because the volume is the artifact. The identity tables are the exception.
- **`entities`, `entity_upstream` and `entity_aliases` can't be regenerated.** Everything else in
  the database derives from the inputs, and a place id derives from nothing. Lose those tables and
  every place gets a new id. A place that servers key by its Atlas id then retires on every server
  that imported a volume. The place comes back as a new place without the operator's edits and the
  players' contributions. Back up those tables and `decisions` with them.
- **A shared identifier is evidence and not a merge.** The place identity spec
  ([`place-identity.md`](../doc/spec/place-identity.md) §3) gates tier 1 for this reason. Real data
  shares hundreds of identifiers between records that sit far apart. `wikidata=Q108485435` on dozens
  of surveillance cameras names _Flock Safety_, a surveillance company. The tag doesn't say that a
  camera is that company. So a merge key must pass two gates. The entity has coordinates, so the
  entity is a place at all. The records sit within 500 meters of each other. Every refusal lands in
  `ambiguous_ids` with its evidence. A refused id is still carried and isn't merged on. Nobody can
  inspect a silent gate, so the refusals stay visible.
- **`resolve` has no `--limit`, on purpose.** Identity is global. A component is right only when
  every record that shares an id is in view. So a bounded pass produces _wrong_ entities and mints
  ids for them. That mistake is the one you can't take back here, so the flag is an error.
- **A `decisions` row names one claim and not two places.** The row
  `('record:osm/node/12755225609', 'wd:Q108485435', 'distinct')` reads "this record doesn't assert
  that QID". That is the mistake in the data, and the verdict always takes effect. A veto on two
  _identifiers_ can't separate records that a third claim still links.
- **A QID with no concordance row isn't a QID with no links.** Those ids are unusable for the run,
  and the report lists them apart from the gate's refusals. "The concordance hasn't run" and "these
  places don't cross-reference" look the same in a single counter. The same confusion once cost a
  snapshot 97% of its images.
