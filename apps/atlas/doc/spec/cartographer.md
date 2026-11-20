# Cartographer

Cartographer is the Atlas builder. Cartographer turns OpenStreetMap and a set of other sources into
a signed volume that Beacon servers import. This spec covers the stages and the rules they hold to.
The stage commands and their flags are documented beside the code in
[`apps/atlas/cartographer`](../../cartographer/README.md). The artifact the build writes is the
[volume format](volume-format.md), and stage 2 follows [place identity](place-identity.md).

Checked against Beacon 0.3.

## 0. What kind of program this is

Cartographer is a batch build that an operator runs. Cartographer is not a service: the program has
no uptime, no request path and no users beyond the people building a dataset. A build may take days,
download large dumps and wait out every rate limit an upstream sets. An operator may stop it and
resume it. A game server can do none of those things, and that difference is the reason Atlas
exists.

Two properties hold for every stage.

**Every stage resumes.** A stage keeps its state durably as it produces it, page by page. A stage
interrupted at 90% keeps 90%. There is no resume file and no transaction that spans a stage.

**A give-up is never recorded as a fact.** When an upstream declines to answer, the row stays
unresolved for the next run. The row is never stamped as "nothing there". A throttled image fetch
recorded as "this place has no photo" makes a region that lost most of its photos look like a region
that never had any. Every network stage keeps three states apart:

| State             | Meaning                                                            |
| ----------------- | ------------------------------------------------------------------ |
| no row            | never asked, so the next run asks                                  |
| row with a value  | answered, and the value is the answer                              |
| row with no value | answered, and the upstream has nothing; the stage never asks again |

A batch the upstream never answered writes nothing, so its rows stay in the first state.

## 1. Stages

```text
osm-import ─▶ 0 inputs ─▶ 1 normalize ─▶ 2a concordance ─▶ 2b derived sources ─▶ 2c resolve
                                                                                      │
       6 verify ◀─ 5 publish ◀─ (review, prune) ◀─ 4 media ◀─ 3 merge ◀───────────────┘
```

| Stage | Command       | Reads                                          | Writes                                                                | Network                                                                      |
| ----- | ------------- | ---------------------------------------------- | --------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| 0     | `inputs`      | what each acquisition step recorded            | `build_inputs`: source, artifact and SHA-256                          | none                                                                         |
| 1     | `normalize`   | `beacon_places`, the OpenStreetMap import      | `source_records`: one classified row per source record                | none                                                                         |
| 2a    | `concordance` | the Wikidata ids staging asserts               | `wikidata_entities`: sitelinks, cross ids and logo claims             | Wikidata                                                                     |
| 2b    | `wikipedia`   | staging and the concordance's sitelinks        | `wiki_articles` and derived records                                   | English Wikipedia                                                            |
| 2b    | `nps`         | staging and Park Alpha Code claims             | `nps_units` and derived records                                       | NPS API                                                                      |
| 2b    | `ridb`        | staging, `website=` tags and P6747 claims      | `ridb_facilities` and derived records                                 | RIDB API                                                                     |
| 2b    | `commons-geo` | the Commons `geo_tags` dump and staged areas   | staged photo references                                               | Commons, matched pages                                                       |
| 2b    | `kartaview`   | a swept street-photo catalog and staged points | staged photo references                                               | KartaView                                                                    |
| 2b    | `contrib`     | a contribution file a Beacon operator exported | staged records                                                        | none                                                                         |
| 2c    | `resolve`     | all of `source_records`                        | `entities` and its member, upstream and alias tables; `ambiguous_ids` | none                                                                         |
| 3     | `merge`       | entities and their records                     | `merged_places`, the winning field per place                          | none                                                                         |
| 4     | `media`       | every photo reference                          | `media_files`, `place_media` and blobs under `media/`                 | Commons, NPS, RIDB, KartaView and the photo addresses in a contribution file |
| 5     | `publish`     | `merged_places` and blobs                      | the signed volume tree                                                | none                                                                         |
| 6     | `verify`      | the published tree only                        | nothing                                                               | none                                                                         |

Each stage reads the durable output of the stages before it and writes its own. Any stage can run
again alone, and running a later stage again never requires running an earlier one. Each stage is a
subcommand, so no single command means "redo everything".

Two operator steps sit between `media` and `publish`: `review` (§5) and `prune` (§3). `keygen`,
`pack` and `upload` are utilities and not stages (§3).

### 1.0 Stage 0: inputs

Stage 0 records the exact bytes every input was made of, and those records become the manifest's
`inputs` ([volume format](volume-format.md) §2). Stage 0 downloads nothing. Extracts are large and
`curl` already resumes, so what a build needs is a record of which bytes went in.

**Whoever reads a file records it.** The OpenStreetMap import is the only step that opens the
`.pbf`, so the import writes a small record of what it consumed and stage 0 adopts that record. An
artifact that Cartographer opens itself is named with `--input` and hashed by stage 0. Naming an
artifact that an acquisition step recorded compares the hashes and fails on a mismatch. A manifest
must not be built on a file other than the one the build consumed. An artifact recorded only through
`--input` is hashed again when its size or modification time changes.

### 1.1 Stage 1: normalize

**The OpenStreetMap import comes first.** `osm-import` is an `osm2pgsql` flex import that writes one
table from a regional extract: `beacon_places`. The Lua style keeps an object that has a `name` and
any key the taxonomy uses, plus a short list of exact tag pairs that may be nameless (surveillance
cameras). Nodes become points. Closed ways become polygons. Multipolygon and boundary relations
become multipolygons. The filter is coarse on purpose: the precise tag-to-category match happens in
stage 1, so a taxonomy change re-runs stage 1 and never the import. A CI test in
`@beaconsgg/place-taxonomy` pins the Lua key lists to the taxonomy.

Stage 1 turns every source record into a row of one staging table, `source_records`. Each row holds
the place's fields as the source states them, from name to polygon. A row also holds unresolved
photo references, the identifiers the record asserts and the raw payload. A source's own vocabulary
ends here: later stages never learn that OpenStreetMap has tags. An area's point is a point inside
the area (`ST_PointOnSurface`).

**The taxonomy is shared code.** Stage 1 classifies through `@beaconsgg/place-taxonomy`, the package
the Beacon server uses. The taxonomy's curation rule keeps sensitive locations out of the dataset:
schools, hospitals, places of worship and similar places. A second copy of the rule would drift, and
the rule is a safety property ([Beacon integration](beacon-integration.md) §7). The taxonomy also
derives a description and a website from tags. A nameless branded surveillance camera gets a name
from its brand tags, and a generic one stays nameless.

Stage 1 applies no length limits. Staging holds what the source said, and the writer in stage 5
applies the wire limits.

Stage 1 doesn't read Wikidata. Wikidata contributes no places: Atlas uses Wikidata for identity and
for photo claims, which stage 2a stores.

### 1.2 Stage 2: sources and identity

**Stage 2a (`concordance`)** asks Wikidata about every entity id staging asserts and keeps the
answers. The answers hold cross-identifiers and English Wikipedia sitelinks. The answers also hold
image claims (P18), logo claims (P154) and the join keys of the derived sources. The stage is
separate from `resolve` so that deriving identity again never means asking Wikidata again. The
concordance preflight is in [place identity](place-identity.md) §2.

**Stage 2b (the derived sources)** reads a staged record and stages what another corpus says about
it. Each one except a contributed new place is a derived record: the record names its parent in
`derived_from` and asserts no identifiers ([place identity](place-identity.md) §3). The sources and
their license rules are in [sources](sources.md).

- `wikipedia` reads the article a place's tag or sitelink names, and stages its introduction and
  lead image.
- `nps` fetches the Park Service's unit list in one request and joins units through the Park Alpha
  Code claim in the concordance. `nps` stages the Park Service's own description, page and photo.
- `ridb` joins federal recreation facilities through a `website=` tag that names a recreation.gov
  campground page, or through a P6747 claim.
- `commons-geo` loads the Commons `geo_tags` dump into the build database and stages the photos
  whose coordinates lie inside a staged area under 2 km².
- `kartaview` sweeps a street-photo catalog and stages frames aimed at a place.
- `contrib` stages a contribution file a Beacon operator exported. An improvement derives from the
  place it improves, and a new place asserts its `contrib:` id ([Beacon
  integration](beacon-integration.md) §9).

**Stage 2c (`resolve`)** builds the identity graph locally. The stage writes the places with their
members, upstream ids and aliases. The stage also writes the gate's refusals. `resolve` is local and
deterministic, so it runs again cheaply while the gate's results are examined. `resolve` writes
inside one transaction, so an interrupted run leaves the previous graph whole. `resolve` takes no
`--limit`. Identity is global: a component is correct only when every record that shares an
identifier is in view. A bounded pass would produce wrong places and mint ids for them, which is the
one mistake that can't be taken back.

### 1.3 Stage 3: merge

Stage 3 takes each place's fields from its records by per-field source priority
([sources](sources.md) §5). Two rules hold:

- **A credit travels with the field it credits.** `descriptionCredit` comes from the record that won
  `description`. A credit merged on its own rank would ship a Park Service text under Wikipedia's
  license.
- **Gap fill, never overwrite.** A lower-ranked source fills a field the winner left empty, and
  never replaces a filled one. A new source can only add detail.

A place without a category or a point is not published, and the stage counts it. A place's `sources`
lists only the sources that won a field, so no source carries an attribution obligation for a place
it didn't describe.

### 1.4 Stage 4: media

Stage 4 fetches the photos each place claims and checks each license. The stage then encodes the
bytes to the Beacon place media profile and stores them content-addressed. Stage 4 is the slow stage
and the reason the build is offline: a Beacon server that fetched these photos itself would meet
Wikimedia's per-address limits on image bytes during an import.

- **A file is keyed by the file.** One logo shared by 200 stores is one fetch. A Wikidata image
  claim and a mapper's tag that name the same Commons file collapse onto one row.
- **Photos are ranked per place** by the order in [sources](sources.md) §5, and a place publishes up
  to 4.
- **Nothing that needs a network call to reproduce is resolved.** Image claims come from the
  concordance's stored answers. A Wikidata id with no concordance answer is reported as not asked,
  and never as "no photo".
- **A throttled or timed-out fetch is written `retryable`** with a time to try again. Only an answer
  is terminal, such as a missing file or a missing license. An image that can't be decoded and a
  file over the size limit are terminal too.
- **The client honors `Retry-After` and waits.** Wikimedia limits image bytes per address, and
  asking more slowly doesn't help.
- **Metadata and bytes are paced separately.** The Commons API host and the image host have separate
  budgets, so Cartographer runs two clients. One shared gate would make the slower host bind on
  both.
- **A fetch is never larger than the original.** MediaWiki answers a request for a wide rendering of
  a small image with an enlarged thumbnail. The stage fetches the original when the original is
  narrower than the full size.
- **Every fetch attempt is persisted with a reason.** A reference to a host that states no license
  per file is never fetched, and the media report counts it.

**Lost bytes are repaired from `publish`.** A file marked published keeps its upstream answer, and
its bytes live on disk apart from the database. When the bytes go missing, `publish` notices,
because `publish` is the only stage that reads blobs and holds the database. `publish` puts the file
back on the retry ledger, and `media --retry` fetches exactly those files again. `--refresh` asks
again about every settled file and so repeats the whole crawl. `--retry` is the repair.

### 1.5 Stage 5: publish

Stage 5 writes the volume as [volume format](volume-format.md) defines it. The stage writes tiles by
representative point and geometry tiles. Then the stage writes the index with per-cell hashes, the
dictionary and the signed manifest. The stage streams one cell at a time, so memory holds one cell
and the small tables.

- **Publish refuses an incomplete merge**, and refuses a source with no declared terms before it
  claims a revision or writes a byte.
- **The write order makes a publish atomic for readers**: tiles, geometry, the index, the
  dictionary, the signed manifest and `latest.json` last.
- **Publish is where a field meets a wire limit.** The writer shortens a long description and drops
  an overlong URL or a polygon over the caps. The writer counts each one.
- **Publish applies the review verdicts at read time** (§5) and reports what review withheld, so a
  volume smaller than the database is never a silent difference. Removed places go into the
  manifest's `retired` list.
- **Signing uses the Beacon identity primitives**: Ed25519 over the JCS canonicalization, with a
  `did:key` identity. A Beacon server verifies a volume with code it already has.

### 1.6 Stage 6: verify

Stage 6 reads the published tree as a foreign reader would, in the verification order of [volume
format](volume-format.md) §8. The stage takes no database connection, so what it checks is what a
reader sees and not what the builder believes. The stage collects every failure before it reports,
and a failure sets a non-zero exit code so a build script stops.

Stage 6 checks:

- the signature, and every hash in the tree;
- that the format, the taxonomy and the cell precision match this build;
- that no place id appears in two tiles, no alias is also a live id and no retired id is also live;
- that each place's point lies inside the cell of its tile;
- that every dictionary index is in range and every polygon is within the wire caps;
- that a description credit never appears without its description;
- that `media` is never an empty array and its entries pair up;
- that every referenced media file exists and hashes to its name, and that the manifest's media
  count and size match the files.

**With `--previous <version>`, verify checks place-id continuity.** Every id in the previous version
must appear in this one as a live id, an alias or a `retired` entry. A place that vanished is a bug
in the build. A server's retirement would retire that place, and the operator's edits and the
players' contributions would go with it. Without `--previous` the check reports that it didn't run,
because "the check passed" and "the check didn't run" look alike in a build log.

## 2. Storage

Cartographer keeps its working state in a private PostGIS database, the same one the OpenStreetMap
import writes. The database is disposable: the volume is the artifact. The schema is created
idempotently on every run with no migration series, because nearly everything in it derives from the
inputs.

**Six tables derive from nothing, and losing them can't be undone:**

| Table             | Why                                                       |
| ----------------- | --------------------------------------------------------- |
| `entities`        | a place id derives from nothing                           |
| `entity_upstream` | the upstream ids each place has claimed                   |
| `entity_aliases`  | the losing ids of past merges, which must resolve forever |
| `decisions`       | identity verdicts a person made                           |
| `media_decisions` | photo verdicts a person made                              |
| `place_decisions` | place removals a person made                              |

Lose the first three and every place gets a new id. A new id retires the old place on every server
that imported a volume, and the operator's edits and the players' contributions go with it. Back
these tables up together with the signing key (§3). Also back up `publish_log`, which holds each
volume's revision counter: losing it starts revisions over. Everything else rebuilds from the
inputs.

## 3. Operation

The build runs on one machine, beside the database. Stages run one at a time, and each logs its
progress per page.

**The signing key exists before the first publish**, because there is no unsigned mode.
`cartographer keygen` writes a BIP39 recovery phrase to a file with mode `600`, and prints the
`did:key` an operator confirms when importing.

- `keygen` never overwrites. Run against an existing file, `keygen` prints that key's `did:key` and
  stops. Servers pin the key, so a new key strands every volume the old key signed.
- `publish` refuses a key file that grants any permission to the group or to others.
- The key can't be regenerated. Back the file up.

**`pack`** writes one version as a single zip: `latest.json`, the version directory and only the
media that version references. The zip is the volume tree verbatim, so `verify` passes on an
extracted copy and a Beacon server imports the zip through its upload route.

**`upload`** pushes the same file list to S3-compatible object storage:

- Version files and media are immutable, so `upload` skips any key already present. An interrupted
  upload resumes with nothing lost.
- `latest.json` goes last, always.
- Version files and media carry `Cache-Control: public, max-age=31536000, immutable`, and
  `latest.json` carries `public, max-age=60`.
- Reads must be public. A Beacon server sends no credentials, because the server verifies every byte
  against the signed manifest and the host is untrusted. The upload credentials only write and list.

Media is most of a volume's bytes, so the cost of hosting a volume is mostly egress.

**`prune`** deletes photo bytes nothing can publish again. A photo a reviewer rejected loses its
hashes in the database, so no query finds its bytes. `prune` compares the disk with the claims
instead. A blob is kept when the database still earns it by the same rule `publish` applies, or when
any published version on disk references it. Pruning a referenced blob would make that version
unverifiable. Photos with no place link are kept unless the operator passes `--unlinked`, because a
crawl in progress also leaves photos fetched and not yet linked. Run `prune` after `review` and
before `publish`.

## 4. Reproducibility

Given the same `inputs` and the same decision tables, a rebuild produces the same places with the
same ids. A volume can therefore be audited, a bug can be traced against a real dataset and a third
party can check that a volume matches the sources it names.

The rule this puts on the code: **no clock and no randomness feed a decision.** The identity rules
are pure functions with the id minter injected. The one non-deterministic call is `mintId()`, which
allocates a ULID for a place that never existed before. Timestamps go into the manifest and never
into matching. A component's internal order never depends on the order its claims arrived in, so a
rebuild's output is byte-identical.

## 5. The review console

Two decisions shouldn't be made by a machine alone: whether two records are one place when the
evidence is ambiguous, and whether a photo belongs on a place at all. `cartographer review` serves a
local web console for both, on port 3200 by default. The console runs until it is stopped, and
refuses to start without `--reviewer`: every verdict records who made it.

**A verdict gets a table of its own, and the stages read through it.** Everything else in the
database is derived and rewritten on the next run. A verdict written into a derived row would be
undone by the next run without anyone noticing.

| Table             | Written by    | Applied at         |
| ----------------- | ------------- | ------------------ |
| `decisions`       | the queue     | the next `resolve` |
| `media_decisions` | the photo tab | the next `publish` |
| `place_decisions` | the photo tab | the next `publish` |

Applying verdicts when the stages read means a verdict needs no new merge and no new crawl. A
withdrawn verdict restores the photo without fetching a byte.

**The queue** lists the merge gate's refusals ([place identity](place-identity.md) §3), with the
asserting records' fields and their pins on a map. "Not this id" writes a `distinct` verdict that
cuts one record's claim. "Same place" writes a `same` verdict that joins the records and outranks
the gate. A refusal needs no verdict to stay split: an undecided refusal is already the safe
outcome, so the queue can stay long without blocking a volume.

**The photo tab** is a contact sheet of every published photo with the newest first and a filter by
source. The default action approves the whole page, so a full pass means clicking only the bad
photos. One photo has three verdicts, which differ in scope:

| Verdict        | Scope                        | Use when                                            |
| -------------- | ---------------------------- | --------------------------------------------------- |
| Reject         | the file, on every place     | the image must not publish; a shared logo dies once |
| Not this place | the file, on this place only | the photo is fine and shows another place           |
| Remove place   | the place                    | the place must not ship                             |

A removed place is named in the next manifest's `retired` list. Every verdict can be withdrawn.
Contributed places and photos come through the same tab, filtered to the `contrib` source.

Review doesn't gate a volume: an unreviewed volume publishes. Review doesn't edit places either. A
correction belongs upstream in OpenStreetMap or in an operator's own edits on a Beacon server. Both
outrank Atlas.
