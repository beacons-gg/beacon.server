/**
 * Cartographer's database side: the two tables it owns, the paged read over an `osm2pgsql` import,
 * and the batched staging write.
 *
 * **Idempotent DDL, not a migration series.** Cartographer owns this database outright, it is private
 * and disposable — the published volume is the artifact, not the database — and there is no second
 * writer to coordinate a version with. `CREATE TABLE IF NOT EXISTS` before every run is the same
 * reasoning `apps/atlas/osm-enrich`'s `ensureCache` documents, for the same kind of table.
 *
 * The tables live in the **same** database as `beacon_places` (the osm2pgsql import), which is safe
 * for the reason `wiki_cache` is: `osm2pgsql --create` drops only the tables its Lua declares, so a
 * re-import leaves these standing. Stage 1 regenerates `source_records` from scratch anyway; what
 * genuinely matters to keep is `build_inputs`, which is a record of provenance rather than of data.
 */

import {
  ULID_RE,
  type MediaCredit,
  type PlaceCategory,
  type PlaceSubcategory,
} from "@beaconsgg/protocol-types";
import { isOsmSourceId } from "@beaconsgg/place-taxonomy";
import { mediaBareHash } from "@beaconsgg/atlas-volume";
import type { WikidataValue } from "@beaconsgg/wikimedia";
import type { MergedFields, MergeInput, SourceId } from "./fields";
import type { EntityRefs } from "./volume";

/** Structural slice of `pg.Pool` — injectable so tests need no database. */
export interface Querier {
  query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }>;
}

/**
 * Create Cartographer's own tables if they aren't there. Idempotent, and safe before every stage.
 *
 * Both indexes on `source_records` serve **stage 2** (identity): the GiST index for spatial candidate
 * matching, the GIN index for tier-1 matching on a shared upstream id. They are created now, with the
 * table, because adding an index to a populated multi-million-row table is slow and this costs nothing
 * while the table is empty.
 */
export async function ensureSchema(db: Querier): Promise<void> {
  await db.query(
    "CREATE TABLE IF NOT EXISTS build_inputs (" +
      "source text NOT NULL, artifact text NOT NULL, hash text NOT NULL, " +
      "bytes bigint NOT NULL, mtime_ms bigint NOT NULL, hashed_at timestamptz NOT NULL, " +
      "PRIMARY KEY (source, artifact))",
  );
  await db.query(
    "CREATE TABLE IF NOT EXISTS source_records (" +
      "source text NOT NULL, source_id text NOT NULL, " +
      "name text, alt_names text[], description text, description_credit jsonb, " +
      "website text, wikipedia text, " +
      "category text NOT NULL, subcategory text, " +
      "point geometry(Point, 4326) NOT NULL, geometry geometry(Geometry, 4326), " +
      "media_refs jsonb NOT NULL DEFAULT '[]'::jsonb, " +
      "upstream_ids text[] NOT NULL DEFAULT '{}', " +
      // `derived_from_(source|id)` belong here too and are declared by the ALTER below instead — the one
      // authority for them, for the reason stated there.
      "raw jsonb NOT NULL, normalized_at timestamptz NOT NULL, " +
      "PRIMARY KEY (source, source_id))",
  );
  // The derivation pair, declared **here and nowhere else** — including for a fresh database, which reaches
  // this statement one line after creating the table.
  //
  // It needs an ALTER at all because an operator's build database already exists: `CREATE TABLE IF NOT
  // EXISTS` is a no-op there, and dropping the table to pick up two columns is not an option next door to
  // `entities`, the one thing here that cannot be regenerated. Declaring them in both statements would have
  // been two authorities for one fact whose disagreement is invisible on *both* paths, because the two never
  // run the same statement.
  //
  // The CHECK is the invariant `StagedIdentity.derivedFrom` describes, enforced where a hand-written INSERT
  // also has to pass it: half a derivation names no record, and TypeScript can only drop it silently on the
  // read side — thousands of lines from the write, and with a minted place id as the consequence.
  // `DROP … IF EXISTS` before `ADD` makes the whole statement idempotent, which `ADD CONSTRAINT` alone is not.
  await db.query(
    "ALTER TABLE source_records " +
      "ADD COLUMN IF NOT EXISTS derived_from_source text, " +
      "ADD COLUMN IF NOT EXISTS derived_from_id text, " +
      "DROP CONSTRAINT IF EXISTS source_records_derived_from_both, " +
      "ADD CONSTRAINT source_records_derived_from_both " +
      "CHECK ((derived_from_source IS NULL) = (derived_from_id IS NULL))",
  );
  await db.query(
    "CREATE INDEX IF NOT EXISTS source_records_point_idx ON source_records USING gist (point)",
  );
  await db.query(
    "CREATE INDEX IF NOT EXISTS source_records_upstream_idx ON source_records USING gin (upstream_ids)",
  );
  // Partial, over the SAME pattern the ridb candidate query embeds — identical predicate is what
  // lets the planner prove the implication and BitmapOr this with the GIN index above, instead of
  // seq-scanning 226k rows per ridb run for ~109 matches (measured: 52k buffers → 161).
  await db.query(
    "CREATE INDEX IF NOT EXISTS source_records_ridb_website_idx ON source_records (source, source_id) " +
      `WHERE ${ridbWebsiteSql("website")}`,
  );

  // ── stage 2: the concordance ───────────────────────────────────────────────────────────────────
  // `absent` is a fact — Wikidata answered that there is no such entity — and is why a row exists at
  // all for a QID with no claims. A QID Wikidata never answered for has NO row, so the next run asks
  // again. Those two states looked identical once and cost a snapshot 97% of its images.
  await db.query(
    "CREATE TABLE IF NOT EXISTS wikidata_entities (" +
      "qid text PRIMARY KEY, claims jsonb, enwiki_title text, " +
      "absent boolean NOT NULL, fetched_at timestamptz NOT NULL)",
  );

  // ── the Wikipedia source: one row per article, whatever named it ────────────────────────────────
  //
  // Keyed by **article title**, not by place, so an article several places cite is fetched once. The
  // staged records those places get are a separate granularity entirely — one per place, never one per
  // article, because a single record carrying several `osm:` ids would fuse them (see `wikipedia.ts`).
  //
  // The same three states as `wikidata_entities` above, for the same reason and with the same `absent`
  // convention: a row with `absent = true` is Wikipedia answering that there is no such article, and a
  // title Wikipedia never answered for has NO row so the next run asks again.
  await db.query(
    "CREATE TABLE IF NOT EXISTS wiki_articles (" +
      "title text PRIMARY KEY, summary text, image_file text, " +
      "absent boolean NOT NULL, fetched_at timestamptz NOT NULL)",
  );

  // ── the NPS source: the park-unit corpus, whole ─────────────────────────────────────────────────
  //
  // **No `absent` column, unlike the two caches above, because there is no per-key question.** Those
  // answer "what did the API say about this title/QID" one key at a time, so a negative needs remembering
  // per key. This is a snapshot of an enumerable corpus (~474 units, one listing request): after a fetch,
  // a code with no row IS the answer. The media crawl also reads it per image URL — the cache doubles as
  // the crawl's metadata service, which is what `--retry` derives NPS credits from offline.
  await db.query(
    "CREATE TABLE IF NOT EXISTS nps_units (" +
      "unit_code text PRIMARY KEY, name text NOT NULL, description text, designation text, " +
      "states text, website text, images jsonb NOT NULL DEFAULT '[]'::jsonb, " +
      "fetched_at timestamptz NOT NULL)",
  );

  // ── the RIDB source: the candidate facilities, whole ────────────────────────────────────────────
  //
  // The nps_units shape (no `absent` — a snapshot, not a per-key ledger), scoped differently: the RIDB
  // corpus is 15k facilities but the join population is ~150, so every run re-fetches exactly the
  // facilities the candidates name and the batch replaces the table. The crawl reads per-image credits
  // from `images` offline, same as the NPS arm. `org`/`org_id` carry the managing agency — the federal
  // text/photo gate's key, and the description credit's author.
  await db.query(
    "CREATE TABLE IF NOT EXISTS ridb_facilities (" +
      "facility_id text PRIMARY KEY, name text NOT NULL, description text, type text, " +
      "org text, org_id text, website text, images jsonb NOT NULL DEFAULT '[]'::jsonb, " +
      "fetched_at timestamptz NOT NULL)",
  );

  // ── the Commons geo source: every geotagged file, and what the joins learned ────────────────────
  //
  // `commons_geo_tags` is a **loaded input**, not a cache: the `geo_tags` dump from
  // dumps.wikimedia.org, replaced whole by `commons-geo --dump`. One row per coordinate a Commons page
  // carries — `is_primary` true is the camera position, false an {{Object location}} — and only the
  // `earth` globe survives the load. No per-key states here; the table either holds a dump or is empty.
  //
  // The other two are three-state caches on the `wikidata_entities` convention (row+fact / row+absent /
  // no row = never answered, ask again). For `commons_geo_pages`, `absent` covers a page id the dump
  // knew but Commons no longer serves (deleted since the dump) AND a page that exists outside the File
  // namespace — galleries and category pages carry coordinates too, and the dump does not say which is
  // which. Both are terminal facts about the id.
  await db.query(
    "CREATE TABLE IF NOT EXISTS commons_geo_tags (" +
      "page_id bigint NOT NULL, is_primary boolean NOT NULL, " +
      "point geometry(Point, 4326) NOT NULL)",
  );
  await db.query(
    "CREATE INDEX IF NOT EXISTS commons_geo_tags_point_idx ON commons_geo_tags USING gist (point)",
  );
  await db.query(
    "CREATE TABLE IF NOT EXISTS commons_geo_pages (" +
      "page_id bigint PRIMARY KEY, title text, " +
      "absent boolean NOT NULL, fetched_at timestamptz NOT NULL)",
  );
  // Keyed by the canonical `Category:Name` form (`commonsCategoryTitle`), which is also how the stage
  // and the media crawl look entries up — one spelling, or the cache misses its own rows.
  await db.query(
    "CREATE TABLE IF NOT EXISTS commons_categories (" +
      "category text PRIMARY KEY, members jsonb NOT NULL DEFAULT '[]'::jsonb, " +
      "absent boolean NOT NULL, fetched_at timestamptz NOT NULL)",
  );

  // ── the KartaView source: the swept street-imagery catalog ──────────────────────────────────────
  //
  // Two tables because the sweep resumes at two granularities. `kartaview_sequences` is the listing
  // (one bbox-paged pass, cheap) plus the per-sequence `photos_fetched` marker that makes the slow
  // half — one paged photo listing per sequence against a ~3.5 s/request API — resumable without
  // re-asking for anything already held. `kartaview_photos` is what the join reads and what the crawl
  // uses as its metadata service; `url` is stored fully constructed (storage host + processed path)
  // because it is both the staged ref's value and the crawl's lookup key.
  await db.query(
    "CREATE TABLE IF NOT EXISTS kartaview_sequences (" +
      "sequence_id bigint PRIMARY KEY, storage text NOT NULL, photo_count integer NOT NULL, " +
      "photos_fetched boolean NOT NULL DEFAULT false, fetched_at timestamptz NOT NULL)",
  );
  await db.query(
    "CREATE TABLE IF NOT EXISTS kartaview_photos (" +
      "photo_id bigint PRIMARY KEY, sequence_id bigint NOT NULL, sequence_index integer, " +
      "point geometry(Point, 4326) NOT NULL, heading double precision, url text NOT NULL)",
  );
  // Expression index over geography, because the join's gate is metres (`ST_DWithin(…::geography, 35)`)
  // and a geometry index cannot serve a geography predicate.
  await db.query(
    "CREATE INDEX IF NOT EXISTS kartaview_photos_geog_idx ON kartaview_photos " +
      "USING gist ((point::geography))",
  );
  // The crawl's lookup key: `readKartaviewImageMeta` resolves file keys by URL per metadata batch,
  // and without this every batch is a sequential scan of a table headed for tens of millions of rows.
  await db.query("CREATE INDEX IF NOT EXISTS kartaview_photos_url_idx ON kartaview_photos (url)");

  // A contributed photo's stated grant, keyed by the URL the crawl fetches — the contribution
  // source's arm of the media cache. Filled by the staging pass from the export file rather than
  // from an API, because the grant is stated in the file; the table exists so `media --retry` can
  // re-gate a photo with the file long gone.
  await db.query(
    "CREATE TABLE IF NOT EXISTS contrib_media (" +
      "url text PRIMARY KEY, license text NOT NULL, license_url text, author text, " +
      "seen_at timestamptz NOT NULL)",
  );

  // ── stage 2: the entity graph ──────────────────────────────────────────────────────────────────
  // `entities` and the three tables around it are the **one part of this database that cannot be
  // regenerated**. Everything else is derived from the inputs; a place id is derived from nothing, and
  // losing it re-mints every place in every published volume — which retires the place on every server
  // that imported one, taking its operator's edits and its players' contributions with it.
  await db.query(
    "CREATE TABLE IF NOT EXISTS entities (id text PRIMARY KEY, created_at timestamptz NOT NULL)",
  );
  // Keyed by the record, not by (entity, record): a staged record belongs to exactly one entity, and
  // making that the primary key means a record moving between entities is an UPDATE rather than a
  // duplicate membership nobody notices.
  await db.query(
    "CREATE TABLE IF NOT EXISTS entity_members (" +
      "entity_id text NOT NULL REFERENCES entities(id), source text NOT NULL, source_id text NOT NULL, " +
      "PRIMARY KEY (source, source_id))",
  );
  await db.query(
    "CREATE INDEX IF NOT EXISTS entity_members_entity_idx ON entity_members (entity_id)",
  );
  // `merge_key` records whether this id was used to *establish* identity or merely carried. The
  // distinction is load-bearing across builds: continuity resolves on merge keys only, so a carried
  // id — a Commons category, or a QID that turned out to name a surveillance company rather than a
  // place — cannot silently glue two entities back together on the next build.
  await db.query(
    "CREATE TABLE IF NOT EXISTS entity_upstream (" +
      "entity_id text NOT NULL REFERENCES entities(id), upstream_id text NOT NULL, " +
      "merge_key boolean NOT NULL, PRIMARY KEY (entity_id, upstream_id))",
  );
  await db.query(
    "CREATE INDEX IF NOT EXISTS entity_upstream_id_idx ON entity_upstream (upstream_id)",
  );
  // Keyed by the alias, so an id can only ever resolve to one place. Flattened at write time
  // (`apps/atlas/doc/spec/place-identity.md` §5): if A merged into B and later B into C, both A and
  // B are listed on C, and a consumer resolves in one step rather than chasing a chain that a
  // mirror may only half-hold.
  await db.query(
    "CREATE TABLE IF NOT EXISTS entity_aliases (" +
      "alias_id text PRIMARY KEY, entity_id text NOT NULL REFERENCES entities(id))",
  );

  // A human's verdict, and the only input to identity that cannot be recomputed from the sources.
  // Both directions matter: `distinct` is what vetoes a merge an upstream statement got wrong, and a
  // rebuild that forgot the negatives would re-propose every pair a reviewer already rejected.
  //
  // `a` and `b` name **one claim**, not two places: the thing that asserted an identifier, and the
  // identifier. An asserter is either a staged record (`record:osm/way/586464226` — build it with
  // `recordNode` in `identity.ts`, never by hand) or a Wikidata entity (`wd:Q108485435`). So a `distinct`
  // verdict reads "this record does not really assert that QID", which is exactly the mistake in the data
  // — a mapper writing `wikidata=` where `operator:wikidata=` belonged — and is always effective.
  // Naming two *identifiers* instead cannot separate records that a third claim still links.
  //
  //   INSERT INTO decisions VALUES ('record:osm/node/12755225609', 'wd:Q108485435', 'distinct',
  //   NULL, 'alice', now());
  await db.query(
    "CREATE TABLE IF NOT EXISTS decisions (" +
      "a text NOT NULL, b text NOT NULL, verdict text NOT NULL, evidence jsonb, " +
      "decided_by text NOT NULL, decided_at timestamptz NOT NULL, PRIMARY KEY (a, b))",
  );
  // One verdict per UNORDERED pair, enforced where integrity lives. The key above models the ordered
  // spelling, but `identity.ts` reads the pair unordered (`pairKey`) — so without this, the flipped
  // orientation could hold a `same` and a `distinct` about one claim at once, and the `same` would win
  // silently (a forced claim bypasses the veto set). It guards the review console's upsert and the
  // hand-written INSERT above equally, which is why it is not app code in `writeDecision`.
  await db.query(
    "CREATE UNIQUE INDEX IF NOT EXISTS decisions_pair_idx " +
      "ON decisions (LEAST(a, b), GREATEST(a, b))",
  );

  // Why an identifier was NOT used as a merge key. A rejection has to be inspectable, or the gate
  // becomes a silent policy: "these 54 cameras are 54 places" reads identically to "nothing shared an
  // id" unless something says which identifier was refused and on what evidence.
  await db.query(
    "CREATE TABLE IF NOT EXISTS ambiguous_ids (" +
      "upstream_id text PRIMARY KEY, records int NOT NULL, span_m bigint, " +
      "reason text NOT NULL, seen_at timestamptz NOT NULL)",
  );

  // Stage 3's output: one row per place, the merged fields a volume publishes.
  //
  // A table rather than something `publish` computes, because `apps/atlas/doc/spec/cartographer.md`
  // §1 requires that re-running a later stage never re-run an earlier one — and because the merge
  // is the one place a human can look to ask "why does this place say that", which a value living
  // only inside a publish run cannot answer.
  //
  // `cell` is computed here and stored, so `index.json` is a `GROUP BY` at publish time rather than a
  // second pass over every point.
  await db.query(
    "CREATE TABLE IF NOT EXISTS merged_places (" +
      "entity_id text PRIMARY KEY REFERENCES entities(id), cell text NOT NULL, " +
      "fields jsonb NOT NULL, sources text[] NOT NULL, " +
      "point geometry(Point,4326) NOT NULL, geometry geometry(Geometry,4326), " +
      "merged_at timestamptz NOT NULL)",
  );
  // Publish reads cell-major — every place of one tile together, in a stable order.
  await db.query(
    "CREATE INDEX IF NOT EXISTS merged_places_cell_idx ON merged_places (cell, entity_id)",
  );

  // ── stage 4: the media crawl ───────────────────────────────────────────────────────────────────
  //
  // Keyed by the **file**, not by the place and not by the reference that named it. One brand logo shared
  // by 200 stores is one row, one fetch and one published file; a `wikidata` ref whose P18 names the same
  // Commons title as a mapper's `wikimedia_commons` tag collapses onto the same row rather than being
  // fetched twice and published twice into the same place's four slots.
  //
  // **Four states, and the fourth is why this table exists at all.** A missing row is "never
  // asked". `published` and `rejected` are answers. `retryable` is a *ledger*, not a claim: a 429
  // or a timeout records what happened and when to try again, and never becomes "this place has no
  // photo" — the failure that cost a snapshot 97% of its images
  // (`apps/atlas/doc/spec/cartographer.md` §1.4). `wikidata_entities` encodes three states in
  // `absent`; media needs the fourth because a byte fetch can fail in a way that is neither
  // knowledge nor permanent.
  await db.query(
    "CREATE TABLE IF NOT EXISTS media_files (" +
      // `commons:File:Foo.jpg` — the source id and its canonical key, so a second source's namespace
      // cannot collide with Commons' title space.
      "file_key text PRIMARY KEY, source text NOT NULL, " +
      "state text NOT NULL, reason text, " +
      // The published pair. Both or neither: a lone `full` breaks the positional thumb-then-full contract.
      "thumb_hash text, full_hash text, bytes int, " +
      "license text, license_url text, author text, source_url text, " +
      // The retry ledger. `attempts` counts tries, not failures, so it bounds a file that fails forever.
      "attempts int NOT NULL DEFAULT 0, next_attempt_at timestamptz, " +
      "fetched_at timestamptz NOT NULL)",
  );
  // The candidate read: retryable rows whose time has come, oldest first.
  await db.query(
    "CREATE INDEX IF NOT EXISTS media_files_retry_idx ON media_files (state, next_attempt_at)",
  );

  // Which files a place publishes, in rank order.
  //
  // **Not the same thing as keying `media_files` by place.** The file row stays shared; this is the ranked
  // join publish needs, written once by stage 4 so `fetchMergedPlaces`' cell-major paged read can pick it
  // up without walking `entity_members` → `source_records.media_refs` → `media_files` per place.
  //
  // `rank` is assigned from `(kind, claimedBy)` — the mapper's `wikimedia_commons=File:` and the
  // enrichment job's `wiki_image_file` are the same *kind* but different
  // `apps/atlas/doc/spec/sources.md` §5 tiers, so ranking on kind alone would silently collapse two
  // of them.
  await db.query(
    "CREATE TABLE IF NOT EXISTS place_media (" +
      "entity_id text NOT NULL REFERENCES entities(id), " +
      "file_key text NOT NULL REFERENCES media_files (file_key), " +
      "rank int NOT NULL, PRIMARY KEY (entity_id, file_key))",
  );

  // ── the curation verdicts: what a human decided may not publish ────────────────────────────────
  //
  // **Their own tables, and never an edit to the derived ones.** `media_files.state` looks like the
  // obvious home for "rejected" — it already has that value — but `writeMediaFiles` upserts `state`,
  // so the next `media --refresh` would overwrite a reviewer's verdict with the crawl's answer; and
  // `writePlaceMedia` delete-then-inserts per entity, so a hand-deleted link comes straight back.
  // Derived tables are recomputed from the sources; a verdict is the one input no run can re-derive.
  // Same reasoning, and the same shape, as `decisions` for identity.
  //
  // Read at **publish** time (see `MEDIA_PUBLISHABLE_SQL` / `PLACE_PUBLISHABLE_SQL`) rather than
  // applied to the derived rows, which is what makes a verdict take effect with no re-merge and no
  // re-crawl — and makes withdrawing one restore the photo without refetching a byte.
  //
  //   ok      — reviewed and fine. Its only job is to keep the queue finite: an exhaustive pass over
  //             54k photos has to be resumable, and "no row" is what "not looked at yet" means.
  //   reject  — this file publishes nowhere. `entity_id IS NULL`; one brand logo shared by 200 stores
  //             dies once rather than 200 times.
  //   unlink  — this file is fine but is not a photo OF this place. `entity_id` names the place, and
  //             the file keeps publishing everywhere else.
  await db.query(
    "CREATE TABLE IF NOT EXISTS media_decisions (" +
      "file_key text NOT NULL REFERENCES media_files (file_key), entity_id text, " +
      "verdict text NOT NULL, reason text, " +
      "decided_by text NOT NULL, decided_at timestamptz NOT NULL)",
  );
  // One verdict per (file, scope), enforced where integrity belongs: `entity_id` is nullable, and a
  // plain PRIMARY KEY over a nullable column would let the same global verdict be stored twice.
  await db.query(
    "CREATE UNIQUE INDEX IF NOT EXISTS media_decisions_scope_idx " +
      "ON media_decisions (file_key, COALESCE(entity_id, ''))",
  );
  // No plain `(file_key)` index: `media_decisions_scope_idx` leads with it, so it already serves every
  // lookup here (measured — the planner picks it for both the queue's anti-join and a point read). A
  // second one would be pure write amplification on bulk approve, which is this feature's *default*
  // action at ~28k rows a pass.
  //
  // The Media tab's own two reads, both measured on the live 27,689-photo build:
  //   `place_media (file_key)` — the queue's LATERAL and `placesForFile` key on it, and without it
  //   each seq-scans all 32k links: 143 ms per page load, 34,440 of its 36,153 buffers in that rescan.
  //   With it, 38 ms and 489 buffers.
  await db.query("CREATE INDEX IF NOT EXISTS place_media_file_idx ON place_media (file_key)");
  //   The queue's ordering, partial over exactly the rows it draws from. Without it Postgres sorts
  //   27k rows to disk (`external merge, 4480kB`) on every click; with both indexes the page read is
  //   143 ms → 1.5 ms.
  await db.query(
    "CREATE INDEX IF NOT EXISTS media_files_review_idx " +
      "ON media_files (fetched_at DESC, file_key DESC) " +
      "WHERE state = 'published' AND thumb_hash IS NOT NULL",
  );

  // A place a reviewer says must not ship at all. It stays in `entities` and keeps its id — an id is
  // never reused, and a suppression is withdrawable — it simply stops reaching a tile.
  //
  // Publish names these ids in the manifest's `retired` list, which is what lets `verify
  // --previous` tell a curator's removal from a place that silently vanished (it reads the
  // artifact, never this database). **A server does not consume that list yet**: today it retires a
  // vanished place through its scope-aware sweep over the cells it imported, which is correct
  // unless the removed place was the only one in its p5 cell — then no tile is written, the cell
  // leaves the index, and nothing sweeps it. The manifest carries what closes that hole; wiring the
  // connector to it is the follow-up (`apps/atlas/doc/spec/beacon-integration.md` §3).
  //
  // `verdict` carries one value today (`remove`) where `media_decisions` genuinely has three. It is a
  // column rather than "a row means removed" so the two curation tables read the same way and so the
  // predicates say what they mean — the cost is that every read filters it, which is deliberate.
  await db.query(
    "CREATE TABLE IF NOT EXISTS place_decisions (" +
      "entity_id text PRIMARY KEY REFERENCES entities(id), verdict text NOT NULL, reason text, " +
      "decided_by text NOT NULL, decided_at timestamptz NOT NULL)",
  );
  await db.query(
    "CREATE INDEX IF NOT EXISTS place_media_entity_idx ON place_media (entity_id, rank)",
  );

  // What was published, when, and what its signed root was. `revision` is the manifest's monotonic
  // counter (`apps/atlas/doc/spec/volume-format.md` §2), and a serial is the only way to get one
  // that survives a version being republished under a new name.
  //
  // Not irreplaceable state: losing it restarts the numbering, which is cosmetic. It is here because a
  // publisher that cannot say what it published cannot answer "which volume did that operator import".
  //
  // **Unique on `(volume, version)`**, which is what makes re-publishing a version reproducible
  // rather than merely repeatable: `revision` goes inside the signed manifest and inside every
  // tile, so if a second publish of `us-west@2026-08` claimed a new number it would emit different
  // bytes for the same version — and `apps/atlas/doc/spec/volume-format.md` §10 says a version's
  // bytes never change. The revision belongs to the version, not to the attempt.
  await db.query(
    "CREATE TABLE IF NOT EXISTS publish_log (" +
      "revision bigserial PRIMARY KEY, volume text NOT NULL, version text NOT NULL, " +
      "manifest_hash text, places int, cells int, " +
      // Nullable, and that is the point: a row exists from the moment a revision is claimed, so
      // `published_at IS NULL` is "claimed, then the publish did not finish". Filling it with a sentinel
      // made the ledger unable to answer the one question it exists for.
      "published_at timestamptz, UNIQUE (volume, version))",
  );
}

/**
 * Run a unit of work on **one** connection inside `BEGIN`/`COMMIT`.
 *
 * Stage 2 needs this and stages 0–1 do not, for a reason worth stating: identity is the one thing here
 * that is not derivable from the inputs. A run interrupted midway through rewriting the entity graph
 * must leave the *previous* graph, not half of each — a state where a merge key belongs to no entity
 * reads to the next run as "this place is new", and it would mint a fresh id for a place every
 * downstream server is already holding.
 *
 * `Querier` is deliberately not extended with this: `Pool.query` may hand each call a different
 * connection, so a `BEGIN` issued through the plain seam would be a transaction the inserts never join.
 */
export interface Transactor {
  transaction<T>(fn: (db: Querier) => Promise<T>): Promise<T>;
}

/** Structural slice of `pg.Pool` — enough to check out a connection, without importing `pg` here. */
export interface Poolish {
  connect(): Promise<Querier & { release(): void }>;
}

export function transactor(pool: Poolish): Transactor {
  return {
    async transaction<T>(fn: (db: Querier) => Promise<T>): Promise<T> {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const out = await fn(client);
        await client.query("COMMIT");
        return out;
      } catch (error: unknown) {
        // Best-effort: if the connection is already broken the ROLLBACK fails too, and the original
        // error is the one worth reporting — Postgres discards an uncommitted transaction anyway.
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },
  };
}

/** One hashed build input, as `build_inputs` holds it. */
export interface InputRecord {
  source: string;
  artifact: string;
  hash: string;
  bytes: number;
  mtimeMs: number;
}

/**
 * The already-recorded input for this artifact, if any — what lets stage 0 skip re-hashing a file it
 * has already seen unchanged. Hashing 12 GB takes minutes, so the cheap check earns its keep.
 */
export async function readInput(
  db: Querier,
  source: string,
  artifact: string,
): Promise<InputRecord | undefined> {
  const { rows } = await db.query(
    "SELECT source, artifact, hash, bytes::text AS bytes, mtime_ms::text AS mtime_ms " +
      "FROM build_inputs WHERE source = $1 AND artifact = $2",
    [source, artifact],
  );
  const row = (rows as InputRow[])[0];
  return row
    ? {
        source: row.source,
        artifact: row.artifact,
        hash: row.hash,
        bytes: Number(row.bytes),
        mtimeMs: Number(row.mtime_ms),
      }
    : undefined;
}

/** Record a hashed input, replacing whatever was there for this (source, artifact). */
export async function writeInput(db: Querier, input: InputRecord, now: string): Promise<void> {
  await db.query(
    "INSERT INTO build_inputs (source, artifact, hash, bytes, mtime_ms, hashed_at) " +
      "VALUES ($1, $2, $3, $4, $5, $6::timestamptz) " +
      "ON CONFLICT (source, artifact) DO UPDATE SET hash = EXCLUDED.hash, " +
      "bytes = EXCLUDED.bytes, mtime_ms = EXCLUDED.mtime_ms, hashed_at = EXCLUDED.hashed_at",
    [input.source, input.artifact, input.hash, input.bytes, input.mtimeMs, now],
  );
}

/** Where the last page ended — the keyset cursor the next page resumes from. */
export interface RowCursor {
  osmType: string;
  osmId: string;
}

/**
 * One `beacon_places` row as {@link fetchOsmRows} returns it. Deliberately the same shape the server's
 * `Osm2pgsqlRow` has, minus the wire-only concerns: both read the table `apps/atlas/osm-import/beacon-places.lua`
 * declares, and a divergence here would be a divergence about what the import contains.
 */
export interface OsmRow {
  osm_type: "N" | "W" | "R";
  osm_id: string;
  /** `null` for the nameless-allowed entries (surveillance gear). */
  name: string | null;
  tags: Record<string, string>;
  /** GeoJSON text — kept as text so stage 1 can hand it straight back to PostGIS unparsed. */
  point: string;
  /** Area geometry as GeoJSON text; `null` for node rows. */
  geom: string | null;
}

/**
 * One page of the import, in keyset order.
 *
 * **Every** row is returned, not just the classifiable ones — the tag filter is stage 1's job, in
 * TypeScript, through the shared taxonomy. Pushing it into SQL would mean rendering the tag map into
 * a WHERE clause (as the server's connector does for a bbox-scoped chunk), and here that buys nothing:
 * a full-extract pass reads the whole table either way, and a second rendering of the taxonomy is a
 * second thing that can disagree with it.
 *
 * `ST_PointOnSurface` gives a representative point inside the geometry for ways and relations, which
 * for a node is just the node. Geometry is emitted as GeoJSON text at 7 decimal places (~1 cm) and
 * handed back to PostGIS verbatim on write, so nothing here re-implements coordinate handling.
 */
export async function fetchOsmRows(
  db: Querier,
  opts: { limit: number; after?: RowCursor },
): Promise<OsmRow[]> {
  const params: unknown[] = [];
  const next = (value: unknown): string => {
    params.push(value);
    return `$${params.length}`;
  };
  const pageGate = opts.after
    ? `WHERE (osm_type, beacon_places.osm_id) > (${next(opts.after.osmType)}, ${next(opts.after.osmId)}::bigint) `
    : "";
  const { rows } = await db.query(
    "SELECT osm_type, osm_id::text AS osm_id, name, tags, " +
      "ST_AsGeoJSON(ST_PointOnSurface(geom), 7) AS point, " +
      "CASE WHEN osm_type = 'N' THEN NULL ELSE ST_AsGeoJSON(geom, 7) END AS geom " +
      "FROM beacon_places " +
      pageGate +
      // Qualified: the `osm_id::text` alias shadows the bigint column, and an unqualified ORDER BY
      // would sort the window lexicographically — which breaks the cursor, not just the order.
      `ORDER BY osm_type, beacon_places.osm_id LIMIT ${next(opts.limit)}`,
    params,
  );
  return rows as OsmRow[];
}

/**
 * An unresolved reference to a photo, for **stage 4** to fetch.
 *
 * Unresolved on purpose: resolution costs a paced network call per file, and stage 1 is a local pass
 * over millions of rows. Recording *what a source claimed* and fetching later is also what makes the
 * media crawl independently re-runnable — the lesson from a snapshot that resolved images inline and
 * recorded a throttled fetch as "this place has no photo".
 *
 * Declared here, with the `media_refs` column, rather than in `osm.ts`: it is a shape of the staging
 * table that every future source shares, not an OSM one.
 */
export interface MediaRef {
  /**
   * How to interpret `value`:
   * - `url` — a direct image URL (`image=`)
   * - `commons-file` — a Commons `File:…` title
   * - `commons-category` — a Commons `Category:…`, i.e. a *set* of photos of this place
   * - `wikidata` — a QID whose P18 claim may name a file
   * - `brand-wikidata` — a chain's QID, resolved through its **logo** claim (P154), never P18: a
   *   brand's P18 is typically the company headquarters, the wrong image for a local branch
   */
  kind: "url" | "commons-file" | "commons-category" | "wikidata" | "brand-wikidata";
  value: string;
  /** Which source asserted it — `osm` for a mapper's tag, `wikipedia` for the enrichment job's find. */
  claimedBy: string;
}

/**
 * Which staged record — the `(source, source_id)` primary key, named once.
 *
 * It was written out inline five times before this existed, and `recordNode(source, sourceId)` took the two
 * halves **positionally**, so a derivation naming its parent and itself made two adjacent calls where
 * transposing the arguments compiles clean and joins the wrong pair. That is an identity error no test can
 * name, which is the reason this is a type rather than a convention.
 */
export interface RecordRef {
  source: string;
  sourceId: string;
}

/** Just the reference out of anything that has one — the projection two keyset cursors also want. */
export function recordRef(record: RecordRef): RecordRef {
  return { source: record.source, sourceId: record.sourceId };
}

/**
 * Source text as one line — the staging convention for `description`. Every stager applies it for the
 * same reason: upstream prose arrives with paragraph breaks and space runs, and a place description is
 * one blurb a card renders on one line. Not capped here — staging holds what the source said, and
 * `volume.ts` owns the wire limit.
 */
export function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * One row of `source_records` as {@link writeStaged} takes it — the staging shape, declared **once**
 * and narrowed to `osm.ts`'s `StagedRecord` by omitting `source`.
 *
 * Types come from `@beaconsgg/protocol-types` rather than being widened to `string`: `entryForTags`
 * already returns a `PlaceCategory`, so accepting a bare string here would let a typo'd category in a
 * future source's mapping compile clean and fail at the publisher, hours down the pipeline.
 */
export interface StagedRow {
  source: string;
  sourceId: string;
  name?: string;
  altNames?: string[];
  description?: string;
  descriptionCredit?: MediaCredit;
  website?: string;
  wikipedia?: string;
  category: PlaceCategory;
  /**
   * Optional, matching the nullable column and the way `fetchEntityRecords` already reads it back. It was
   * required only because OSM's `subcategoryOf` always yields one — which stopped being the whole story with
   * the second source, since an article has no subcategory of its own.
   */
  subcategory?: PlaceSubcategory;
  /** GeoJSON text, as PostGIS emitted it. */
  point: string;
  geometry?: string;
  mediaRefs: MediaRef[];
  upstreamIds: string[];
  /**
   * The record this one was built out of, when it was not read from a source of its own.
   *
   * Stage 2 joins a derived record to its parent's entity through **this**, not through ids — see
   * {@link StagedIdentity.derivedFrom}, which is where the reasoning lives.
   */
  derivedFrom?: RecordRef;
  raw: Record<string, string>;
}

/**
 * Upsert a page of staged records — **one statement per page**, the whole page as one `jsonb`
 * parameter expanded by `jsonb_to_recordset`.
 *
 * Per-row `INSERT`s were `osm-enrich`'s dominant cost by orders of magnitude, and this table is larger
 * than the one it writes. `ST_GeomFromGeoJSON` runs SQL-side on the text PostGIS just handed us, so a
 * round-trip through a JS geometry representation never happens.
 *
 * **Why `jsonb`, not 15 parallel `unnest` arrays.** The array form needs a `records.map()` per column
 * plus a per-column null convention, and two of the columns are `text[]` — which `unnest` cannot carry,
 * because it flattens *every* dimension of a multidimensional array and node-postgres cannot serialize
 * ragged rows into one anyway. Both problems vanish here: `jsonb_to_recordset` converts a JSON array
 * to `text[]` natively, an absent key becomes NULL (exactly what the `...(x ? {k:x} : {})` idiom
 * produces), and the parameter list is two entries instead of sixteen positionally-coupled ones.
 * Measured over 24,000 rows in 2,000-row pages it is also slightly *faster* than the array form.
 *
 * The field names are quoted so they keep their camelCase and the JS side is a plain `JSON.stringify`
 * of the records — no per-column transformation at all. `derivedFrom` is the one field the SQL takes apart,
 * because it is a `RecordRef` on this side and two constrained columns on the other; the alternative was
 * flattening it into `derivedFromSource`/`derivedFromId` on `StagedRow` and re-nesting it on the read, which
 * trades a nested jsonb read for a per-row JS transformation and splits a pair the type exists to keep
 * together.
 *
 * Upsert rather than insert so a re-run is idempotent: stage 1 is re-runnable by design, and a second
 * pass over an unchanged import must produce the same table, not a conflict and not duplicates.
 */
export async function writeStaged(
  db: Querier,
  records: readonly StagedRow[],
  now: string,
): Promise<void> {
  if (records.length === 0) return;
  await db.query(
    "INSERT INTO source_records (source, source_id, name, alt_names, description, " +
      "description_credit, website, wikipedia, category, subcategory, point, geometry, " +
      "media_refs, upstream_ids, derived_from_source, derived_from_id, raw, normalized_at) " +
      'SELECT r.source, r."sourceId", r.name, r."altNames", r.description, r."descriptionCredit", ' +
      "r.website, r.wikipedia, r.category, r.subcategory, " +
      "ST_SetSRID(ST_GeomFromGeoJSON(r.point), 4326), " +
      "CASE WHEN r.geometry IS NULL THEN NULL " +
      "ELSE ST_SetSRID(ST_GeomFromGeoJSON(r.geometry), 4326) END, " +
      `r."mediaRefs", r."upstreamIds", r."derivedFrom"->>'source', ` +
      `r."derivedFrom"->>'sourceId', r.raw, $2::timestamptz ` +
      "FROM jsonb_to_recordset($1::jsonb) AS r(" +
      'source text, "sourceId" text, name text, "altNames" text[], description text, ' +
      '"descriptionCredit" jsonb, website text, wikipedia text, category text, subcategory text, ' +
      'point text, geometry text, "mediaRefs" jsonb, "upstreamIds" text[], ' +
      '"derivedFrom" jsonb, raw jsonb) ' +
      "ON CONFLICT (source, source_id) DO UPDATE SET " +
      "name = EXCLUDED.name, alt_names = EXCLUDED.alt_names, description = EXCLUDED.description, " +
      "description_credit = EXCLUDED.description_credit, website = EXCLUDED.website, " +
      "wikipedia = EXCLUDED.wikipedia, category = EXCLUDED.category, " +
      "subcategory = EXCLUDED.subcategory, point = EXCLUDED.point, geometry = EXCLUDED.geometry, " +
      "media_refs = EXCLUDED.media_refs, upstream_ids = EXCLUDED.upstream_ids, " +
      "derived_from_source = EXCLUDED.derived_from_source, " +
      "derived_from_id = EXCLUDED.derived_from_id, " +
      "raw = EXCLUDED.raw, normalized_at = EXCLUDED.normalized_at",
    [JSON.stringify(records), now],
  );
}

// ── stage 2a: the concordance ─────────────────────────────────────────────────────────────────────

/**
 * QIDs staging references that the concordance has no answer for yet, in a stable order.
 *
 * Two populations, one question: the QIDs staging asserts as **upstream ids** (identity — the
 * concordance proper), and the **brand QIDs** its media refs name (`brand-wikidata` — never identity,
 * asked only so stage 4 can read their logo claim). They share one cache and one fetch because the
 * question is the same either way: "what does Wikidata say about this entity".
 *
 * "No answer" is `NOT EXISTS`, not `claims IS NULL`: a row with `absent = true` **is** an answer, and
 * re-asking about a deleted entity on every build is exactly the wasted, rate-limit-consuming loop that
 * negative caching exists to close. `refresh` asks anyway, for when a property set changed.
 */
export async function fetchQidsToFetch(
  db: Querier,
  opts: { limit: number; refresh: boolean },
): Promise<string[]> {
  // The prefix and its length come from the vocabulary, not from two hand-typed literals that have to
  // agree with each other and with `upstream.ts`.
  const prefix = "wd:";
  const bare = `substring(u from ${prefix.length + 1})`;
  const { rows } = await db.query(
    // `UNION` (not ALL) already dedupes across the two populations, so no outer DISTINCT.
    "SELECT qid FROM (" +
      `SELECT ${bare} AS qid FROM source_records, unnest(upstream_ids) AS u ` +
      `WHERE u LIKE '${prefix}%' ` +
      "UNION " +
      "SELECT ref->>'value' FROM source_records, jsonb_array_elements(media_refs) AS ref " +
      "WHERE ref->>'kind' = 'brand-wikidata') q " +
      (opts.refresh
        ? ""
        : "WHERE NOT EXISTS (SELECT 1 FROM wikidata_entities w WHERE w.qid = q.qid) ") +
      "ORDER BY qid" +
      (Number.isFinite(opts.limit) ? ` LIMIT ${Math.trunc(opts.limit)}` : ""),
  );
  return (rows as { qid: string }[]).map((row) => row.qid);
}

/** One concordance row, as stage 2b reads it back. */
export interface ConcordanceRow {
  qid: string;
  /**
   * Claim values by property id. **`WikidataValue` itself**, not a local restatement of it: the column
   * holds exactly what the client flattened, and the first cut's hand-written copy had already lost the
   * coordinate case — which is the one the merge gate rules on.
   *
   * `null` when Wikidata says the entity does not exist.
   */
  claims: Record<string, WikidataValue[]> | null;
  enwikiTitle?: string;
  absent: boolean;
}

/** Record what Wikidata said about a batch — including that an entity does not exist. */
export async function writeConcordance(
  db: Querier,
  rows: readonly ConcordanceRow[],
  now: string,
): Promise<void> {
  if (rows.length === 0) return;
  await db.query(
    "INSERT INTO wikidata_entities (qid, claims, enwiki_title, absent, fetched_at) " +
      'SELECT r.qid, r.claims, r."enwikiTitle", r.absent, $2::timestamptz ' +
      "FROM jsonb_to_recordset($1::jsonb) AS r(" +
      'qid text, claims jsonb, "enwikiTitle" text, absent boolean) ' +
      "ON CONFLICT (qid) DO UPDATE SET claims = EXCLUDED.claims, " +
      "enwiki_title = EXCLUDED.enwiki_title, absent = EXCLUDED.absent, " +
      "fetched_at = EXCLUDED.fetched_at",
    [JSON.stringify(rows), now],
  );
}

/** The whole concordance. ~29k rows on us-west — small enough to hold, and stage 2b needs all of it. */
export async function readConcordance(
  db: Querier,
  /** Return only rows whose `claims` hold this key — a join-population read ships ~100 rows, not 28k. */
  claimingPid?: string,
): Promise<ConcordanceRow[]> {
  const { rows } = await db.query(
    "SELECT qid, claims, enwiki_title, absent FROM wikidata_entities" +
      (claimingPid !== undefined ? " WHERE claims ? $1" : ""),
    claimingPid !== undefined ? [claimingPid] : [],
  );
  return (rows as ConcordanceRaw[]).map((row) => ({
    qid: row.qid,
    claims: row.claims,
    ...(row.enwiki_title ? { enwikiTitle: row.enwiki_title } : {}),
    absent: row.absent,
  }));
}

// ── the Wikipedia source ──────────────────────────────────────────────────────────────────────────

/**
 * A staged record that names an English Wikipedia article, and everything the projection needs from it.
 *
 * `category`, `subcategory` and `point` come back because the Wikipedia record it produces must carry
 * them — those columns are `NOT NULL` — and all three lose to OSM in `MAPPER_FIRST`, so none reaches a
 * tile. **Its upstream ids deliberately do not come back.** The article record joins this record's entity
 * by naming it in `derived_from`, not by restating its identifiers; `StagedIdentity.derivedFrom` is where
 * that reasoning lives.
 */
export interface ArticleCandidate {
  source: string;
  sourceId: string;
  /** The article title, from the record's own `wikipedia` URL or its QID's `enwiki` sitelink. */
  title: string;
  category: PlaceCategory;
  subcategory?: PlaceSubcategory;
  /** GeoJSON text, handed straight back to PostGIS. */
  point: string;
  /** Whether the record already has a description of its own, for the report's honest accounting. */
  hasDescription: boolean;
}

/**
 * Staged records naming an article, in a stable order.
 *
 * **A record's own `wikipedia` tag wins over its QID's sitelink.** They usually agree, and where they do
 * not the mapper was looking at the thing — the same principle that gives OSM the name.
 *
 * `source <> 'wikipedia'` keeps a projected record from becoming its own candidate on a re-run: it inherits
 * the `wikipedia` column from nothing, but it *does* inherit the upstream ids, and a QID sitelink would
 * otherwise make it eligible forever.
 */
export async function fetchArticleCandidates(
  db: Querier,
  opts: { limit: number; after?: RecordRef },
): Promise<ArticleCandidate[]> {
  // The `wd:` prefix and its length come from the vocabulary, not two hand-typed literals — the rule
  // `fetchQidsToFetch` states 400 lines up, for the same join.
  const prefix = "wd:";
  const bare = `substring(u from ${prefix.length + 1})`;
  const { rows } = await db.query(
    "SELECT s.source, s.source_id, s.category, s.subcategory, " +
      "ST_AsGeoJSON(s.point) AS point, s.description IS NOT NULL AS has_description, " +
      // The article title comes from the **raw tags**, never from `s.wikipedia`.
      //
      // `s.wikipedia` is a URL built by `enwikiArticleUrl`, which percent-encodes — so stripping the
      // prefix off it yields `Mount_Margaret_(Kittitas_County%2C_Washington)`, which MediaWiki rejects as
      // an invalid title. It does not answer "no such article" either: the page comes back with no
      // extract, which this stage would record as *answered, and there is nothing there* and never ask
      // again. Measured on us-west: **430 of 4,745** URL-derived titles carry an escape, and they are the
      // disambiguated landmarks and transit stations — exactly the articles worth having.
      //
      // `raw` is what OSM said, so the tag is lossless. `wikipedia=en:` wins over `wikipedia:en=`, the
      // order `englishWikipediaUrl` uses — it only matters when a place carries both and they disagree,
      // and there it matters a lot, because the server's choice becomes the place's `wikipedia` link and a
      // different choice here would credit the summary to a different article.
      "COALESCE(" +
      "NULLIF(regexp_replace(s.raw->>'wikipedia', '^[Ee][Nn]:', ''), s.raw->>'wikipedia'), " +
      "NULLIF(s.raw->>'wikipedia:en', ''), " +
      `(SELECT max(w.enwiki_title) FROM unnest(s.upstream_ids) AS u ` +
      `JOIN wikidata_entities w ON w.qid = ${bare} ` +
      `WHERE u LIKE '${prefix}%' AND w.enwiki_title IS NOT NULL)) AS title ` +
      "FROM source_records s WHERE s.source <> $4 " +
      // Only records that actually name an article. Without this the walk pages all 225,501 staged rows to
      // use ~9,631 of them, discarding 96% in JS — and `report.candidates` then prints 225,501 where this
      // stage's own docs say 9,631, which is two numbers for one word in front of an operator.
      "AND (s.raw ? 'wikipedia' OR s.raw ? 'wikipedia:en' OR EXISTS (" +
      `SELECT 1 FROM unnest(s.upstream_ids) AS u JOIN wikidata_entities w ON w.qid = ${bare} ` +
      `WHERE u LIKE '${prefix}%' AND w.enwiki_title IS NOT NULL)) ` +
      "AND ($2::text IS NULL OR (s.source, s.source_id) > ($2::text, $3::text)) " +
      "ORDER BY s.source, s.source_id LIMIT $1",
    [opts.limit, opts.after?.source ?? null, opts.after?.sourceId ?? null, WIKIPEDIA_SOURCE],
  );
  return (rows as ArticleCandidateRaw[]).map((row) => ({
    source: row.source,
    sourceId: row.source_id,
    title: (row.title ?? "").trim(),
    category: row.category as PlaceCategory,
    ...(row.subcategory ? { subcategory: row.subcategory as PlaceSubcategory } : {}),
    point: row.point,
    hasDescription: row.has_description,
  }));
}

/** What Wikipedia said about one article. `absent` distinguishes "answered, none" from "never asked". */
export interface ArticleRow {
  title: string;
  summary?: string;
  imageFile?: string;
  absent: boolean;
}

/** What is already known about these titles, so a run asks about nothing twice. */
export async function readArticles(
  db: Querier,
  titles: readonly string[],
): Promise<Map<string, ArticleRow>> {
  const out = new Map<string, ArticleRow>();
  if (titles.length === 0) return out;
  const { rows } = await db.query(
    "SELECT title, summary, image_file, absent FROM wiki_articles WHERE title = ANY($1::text[])",
    [[...titles]],
  );
  for (const row of rows as ArticleRaw[]) {
    out.set(row.title, {
      title: row.title,
      absent: row.absent,
      ...(row.summary ? { summary: row.summary } : {}),
      ...(row.image_file ? { imageFile: row.image_file } : {}),
    });
  }
  return out;
}

/**
 * Record what Wikipedia said — durable per batch, so an interrupted run keeps its work.
 *
 * A title Wikipedia never answered for never reaches here: the caller drops the whole batch, exactly as
 * `writeConcordance`'s caller does, because a row for it would turn "we never asked successfully" into
 * "this place has no article" and the next run's `readArticles` would skip it forever.
 */
export async function writeArticles(
  db: Querier,
  rows: readonly ArticleRow[],
  now: string,
): Promise<void> {
  if (rows.length === 0) return;
  await db.query(
    "INSERT INTO wiki_articles (title, summary, image_file, absent, fetched_at) " +
      'SELECT r.title, r.summary, r."imageFile", r.absent, $2::timestamptz ' +
      "FROM jsonb_to_recordset($1::jsonb) AS r(" +
      'title text, summary text, "imageFile" text, absent boolean) ' +
      "ON CONFLICT (title) DO UPDATE SET summary = EXCLUDED.summary, " +
      "image_file = EXCLUDED.image_file, absent = EXCLUDED.absent, " +
      "fetched_at = EXCLUDED.fetched_at",
    [JSON.stringify(rows), now],
  );
}

// ── stage 2b: identity ────────────────────────────────────────────────────────────────────────────

/** What a staged record contributes to identity — no fields, just its claims about who it is. */
export interface StagedIdentity {
  source: string;
  sourceId: string;
  upstreamIds: string[];
  /**
   * The record this one was **built out of**, for records that were not read from a source of their
   * own — a Wikipedia article staged against the OSM record that cited it, and the shape the other
   * derived sources use.
   *
   * A column of its own rather than the parent's identifiers copied into `upstreamIds`, and the difference
   * is `upstream.ts`'s first rule: an id there means *a source said this record is that entity*, never
   * invented. Wikipedia never said `osm:w/586464226` — we did, to buy a union-find edge — and the copy is
   * not free:
   *
   * - `fetchUpstreamSpans` measures every id **two records assert**. A copy makes each of the parent's ids
   *   shared, so the CTE that gate rules on grew from 422 rows to 1,029 with only 348 article records
   *   staged, and would reach ~17,000 on the full pass. No verdict changes — a duplicate point cannot
   *   lengthen an `ST_LongestLine`, and `ambiguous_ids` stayed at 252 + 170 — which is the trap: the gate's
   *   evidence silently stops describing the population it was measured against.
   * - `IdentityReport.tier1Records` counts records that share an identifier with another record. A derived
   *   record is not independent corroboration of anything, and counting the pair doubled the number the
   *   whole tier-1 gate was justified by.
   * - And a derived record whose parent's merge keys were **all** refused would join no entity at all,
   *   publishing as a nameless place. Unreachable while every OSM record carries its own never-gated
   *   `osm:` id, but it is unreachable by luck rather than by construction. Naming the parent directly
   *   cannot fail that way, because it does not go through the gate.
   *
   * **This is the one place that argument is written out.** `identity.ts`, `report.ts` and `wikipedia.ts`
   * point here instead of restating it — it is a measurement, and four copies of a measurement are three
   * that go stale silently.
   */
  derivedFrom?: RecordRef;
}

/**
 * Every staged record's identity claims, in one statement.
 *
 * **Not paged, unlike stage 1's read, and the difference is the point.** Stage 1 pages because it writes
 * each page durably and can resume; stage 2b must hold the whole set regardless — a component is only
 * correct when every record sharing an id is in view — and `pg` buffers a result set into JS objects
 * before resolving either way, so 113 round trips bought no smaller peak. Only the identity columns come
 * back, no geometry and no description, which is what keeps the set holdable at all.
 *
 * Ordered so the resolver's output is stable regardless of physical row order.
 */
export async function fetchStagedIdentities(db: Querier): Promise<StagedIdentity[]> {
  const { rows } = await db.query(
    "SELECT source, source_id, upstream_ids, derived_from_source, derived_from_id " +
      "FROM source_records ORDER BY source, source_id",
  );
  return (rows as StagedIdentityRow[]).map((row) => ({
    source: row.source,
    sourceId: row.source_id,
    upstreamIds: row.upstream_ids ?? [],
    // Two nullable columns becoming one optional object: the conditional is the mapping, not a guard —
    // `exactOptionalPropertyTypes` means the key is either present or absent, so something has to decide.
    // A half row cannot reach here: `ensureSchema`'s CHECK constraint refuses it at the write.
    ...(row.derived_from_source && row.derived_from_id
      ? { derivedFrom: { source: row.derived_from_source, sourceId: row.derived_from_id } }
      : {}),
  }));
}

/** An identifier more than one staged record asserts, with how far apart those records actually are. */
export interface UpstreamSpan {
  upstreamId: string;
  /** Greatest distance between any two of those records' representative points, in metres. */
  spanM: number;
}

/**
 * How far apart the records sharing each identifier are — the evidence the merge gate rules on.
 *
 * Only ids asserted more than once can merge anything, so only those are measured. `ST_LongestLine`
 * cast to `geography` gives true metres; the degree-scaled shortcut overestimates away from the
 * equator, and while erring toward splitting is the safe direction
 * (`apps/atlas/doc/spec/place-identity.md` §3), a gate should rule on the real number rather than
 * on a bias that happens to point the right way.
 *
 * Measured on us-west: 422 identifiers are shared, 188 of them by records more than 500 m apart.
 */
export async function fetchUpstreamSpans(db: Querier): Promise<UpstreamSpan[]> {
  const { rows } = await db.query(
    "WITH dup AS (" +
      "SELECT u AS upstream_id, ST_Collect(point) AS pts " +
      "FROM source_records, unnest(upstream_ids) AS u GROUP BY 1 HAVING count(*) > 1) " +
      "SELECT upstream_id, " +
      "round(ST_Length(ST_LongestLine(pts, pts)::geography))::bigint AS span_m FROM dup",
  );
  // The record count is deliberately not projected: `identity.ts` counts asserters itself (it needs the
  // singletons too), and a second derivation of one number is a second thing that can disagree with it.
  return (rows as { upstream_id: string; span_m: string }[]).map((row) => ({
    upstreamId: row.upstream_id,
    spanM: Number(row.span_m),
  }));
}

/** A human's verdict about two identifiers. */
export interface DecisionRow {
  a: string;
  b: string;
  verdict: "same" | "distinct";
}

export async function readDecisions(db: Querier): Promise<DecisionRow[]> {
  const { rows } = await db.query(
    "SELECT a, b, verdict FROM decisions WHERE verdict IN ('same', 'distinct') ORDER BY a, b",
  );
  return rows as DecisionRow[];
}

/** An entity as the previous build left it — the state that makes a place id hold still. */
export interface PriorEntity {
  id: string;
  /**
   * Everything it holds, with whether each established identity.
   *
   * The `merge_key` filter deliberately lives in `identity.ts` rather than in this SELECT. It *is* the
   * rule that keeps the 54 cameras apart across rebuilds — carried ids must never re-glue what the gate
   * separated — and a rule enforced by a SQL `WHERE` is a rule no test evaluates. Passing the flags
   * through means the regression test exercises the real predicate instead of hand-copying it.
   */
  upstream: { id: string; mergeKey: boolean }[];
  /** How many staged records it held — the "better attested" half of the survivor rule. */
  members: number;
  /** Ids that have already merged into it, flattened. */
  aliases: string[];
}

export async function readPriorEntities(db: Querier): Promise<PriorEntity[]> {
  // Three pre-aggregated joins, not three correlated subqueries in the target list. Postgres cannot
  // pull a correlated aggregate up into a join, so the subquery form runs one index scan per entity per
  // aggregate — 3 x 225k subplan executions on a rebuild, where this is three sequential aggregations
  // and three hash joins. Invisible on a first build, which is exactly why it needed looking at.
  const { rows } = await db.query(
    "SELECT e.id, COALESCE(u.refs, '[]'::jsonb) AS upstream, " +
      "COALESCE(m.n, 0)::int AS members, COALESCE(a.ids, '{}') AS aliases " +
      "FROM entities e " +
      "LEFT JOIN (SELECT entity_id, jsonb_agg(jsonb_build_object(" +
      "'id', upstream_id, 'mergeKey', merge_key) ORDER BY upstream_id) AS refs " +
      "FROM entity_upstream GROUP BY entity_id) u ON u.entity_id = e.id " +
      "LEFT JOIN (SELECT entity_id, count(*) AS n FROM entity_members GROUP BY entity_id) m " +
      "ON m.entity_id = e.id " +
      "LEFT JOIN (SELECT entity_id, array_agg(alias_id ORDER BY alias_id) AS ids " +
      "FROM entity_aliases GROUP BY entity_id) a ON a.entity_id = e.id " +
      "ORDER BY e.id",
  );
  return (rows as PriorEntityRow[]).map((row) => ({
    id: row.id,
    upstream: row.upstream ?? [],
    members: row.members,
    aliases: row.aliases ?? [],
  }));
}

/**
 * One entity to write: its id, who belongs to it, what it asserts, and what merged into it.
 *
 * `identity.ts`'s `ResolvedEntity` **extends** this rather than restating it. The two were written out
 * field for field once, which is the mistake `StagedRecord = Omit<StagedRow, "source">` already records
 * in `osm.ts`: a field added to one side compiles clean while the writer silently drops it — here, on
 * the tables that cannot be regenerated.
 */
export interface EntityWrite {
  id: string;
  members: RecordRef[];
  upstream: { id: string; mergeKey: boolean }[];
  aliases: string[];
}

/**
 * Write a batch of entities — rows, memberships, upstream ids and aliases.
 *
 * **Upsert plus a targeted delete, never a wholesale rebuild.** The delete is narrow on purpose: an
 * id that moved to another entity (a split) must leave the one it left, or the next build sees it
 * on two entities and reads that as a merge — undoing the split on every rebuild. An id that simply
 * stopped being asserted by any source is *not* deleted: `apps/atlas/doc/spec/place-identity.md` §1
 * makes ids permanent members, because a consumer or another volume may still be holding one.
 *
 * Caller supplies the whole batch inside one transaction; see {@link Transactor} for why that matters.
 */
export async function writeEntities(
  db: Querier,
  batch: readonly EntityWrite[],
  now: string,
): Promise<void> {
  if (batch.length === 0) return;

  await db.query(
    "INSERT INTO entities (id, created_at) " +
      "SELECT r.id, $2::timestamptz FROM jsonb_to_recordset($1::jsonb) AS r(id text) " +
      "ON CONFLICT (id) DO NOTHING",
    [JSON.stringify(batch.map((entity) => ({ id: entity.id }))), now],
  );

  const members = batch.flatMap((entity) =>
    entity.members.map((member) => ({ ...member, entityId: entity.id })),
  );
  if (members.length > 0) {
    await db.query(
      "INSERT INTO entity_members (entity_id, source, source_id) " +
        'SELECT r."entityId", r.source, r."sourceId" FROM jsonb_to_recordset($1::jsonb) ' +
        'AS r("entityId" text, source text, "sourceId" text) ' +
        "ON CONFLICT (source, source_id) DO UPDATE SET entity_id = EXCLUDED.entity_id",
      [JSON.stringify(members)],
    );
  }

  const upstream = batch.flatMap((entity) =>
    entity.upstream.map((ref) => ({ ...ref, entityId: entity.id })),
  );
  if (upstream.length > 0) {
    // Serialized once. ~310k rows is ~22 MB of JSON, and both statements below want the same payload.
    const payload = JSON.stringify(upstream);
    await db.query(
      "INSERT INTO entity_upstream (entity_id, upstream_id, merge_key) " +
        'SELECT r."entityId", r.id, r."mergeKey" FROM jsonb_to_recordset($1::jsonb) ' +
        'AS r("entityId" text, id text, "mergeKey" boolean) ' +
        "ON CONFLICT (entity_id, upstream_id) DO UPDATE SET merge_key = EXCLUDED.merge_key",
      [payload],
    );
    // **Merge keys only, on both sides.** Exclusivity is a property of merge keys and of nothing else:
    // `identity.ts` derives them from the graph, so each belongs to exactly one entity, and one that
    // moved must leave the entity it left or the next build reads it as a merge and undoes the split.
    //
    // A *carried* id is deliberately non-exclusive — `wd:Q108485435` sits on all 54 cameras the
    // gate separated. Unqualified, this DELETE enforced exclusivity on those too, and since every
    // one of the 54 rows is "some other entity's" to another row in the same payload, **all of them
    // went**: measured, `entity_upstream` held zero rows for that QID while 54 entities carried it.
    // That is `apps/atlas/doc/spec/place-identity.md` §1's "ids are permanent members" broken
    // silently, and stage 4 reads carried ids.
    await db.query(
      "DELETE FROM entity_upstream u USING jsonb_to_recordset($1::jsonb) " +
        'AS r("entityId" text, id text, "mergeKey" boolean) ' +
        'WHERE u.upstream_id = r.id AND u.entity_id <> r."entityId" ' +
        'AND u.merge_key AND r."mergeKey"',
      [payload],
    );
  }

  const aliases = batch.flatMap((entity) =>
    entity.aliases.map((aliasId) => ({ aliasId, entityId: entity.id })),
  );
  if (aliases.length > 0) {
    await db.query(
      "INSERT INTO entity_aliases (alias_id, entity_id) " +
        'SELECT r."aliasId", r."entityId" FROM jsonb_to_recordset($1::jsonb) ' +
        'AS r("aliasId" text, "entityId" text) ' +
        "ON CONFLICT (alias_id) DO UPDATE SET entity_id = EXCLUDED.entity_id",
      [JSON.stringify(aliases)],
    );
  }
}

/**
 * Drop memberships whose staged record is gone, and say how many — a **withdrawal**.
 *
 * `apps/atlas/doc/spec/place-identity.md` §5: a place that no longer exists is simply absent, and
 * the consumer's cell-scoped retirement handles it. Absence is not an alias and must never be
 * turned into one. The entity row and its ids stay behind, because an id is never reused and a
 * consumer may still be holding it.
 *
 * Done in SQL rather than by diffing in memory: the question is "which memberships have no staged
 * record", and the database is holding both sides of it.
 */
export async function pruneVanishedMembers(db: Querier): Promise<number> {
  // `count(*)` over the CTE, not `RETURNING` every row: the answer is one number, and after an extract
  // refresh the row form ships tens of thousands of strings back to produce it.
  const { rows } = await db.query(
    "WITH gone AS (DELETE FROM entity_members m WHERE NOT EXISTS (" +
      "SELECT 1 FROM source_records s WHERE s.source = m.source AND s.source_id = m.source_id) " +
      "RETURNING 1) SELECT count(*)::int AS n FROM gone",
  );
  return (rows as { n: number }[])[0]?.n ?? 0;
}

/**
 * One identifier the merge gate refused, with the evidence it refused it on.
 *
 * `reason` is the narrow union from `identity.ts`, not a widened `string`: widening it here meant a third
 * gate reason could be added, compile clean, and never actually be writable to `ambiguous_ids`.
 */
export interface AmbiguousId {
  upstreamId: string;
  records: number;
  spanM?: number;
  reason: GateReason;
}

/** Why the merge gate refused an identifier. Adding one is a compile error everywhere it is rendered. */
export type GateReason = "not-a-place" | "span";

/** Record every refusal, replacing the previous run's — a gate nobody can inspect is a silent policy. */
export async function writeAmbiguousIds(
  db: Querier,
  ids: readonly AmbiguousId[],
  now: string,
): Promise<void> {
  await db.query("DELETE FROM ambiguous_ids");
  if (ids.length === 0) return;
  await db.query(
    "INSERT INTO ambiguous_ids (upstream_id, records, span_m, reason, seen_at) " +
      'SELECT r."upstreamId", r.records, r."spanM", r.reason, $2::timestamptz ' +
      "FROM jsonb_to_recordset($1::jsonb) AS r(" +
      '"upstreamId" text, records int, "spanM" bigint, reason text)',
    [JSON.stringify(ids), now],
  );
}

// ── the review console (`review.ts`) ──────────────────────────────────────────────────────────────

// ── the media review console (`review.ts`, the Media tab) ─────────────────────────────────────────

/** One published photo as the contact sheet shows it, with the place it is attached to. */
export interface MediaQueueEntry {
  fileKey: string;
  source: string;
  thumbHash: string;
  fullHash: string;
  license?: string;
  author?: string;
  sourceUrl?: string;
  fetchedAt: string;
  /** How many places publish this file — >1 is a shared logo, where a reject is worth thinking about. */
  places: number;
  /** The first place's name, so the grid can label a thumb without a second round trip. */
  placeName?: string;
}

/**
 * Whether a photo is still waiting for a human — the Media tab's whole population.
 *
 * Spelled once for the same reason as {@link MEDIA_PUBLISHABLE_SQL}: the queue's page and the
 * header's count must never disagree about what "unreviewed" means. `f` is the `media_files` alias.
 * Only a **global** verdict retires a photo from the queue; an `unlink` rules on one pairing and
 * leaves the photo itself unjudged.
 */
const NO_MEDIA_VERDICT_SQL =
  "NOT EXISTS (SELECT 1 FROM media_decisions d WHERE d.file_key = f.file_key " +
  "AND d.entity_id IS NULL)";

/** The photos the Media tab draws from at all: crawled, with bytes, and worth showing. */
const REVIEWABLE_MEDIA_SQL = "f.state = 'published' AND f.thumb_hash IS NOT NULL";

/**
 * A page of photos **no one has ruled on yet**, newest crawl first.
 *
 * Keyset-paged on `(fetched_at, file_key)` rather than offset: approving a page removes those rows
 * from this very queue, and an offset would then step over exactly as many unreviewed photos as were
 * just approved. The normal loop needs no cursor at all — approve the page, re-read the head — and
 * the cursor exists for skipping a page without ruling on it.
 */
export async function fetchMediaQueue(
  db: Querier,
  opts: { limit: number; source?: string; after?: { fetchedAt: string; fileKey: string } },
): Promise<MediaQueueEntry[]> {
  const { rows } = await db.query(
    "SELECT f.file_key, f.source, f.thumb_hash, f.full_hash, f.license, f.author, f.source_url, " +
      "f.fetched_at, l.places, l.place_name FROM media_files f " +
      "LEFT JOIN LATERAL (SELECT count(*)::int AS places, " +
      "min(m.fields->>'name') AS place_name FROM place_media pm " +
      "LEFT JOIN merged_places m ON m.entity_id = pm.entity_id " +
      "WHERE pm.file_key = f.file_key) l ON true " +
      `WHERE ${REVIEWABLE_MEDIA_SQL} AND ${NO_MEDIA_VERDICT_SQL} ` +
      "AND ($2::text IS NULL OR f.source = $2) " +
      "AND ($3::timestamptz IS NULL OR (f.fetched_at, f.file_key) < ($3::timestamptz, $4::text)) " +
      "ORDER BY f.fetched_at DESC, f.file_key DESC LIMIT $1",
    [opts.limit, opts.source ?? null, opts.after?.fetchedAt ?? null, opts.after?.fileKey ?? null],
  );
  return (
    rows as {
      file_key: string;
      source: string;
      thumb_hash: string;
      full_hash: string;
      license: string | null;
      author: string | null;
      source_url: string | null;
      fetched_at: Date;
      places: number | null;
      place_name: string | null;
    }[]
  ).map((row) => ({
    fileKey: row.file_key,
    source: row.source,
    thumbHash: row.thumb_hash,
    fullHash: row.full_hash,
    ...(row.license === null ? {} : { license: row.license }),
    ...(row.author === null ? {} : { author: row.author }),
    ...(row.source_url === null ? {} : { sourceUrl: row.source_url }),
    fetchedAt: row.fetched_at.toISOString(),
    places: row.places ?? 0,
    ...(row.place_name === null ? {} : { placeName: row.place_name }),
  }));
}

/** A place one photo is attached to — the detail panel's "what am I looking at". */
export interface MediaPlace {
  entityId: string;
  name?: string;
  category?: string;
  rank: number;
  /** Already removed by a reviewer — so the panel does not offer to remove it twice. */
  removed: boolean;
  /** This pairing is already unlinked. */
  unlinked: boolean;
}

export async function placesForFile(db: Querier, fileKey: string): Promise<MediaPlace[]> {
  const { rows } = await db.query(
    "SELECT pm.entity_id, pm.rank, m.fields->>'name' AS name, m.fields->>'category' AS category, " +
      "(pd.entity_id IS NOT NULL) AS removed, (d.file_key IS NOT NULL) AS unlinked " +
      "FROM place_media pm " +
      "LEFT JOIN merged_places m ON m.entity_id = pm.entity_id " +
      "LEFT JOIN place_decisions pd ON pd.entity_id = pm.entity_id AND pd.verdict = 'remove' " +
      "LEFT JOIN media_decisions d ON d.file_key = pm.file_key AND d.entity_id = pm.entity_id " +
      "AND d.verdict = 'unlink' " +
      "WHERE pm.file_key = $1 ORDER BY pm.rank, pm.entity_id",
    [fileKey],
  );
  return (
    rows as {
      entity_id: string;
      rank: number;
      name: string | null;
      category: string | null;
      removed: boolean;
      unlinked: boolean;
    }[]
  ).map((row) => ({
    entityId: row.entity_id,
    rank: row.rank,
    ...(row.name === null ? {} : { name: row.name }),
    ...(row.category === null ? {} : { category: row.category }),
    removed: row.removed,
    unlinked: row.unlinked,
  }));
}

/** What the reviewer has got through, and what they have withheld — the Media tab's header. */
export interface MediaReviewStats {
  published: number;
  unreviewed: number;
  approved: number;
  rejected: number;
  unlinked: number;
  placesRemoved: number;
  /** Every source with unreviewed photos, so the filter offers only what is actually there. */
  sources: { source: string; unreviewed: number }[];
}

export async function mediaReviewStats(db: Querier): Promise<MediaReviewStats> {
  // Two statements, not seven: the three withheld counts are the ones `withheldByReview` already
  // answers for publish's report — asking them a second way is how the tab and the report drift —
  // and the per-source roll-up carries the totals, since a sum over its rows IS the total.
  const [withheld, approved, { rows }] = await Promise.all([
    withheldByReview(db),
    (async (): Promise<number> => {
      const { rows } = await db.query(
        "SELECT count(*)::int AS n FROM media_decisions WHERE verdict = 'ok'",
      );
      return (rows as { n: number }[])[0]?.n ?? 0;
    })(),
    db.query(
      "SELECT f.source, count(*)::int AS published, " +
        `count(*) FILTER (WHERE ${NO_MEDIA_VERDICT_SQL})::int AS unreviewed ` +
        `FROM media_files f WHERE ${REVIEWABLE_MEDIA_SQL} GROUP BY 1 ORDER BY 2 DESC`,
    ),
  ]);
  const bySource = rows as { source: string; published: number; unreviewed: number }[];
  return {
    published: bySource.reduce((sum, row) => sum + row.published, 0),
    unreviewed: bySource.reduce((sum, row) => sum + row.unreviewed, 0),
    approved,
    rejected: withheld.files,
    unlinked: withheld.pairs,
    placesRemoved: withheld.places,
    // Only sources with something left to look at — the filter should not offer an empty list.
    sources: bySource
      .filter((row) => row.unreviewed > 0)
      .map((row) => ({ source: row.source, unreviewed: row.unreviewed })),
  };
}

/** A reviewer's verdict about one photo — `ok`/`reject` name no place, `unlink` names one. */
export interface MediaDecisionWrite {
  fileKey: string;
  entityId?: string;
  verdict: "ok" | "reject" | "unlink";
  reason?: string;
  decidedBy: string;
}

/** Record verdicts, one row per (file, scope) — a re-decide replaces rather than accumulates. */
export async function writeMediaDecisions(
  db: Querier,
  rows: readonly MediaDecisionWrite[],
  now: string,
): Promise<void> {
  if (rows.length === 0) return;
  await db.query(
    "INSERT INTO media_decisions (file_key, entity_id, verdict, reason, decided_by, decided_at) " +
      'SELECT r."fileKey", r."entityId", r.verdict, r.reason, r."decidedBy", $2::timestamptz ' +
      'FROM jsonb_to_recordset($1::jsonb) AS r("fileKey" text, "entityId" text, verdict text, ' +
      'reason text, "decidedBy" text) ' +
      "ON CONFLICT (file_key, COALESCE(entity_id, '')) DO UPDATE SET verdict = EXCLUDED.verdict, " +
      "reason = EXCLUDED.reason, decided_by = EXCLUDED.decided_by, decided_at = EXCLUDED.decided_at",
    [JSON.stringify(rows), now],
  );
}

/** Withdraw a photo verdict — the photo returns to the queue, and publishes again. */
export async function deleteMediaDecision(
  db: Querier,
  fileKey: string,
  entityId?: string,
): Promise<number> {
  const result = await db.query(
    "DELETE FROM media_decisions WHERE file_key = $1 AND COALESCE(entity_id, '') = COALESCE($2, '')",
    [fileKey, entityId ?? null],
  );
  return (result as { rowCount?: number | null }).rowCount ?? 0;
}

/** Remove a place from publication, or withdraw that removal. */
export async function writePlaceDecision(
  db: Querier,
  row: { entityId: string; reason?: string; decidedBy: string },
  now: string,
): Promise<void> {
  await db.query(
    "INSERT INTO place_decisions (entity_id, verdict, reason, decided_by, decided_at) " +
      "VALUES ($1, 'remove', $2, $3, $4) " +
      "ON CONFLICT (entity_id) DO UPDATE SET verdict = 'remove', reason = EXCLUDED.reason, " +
      "decided_by = EXCLUDED.decided_by, decided_at = EXCLUDED.decided_at",
    [row.entityId, row.reason ?? null, row.decidedBy, now],
  );
}

/** The place ids a reviewer removed — the manifest's `retired` list, in a stable order. */
export async function removedPlaces(db: Querier): Promise<string[]> {
  const { rows } = await db.query(
    "SELECT entity_id FROM place_decisions WHERE verdict = 'remove' ORDER BY entity_id",
  );
  return (rows as { entity_id: string }[]).map((row) => row.entity_id);
}

export async function deletePlaceDecision(db: Querier, entityId: string): Promise<number> {
  const result = await db.query("DELETE FROM place_decisions WHERE entity_id = $1", [entityId]);
  return (result as { rowCount?: number | null }).rowCount ?? 0;
}

/**
 * What review is withholding from the next volume — publish's honesty line.
 *
 * Without it a volume simply has fewer places than `merged_places` holds and nothing says why, which
 * is the silent-divergence this pipeline refuses everywhere else.
 */
export async function withheldByReview(
  db: Querier,
): Promise<{ places: number; files: number; pairs: number }> {
  const { rows } = await db.query(
    "SELECT (SELECT count(*) FROM place_decisions WHERE verdict = 'remove')::int AS places, " +
      "(SELECT count(*) FROM media_decisions WHERE verdict = 'reject')::int AS files, " +
      "(SELECT count(*) FROM media_decisions WHERE verdict = 'unlink')::int AS pairs",
  );
  const row = (rows as { places: number; files: number; pairs: number }[])[0];
  return { places: row?.places ?? 0, files: row?.files ?? 0, pairs: row?.pairs ?? 0 };
}

/** A gate refusal as the review console reads it back — the refusal plus when the gate last ruled. */
export interface AmbiguousRow extends AmbiguousId {
  seenAt: string;
}

interface AmbiguousDbRow {
  upstream_id: string;
  records: number;
  span_m: string | null;
  reason: GateReason;
  seen_at: Date;
}

const AMBIGUOUS_SELECT = "SELECT upstream_id, records, span_m, reason, seen_at FROM ambiguous_ids";

function ambiguousRow(row: AmbiguousDbRow): AmbiguousRow {
  return {
    upstreamId: row.upstream_id,
    records: row.records,
    ...(row.span_m === null ? {} : { spanM: Number(row.span_m) }),
    reason: row.reason,
    seenAt: row.seen_at.toISOString(),
  };
}

export async function readAmbiguousIds(db: Querier): Promise<AmbiguousRow[]> {
  const { rows } = await db.query(`${AMBIGUOUS_SELECT} ORDER BY upstream_id`);
  return (rows as AmbiguousDbRow[]).map(ambiguousRow);
}

/** One refusal by id — the verdict writer's evidence lookup, per human click, so it reads one row. */
export async function readAmbiguousId(
  db: Querier,
  upstreamId: string,
): Promise<AmbiguousRow | undefined> {
  const { rows } = await db.query(`${AMBIGUOUS_SELECT} WHERE upstream_id = $1`, [upstreamId]);
  const row = (rows as AmbiguousDbRow[])[0];
  return row ? ambiguousRow(row) : undefined;
}

/** What the console shows about one record asserting a refused id — fields, pin, and its graph node. */
export interface ReviewAsserter {
  source: string;
  sourceId: string;
  name?: string;
  category: string;
  subcategory?: string;
  lon: number;
  lat: number;
}

/**
 * Every staged record asserting each of `ids`, keyed by id.
 *
 * One statement for the whole queue: `unnest` drives a nested-loop of GIN probes over
 * `source_records_upstream_idx`, which is a few hundred index hits — not a scan per refusal.
 */
export async function recordsAssertingIds(
  db: Querier,
  ids: readonly string[],
): Promise<Map<string, ReviewAsserter[]>> {
  const out = new Map<string, ReviewAsserter[]>();
  if (ids.length === 0) return out;
  const { rows } = await db.query(
    "SELECT u.id AS upstream_id, r.source, r.source_id, r.name, r.category, r.subcategory, " +
      "ST_X(r.point) AS lon, ST_Y(r.point) AS lat " +
      "FROM unnest($1::text[]) AS u(id) " +
      "JOIN source_records r ON r.upstream_ids @> ARRAY[u.id] " +
      "ORDER BY u.id, r.source, r.source_id",
    [ids],
  );
  for (const row of rows as {
    upstream_id: string;
    source: string;
    source_id: string;
    name: string | null;
    category: string;
    subcategory: string | null;
    lon: number;
    lat: number;
  }[]) {
    const asserter: ReviewAsserter = {
      source: row.source,
      sourceId: row.source_id,
      ...(row.name === null ? {} : { name: row.name }),
      category: row.category,
      ...(row.subcategory === null ? {} : { subcategory: row.subcategory }),
      lon: row.lon,
      lat: row.lat,
    };
    const held = out.get(row.upstream_id);
    if (held) held.push(asserter);
    else out.set(row.upstream_id, [asserter]);
  }
  return out;
}

/** What the concordance knows a QID names — the console's label for a `wd:` refusal. */
export interface WikidataLabel {
  enwikiTitle?: string;
  absent: boolean;
}

export async function readWikidataLabels(
  db: Querier,
  qids: readonly string[],
): Promise<Map<string, WikidataLabel>> {
  const out = new Map<string, WikidataLabel>();
  if (qids.length === 0) return out;
  const { rows } = await db.query(
    "SELECT qid, enwiki_title, absent FROM wikidata_entities WHERE qid = ANY($1::text[])",
    [qids],
  );
  for (const row of rows as { qid: string; enwiki_title: string | null; absent: boolean }[]) {
    out.set(row.qid, {
      ...(row.enwiki_title === null ? {} : { enwikiTitle: row.enwiki_title }),
      absent: row.absent,
    });
  }
  return out;
}

/**
 * A decision as the console's log shows it. `evidence` is deliberately not selected — the log renders
 * who decided what and when; the evidence blob (a whole context row per verdict) stays queryable in
 * the table without riding every refresh.
 */
export interface DecisionLogRow {
  a: string;
  b: string;
  verdict: string;
  decidedBy: string;
  decidedAt: string;
}

export async function readDecisionLog(db: Querier): Promise<DecisionLogRow[]> {
  const { rows } = await db.query(
    "SELECT a, b, verdict, decided_by, decided_at FROM decisions ORDER BY decided_at DESC, a, b",
  );
  return (
    rows as { a: string; b: string; verdict: string; decided_by: string; decided_at: Date }[]
  ).map((row) => ({
    a: row.a,
    b: row.b,
    verdict: row.verdict,
    decidedBy: row.decided_by,
    decidedAt: row.decided_at.toISOString(),
  }));
}

export interface DecisionWrite {
  a: string;
  b: string;
  verdict: "same" | "distinct";
  evidence: unknown;
  decidedBy: string;
}

/**
 * Record one verdict — a single upsert against `decisions_pair_idx`, so a re-decide in **either**
 * orientation replaces the existing row rather than sitting beside it. The new spelling wins
 * (`a = EXCLUDED.a`), which is what lets the canonical orientation correct a hand-written one.
 */
export async function writeDecision(db: Querier, row: DecisionWrite, now: string): Promise<void> {
  await db.query(
    "INSERT INTO decisions (a, b, verdict, evidence, decided_by, decided_at) " +
      "VALUES ($1, $2, $3, $4, $5, $6) " +
      "ON CONFLICT ((LEAST(a, b)), (GREATEST(a, b))) DO UPDATE SET " +
      "a = EXCLUDED.a, b = EXCLUDED.b, verdict = EXCLUDED.verdict, evidence = EXCLUDED.evidence, " +
      "decided_by = EXCLUDED.decided_by, decided_at = EXCLUDED.decided_at",
    [row.a, row.b, row.verdict, JSON.stringify(row.evidence ?? null), row.decidedBy, now],
  );
}

/** Withdraw a verdict, whichever way round it was stored. Returns how many rows went. */
export async function deleteDecision(db: Querier, a: string, b: string): Promise<number> {
  const result = await db.query(
    "DELETE FROM decisions WHERE (a = $1 AND b = $2) OR (a = $2 AND b = $1)",
    [a, b],
  );
  return (result as { rowCount?: number | null }).rowCount ?? 0;
}

/** One entity and the staged records that belong to it — stage 3's unit of work. */
/**
 * The entity keyset page, spelled once.
 *
 * Two stages page over it (`merge` and `media`), and a drift between two copies of the `after`/`LIMIT`
 * handling would silently skip or repeat entities — a wrong dataset, not a slow one, with nothing that
 * could fail. `$1` is the limit, `$2` the exclusive cursor.
 */
const ENTITY_KEYSET_PAGE =
  "SELECT DISTINCT entity_id FROM entity_members " +
  "WHERE ($2::text IS NULL OR entity_id > $2) ORDER BY entity_id LIMIT $1";

export interface EntityRecords {
  entityId: string;
  records: MergeInput[];
}

/**
 * A page of entities with every record each one holds, keyset-paged on `entity_id`.
 *
 * **An entity is never split across pages**, which is why the page is chosen by a CTE over the distinct
 * entity ids rather than by `LIMIT` on the joined rows. A merge that saw half a place's records would
 * produce a place missing whatever the other half won — a wrong answer, not a partial one.
 *
 * Only entities that still hold members appear. An entity with none is either withdrawn or merged away
 * (its id lives on in `entities` forever, and as an alias when merged), and neither is a place to publish.
 */
export async function fetchEntityRecords(
  db: Querier,
  opts: { limit: number; after?: string },
): Promise<EntityRecords[]> {
  const { rows } = await db.query(
    `WITH page AS (${ENTITY_KEYSET_PAGE}) ` +
      "SELECT m.entity_id, s.source, s.source_id, s.name, s.alt_names, s.description, " +
      "s.description_credit, s.website, s.wikipedia, s.category, s.subcategory, " +
      "ST_AsGeoJSON(s.point) AS point, ST_AsGeoJSON(s.geometry) AS geometry " +
      "FROM page p JOIN entity_members m ON m.entity_id = p.entity_id " +
      "JOIN source_records s ON s.source = m.source AND s.source_id = m.source_id " +
      // Ordered so equally-ranked sources merge in a stable order — `mergePlace`'s sort is stable, so
      // this is what makes stage 3 reproducible rather than dependent on physical row order.
      "ORDER BY m.entity_id, m.source, m.source_id",
    [opts.limit, opts.after ?? null],
  );

  const out: EntityRecords[] = [];
  for (const row of rows as MergeSourceRow[]) {
    const last = out[out.length - 1];
    const group = last?.entityId === row.entity_id ? last : undefined;
    const record: MergeInput = {
      source: row.source,
      category: row.category as PlaceCategory,
      point: row.point,
      ...(row.subcategory ? { subcategory: row.subcategory as PlaceSubcategory } : {}),
      ...(row.name ? { name: row.name } : {}),
      ...(row.alt_names?.length ? { altNames: row.alt_names } : {}),
      ...(row.description ? { description: row.description } : {}),
      ...(row.description_credit ? { descriptionCredit: row.description_credit } : {}),
      ...(row.website ? { website: row.website } : {}),
      ...(row.wikipedia ? { wikipedia: row.wikipedia } : {}),
      ...(row.geometry ? { geometry: row.geometry } : {}),
    };
    if (group) group.records.push(record);
    else out.push({ entityId: row.entity_id, records: [record] });
  }
  return out;
}

// ── stage 4: the media crawl ──────────────────────────────────────────────────────────────────────

/**
 * The source id a Wikipedia-derived staged record is written under.
 *
 * Here rather than in `wikipedia.ts` because the candidate query filters on it — a projected record must
 * never become its own candidate on a re-run, and it inherits the upstream ids that would otherwise make it
 * eligible forever. Typed `SourceId` so it cannot drift from the terms table that has to declare it.
 */
export const WIKIPEDIA_SOURCE: SourceId = "wikipedia";

/**
 * The source id an NPS-derived staged record is written under — {@link WIKIPEDIA_SOURCE}'s sibling, here
 * for the same reason: the candidate query excludes it so a projected record never becomes its own
 * candidate, and `SourceId` ties it to the terms table that has to declare it.
 */
export const NPS_SOURCE: SourceId = "nps";

// ── the NPS source ────────────────────────────────────────────────────────────────────────────────

/** One image the NPS API lists for a unit, as the cache stores it (`nps_units.images`). */
export interface NpsImage {
  url: string;
  title?: string;
  /** The API's per-image credit line ("NPS Photo", "NPS / Jacob W. Frank", or a third party's name). */
  credit?: string;
  altText?: string;
}

/** One park unit as the API described it, keyed by its lowercase `parkCode`. */
export interface NpsUnit {
  unitCode: string;
  name: string;
  description?: string;
  designation?: string;
  states?: string;
  /** The unit's page on nps.gov — staged as `website`, and the credit's `sourceUrl`. */
  website?: string;
  images: NpsImage[];
}

/**
 * **Replace** the corpus snapshot — upsert every unit and delete the rows the batch no longer names,
 * in one atomic statement. The delete is what keeps the schema's "a code with no row IS the answer"
 * true over time: an upsert alone would preserve a delisted unit forever, and the crawl reads this
 * table as its metadata service — a stale row would keep serving a dropped unit's credit and page.
 * (The data-modifying CTE sees the pre-statement table, so it deletes only pre-existing rows whose
 * code the batch lacks; the empty-input early return means a caller can never wipe the corpus by
 * accident — an empty fetch aborts upstream anyway.)
 */
export async function writeNpsUnits(
  db: Querier,
  units: readonly NpsUnit[],
  now: string,
): Promise<void> {
  if (units.length === 0) return;
  await db.query(
    "WITH incoming AS (" +
      "INSERT INTO nps_units (unit_code, name, description, designation, states, website, images, fetched_at) " +
      'SELECT r."unitCode", r.name, r.description, r.designation, r.states, r.website, ' +
      "COALESCE(r.images, '[]'::jsonb), $2::timestamptz " +
      "FROM jsonb_to_recordset($1::jsonb) AS r(" +
      '"unitCode" text, name text, description text, designation text, states text, website text, ' +
      "images jsonb) " +
      "ON CONFLICT (unit_code) DO UPDATE SET name = EXCLUDED.name, " +
      "description = EXCLUDED.description, designation = EXCLUDED.designation, " +
      "states = EXCLUDED.states, website = EXCLUDED.website, images = EXCLUDED.images, " +
      "fetched_at = EXCLUDED.fetched_at " +
      "RETURNING unit_code) " +
      "DELETE FROM nps_units WHERE unit_code NOT IN (SELECT unit_code FROM incoming)",
    [JSON.stringify(units), now],
  );
}

/** What the units cache knows about one image URL — the media crawl's per-file "metadata service". */
export interface NpsImageMeta {
  credit?: string;
  /** The owning unit's nps.gov page — the human-visitable provenance a published photo links. */
  website?: string;
}

/**
 * Image metadata by URL, from the units cache. The crawl's NPS arm reads this where the Commons arm
 * calls the Commons API — the cache **is** the metadata service, which is what makes an NPS fetch
 * zero-network beyond the bytes themselves (and `--retry` re-derivable offline).
 */
export async function readNpsImageMeta(
  db: Querier,
  urls: readonly string[],
): Promise<Map<string, NpsImageMeta>> {
  const out = new Map<string, NpsImageMeta>();
  if (urls.length === 0) return out;
  const { rows } = await db.query(
    "SELECT img->>'url' AS url, img->>'credit' AS credit, u.website " +
      "FROM nps_units u, jsonb_array_elements(u.images) AS img " +
      "WHERE img->>'url' = ANY($1::text[])",
    [[...urls]],
  );
  for (const row of rows as { url: string; credit: string | null; website: string | null }[]) {
    out.set(row.url, {
      ...(row.credit ? { credit: row.credit } : {}),
      ...(row.website ? { website: row.website } : {}),
    });
  }
  return out;
}

/**
 * A staged record one of whose `wd:` ids may name a park unit — the NPS analogue of
 * {@link ArticleCandidate}, with the same copied-columns reasoning and the same deliberate absence of
 * upstream ids from the projection: the NPS record joins by naming this record, never by restating it.
 */
export interface NpsCandidate {
  source: string;
  sourceId: string;
  category: PlaceCategory;
  subcategory?: PlaceSubcategory;
  /** GeoJSON text, handed straight back to PostGIS. */
  point: string;
  hasDescription: boolean;
  /** The record's own `wd:` upstream ids — the caller maps them to a unit code. */
  wdIds: string[];
}

/**
 * Staged records carrying any of the given `wd:` ids, in a stable order.
 *
 * Unpaged, unlike {@link fetchArticleCandidates}: the id list is the concordance's P4083 population
 * (~500 entities nationally), so the overlap can't outgrow the parks system — the GIN index answers it
 * in one read. `source <> $2` keeps a projected record from becoming its own candidate on a re-run.
 */
export async function fetchNpsCandidates(
  db: Querier,
  wdIds: readonly string[],
): Promise<NpsCandidate[]> {
  if (wdIds.length === 0) return [];
  const { rows } = await db.query(
    "SELECT s.source, s.source_id, s.category, s.subcategory, " +
      "ST_AsGeoJSON(s.point) AS point, s.description IS NOT NULL AS has_description, " +
      "array(SELECT u FROM unnest(s.upstream_ids) AS u WHERE u LIKE 'wd:%' ORDER BY u) AS wd_ids " +
      "FROM source_records s " +
      "WHERE s.source <> $2 AND s.upstream_ids && $1::text[] " +
      "ORDER BY s.source, s.source_id",
    [[...wdIds], NPS_SOURCE],
  );
  return (rows as NpsCandidateRaw[]).map((row) => ({
    source: row.source,
    sourceId: row.source_id,
    category: row.category as PlaceCategory,
    ...(row.subcategory ? { subcategory: row.subcategory as PlaceSubcategory } : {}),
    point: row.point,
    hasDescription: row.has_description,
    wdIds: row.wd_ids,
  }));
}

interface NpsCandidateRaw {
  source: string;
  source_id: string;
  category: string;
  subcategory: string | null;
  point: string;
  has_description: boolean;
  wd_ids: string[];
}

// ── the RIDB source ───────────────────────────────────────────────────────────────────────────────

export const RIDB_SOURCE: SourceId = "ridb";

/** One image RIDB lists for a facility, as the cache stores it (`ridb_facilities.images`). */
export interface RidbImage {
  url: string;
  title?: string;
  /** The per-image `Credits` line ("USFS", a named individual, a partner org — or nothing). */
  credit?: string;
}

/** One facility as the API described it, keyed by its `FacilityID`. */
export interface RidbFacility {
  facilityId: string;
  name: string;
  /** `FacilityDescription`, already stripped of its HTML — the cache never stores markup. */
  description?: string;
  /** `FacilityTypeDescription`, e.g. "Campground". */
  type?: string;
  /** The managing organization's display name ("USDA Forest Service") — the description credit's author. */
  org?: string;
  /** The managing `OrgID` — the federal gate's key ({@link https://ridb.recreation.gov} orgs table). */
  orgId?: string;
  /** The facility's canonical recreation.gov page — staged as `website`, and the credit's `sourceUrl`.
   *  Required: `facilityOf` always derives it from the id, so an optional here would only breed
   *  dead `??` fallbacks at the use sites. */
  website: string;
  images: RidbImage[];
}

/**
 * **Replace** the candidate-facility snapshot — `writeNpsUnits`' semantics, and they hold for the same
 * reason even though this cache is not the whole corpus: every run fetches every facility the current
 * candidates name, so the batch IS the population, and a facility no candidate names any more must
 * drop out or the crawl would keep serving a stale credit for it.
 */
export async function writeRidbFacilities(
  db: Querier,
  facilities: readonly RidbFacility[],
  now: string,
): Promise<void> {
  if (facilities.length === 0) return;
  await db.query(
    "WITH incoming AS (" +
      "INSERT INTO ridb_facilities (facility_id, name, description, type, org, org_id, website, images, fetched_at) " +
      'SELECT r."facilityId", r.name, r.description, r.type, r.org, r."orgId", r.website, ' +
      "COALESCE(r.images, '[]'::jsonb), $2::timestamptz " +
      "FROM jsonb_to_recordset($1::jsonb) AS r(" +
      '"facilityId" text, name text, description text, type text, org text, "orgId" text, ' +
      "website text, images jsonb) " +
      "ON CONFLICT (facility_id) DO UPDATE SET name = EXCLUDED.name, " +
      "description = EXCLUDED.description, type = EXCLUDED.type, org = EXCLUDED.org, " +
      "org_id = EXCLUDED.org_id, website = EXCLUDED.website, images = EXCLUDED.images, " +
      "fetched_at = EXCLUDED.fetched_at " +
      "RETURNING facility_id) " +
      "DELETE FROM ridb_facilities WHERE facility_id NOT IN (SELECT facility_id FROM incoming)",
    [JSON.stringify(facilities), now],
  );
}

/** What the facilities cache knows about one image URL — the crawl's RIDB metadata service. */
export interface RidbImageMeta {
  credit?: string;
  /** The owning facility's recreation.gov page — the human-visitable provenance a published photo links. */
  website?: string;
}

/**
 * Image metadata by URL, from the facilities cache — `readNpsImageMeta`'s sibling: the cache is the
 * metadata service, so an RIDB fetch is zero-network beyond the bytes and `--retry` re-gates offline.
 */
export async function readRidbImageMeta(
  db: Querier,
  urls: readonly string[],
): Promise<Map<string, RidbImageMeta>> {
  const out = new Map<string, RidbImageMeta>();
  if (urls.length === 0) return out;
  const { rows } = await db.query(
    "SELECT img->>'url' AS url, img->>'credit' AS credit, f.website " +
      "FROM ridb_facilities f, jsonb_array_elements(f.images) AS img " +
      "WHERE img->>'url' = ANY($1::text[])",
    [[...urls]],
  );
  for (const row of rows as { url: string; credit: string | null; website: string | null }[]) {
    out.set(row.url, {
      ...(row.credit ? { credit: row.credit } : {}),
      ...(row.website ? { website: row.website } : {}),
    });
  }
  return out;
}

/**
 * A staged record that may name an RIDB facility — {@link NpsCandidate} plus the record's own
 * `website`, because this source has **two** joins and the second is the mapper's: a `website=` tag
 * pointing at a recreation.gov campground page names the facility as directly as a `wikipedia=` tag
 * names an article. The caller extracts the id from either side.
 */
export interface RidbCandidate {
  source: string;
  sourceId: string;
  category: PlaceCategory;
  subcategory?: PlaceSubcategory;
  /** GeoJSON text, handed straight back to PostGIS. */
  point: string;
  hasDescription: boolean;
  /** The record's own `website`, when it has one — the mapper-side join. */
  website?: string;
  /** The record's own `wd:` upstream ids — the Wikidata-side join. */
  wdIds: string[];
}

/**
 * The mapper-side join pattern: a `website` naming a recreation.gov campground page, with the
 * facility id as its one capture group. **The single source of three spellings** — the JS extractor
 * (`facilityIdFromWebsite` compiles it), the candidate query's predicate, and the partial index's
 * predicate in `ensureSchema` — because the last two must be **byte-identical** for the planner to
 * prove the query implies the index, and the first two drifting apart would shrink the join with no
 * report signal. Valid in both JS regex and POSIX ARE syntax, and quote-free, so it can embed in a
 * SQL literal.
 */
export const RIDB_CAMPGROUND_PATTERN = "recreation\\.gov/camping/campgrounds/(\\d+)";

/** The shared pattern as a SQL predicate on a `website` column reference. */
const ridbWebsiteSql = (column: string): string => `${column} ~ '${RIDB_CAMPGROUND_PATTERN}'`;

/**
 * Staged records that could join a facility through either side — the union of the website match and
 * the `wd:` overlap ({@link fetchNpsCandidates}' scale reasoning: both populations are bounded by
 * the joins themselves, ~150 records, not by the corpus). The website arm rides the partial index
 * `ensureSchema` declares from the same pattern; without it this predicate is a 226k-row seq scan
 * every run (measured: 52k buffers vs 161 with the index).
 */
export async function fetchRidbCandidates(
  db: Querier,
  wdIds: readonly string[],
): Promise<RidbCandidate[]> {
  const { rows } = await db.query(
    "SELECT s.source, s.source_id, s.category, s.subcategory, s.website, " +
      "ST_AsGeoJSON(s.point) AS point, s.description IS NOT NULL AS has_description, " +
      "array(SELECT u FROM unnest(s.upstream_ids) AS u WHERE u LIKE 'wd:%' ORDER BY u) AS wd_ids " +
      "FROM source_records s " +
      `WHERE s.source <> $2 AND (${ridbWebsiteSql("s.website")} OR s.upstream_ids && $1::text[]) ` +
      "ORDER BY s.source, s.source_id",
    [[...wdIds], RIDB_SOURCE],
  );
  return (rows as RidbCandidateRaw[]).map((row) => ({
    source: row.source,
    sourceId: row.source_id,
    category: row.category as PlaceCategory,
    ...(row.subcategory ? { subcategory: row.subcategory as PlaceSubcategory } : {}),
    ...(row.website ? { website: row.website } : {}),
    point: row.point,
    hasDescription: row.has_description,
    wdIds: row.wd_ids,
  }));
}

interface RidbCandidateRaw extends NpsCandidateRaw {
  website: string | null;
}

// ── the Commons geo source ────────────────────────────────────────────────────────────────────────

/**
 * The media namespace and the geo source share one id on purpose: a record staged by the containment
 * join asserts nothing but "Wikimedia Commons offers these photos here", and Commons is already the
 * declared media source every such photo publishes under. A separate field-source id would need terms
 * of its own saying exactly what `SOURCE_TERMS.commons` already says.
 */
export const COMMONS_SOURCE: SourceId = "commons";

/** Empty the geo index for a fresh dump load. The gist index goes too — loading under it is ~3× slower. */
export async function clearCommonsGeoTags(db: Querier): Promise<void> {
  await db.query("DROP INDEX IF EXISTS commons_geo_tags_point_idx");
  await db.query("TRUNCATE commons_geo_tags");
}

/** One parsed dump row the loader keeps. */
export interface GeoTagRow {
  pageId: number;
  isPrimary: boolean;
  lat: number;
  lon: number;
}

/** Append one batch of dump rows — `unnest` arrays, the batched-write idiom of this file. */
export async function writeCommonsGeoTags(db: Querier, rows: readonly GeoTagRow[]): Promise<void> {
  if (rows.length === 0) return;
  await db.query(
    "INSERT INTO commons_geo_tags (page_id, is_primary, point) " +
      "SELECT p, pr, ST_SetSRID(ST_MakePoint(lon, lat), 4326) " +
      "FROM unnest($1::bigint[], $2::boolean[], $3::float8[], $4::float8[]) AS t(p, pr, lon, lat)",
    [
      rows.map((r) => r.pageId),
      rows.map((r) => r.isPrimary),
      rows.map((r) => r.lon),
      rows.map((r) => r.lat),
    ],
  );
}

/** Rebuild the gist index after a load, and ANALYZE so the containment join plans on real stats. */
export async function finishCommonsGeoTags(db: Querier): Promise<void> {
  await db.query(
    "CREATE INDEX IF NOT EXISTS commons_geo_tags_point_idx ON commons_geo_tags USING gist (point)",
  );
  await db.query("ANALYZE commons_geo_tags");
}

/**
 * The polygon-candidate policy, spelled **once** and shared by the walk and the report's honesty
 * count — the `RIDB_CAMPGROUND_PATTERN` lesson: two spellings of one selection policy drift silently,
 * and here the drift would make the report claim an exclusion the join didn't apply. Both fragments
 * bind the same positional parameters everywhere they appear: `$1` = the derived source to exclude,
 * `$2` = the excluded category, `$3` = the area cap.
 */
const geoPolygonSql = (t: string): string =>
  `${t}.source <> $1 AND ${t}.category <> $2 AND ${t}.geometry IS NOT NULL ` +
  `AND ST_Dimension(${t}.geometry) = 2`;
const geoAreaSql = (t: string): string => `ST_Area(${t}.geometry::geography) <= $3`;

/** How many otherwise-qualifying polygons the area cap excludes — the report's honesty line. */
export async function overCapPolygons(
  db: Querier,
  opts: { excludeCategory: string; areaCapM2: number },
): Promise<number> {
  const { rows } = await db.query(
    `SELECT count(*) AS over_cap FROM source_records s WHERE ${geoPolygonSql("s")} ` +
      `AND NOT ${geoAreaSql("s")}`,
    [COMMONS_SOURCE, opts.excludeCategory, opts.areaCapM2],
  );
  return Number((rows as { over_cap: string }[])[0]?.over_cap ?? 0);
}

/** One polygon candidate with the geotagged files inside it (none, for most). */
export interface GeoCandidate {
  source: string;
  sourceId: string;
  category: PlaceCategory;
  subcategory?: PlaceSubcategory;
  /** GeoJSON text, handed straight back to PostGIS. */
  point: string;
  /** Files whose dump coordinate falls inside this record's geometry, nearest-first. */
  hits: GeoHit[];
}

/** One contained file coordinate. */
export interface GeoHit {
  pageId: number;
  /** False is an {@link https://commons.wikimedia.org/wiki/Template:Object_location Object location} —
   *  an explicit claim about the *subject*, which outranks a camera position at pick time. */
  isPrimary: boolean;
  /** Metres from the record's representative point. */
  distM: number;
}

/**
 * One page of the containment join: polygon candidates in keyset order, each with the geotagged files
 * inside it.
 *
 * The polygon predicate ({@link geoPolygonSql} + {@link geoAreaSql}) is the whole selection policy:
 * no derived records ({@link COMMONS_SOURCE}), no `surveillance` (`apps/atlas/doc/spec/sources.md`
 * §3's category exclusion — never searched, never claimed), areas only, and nothing above the area
 * cap — past ~2 km² "inside the polygon" stops meaning "a photo of the place" and starts meaning "a
 * photo somewhere in a district".
 *
 * LEFT LATERAL, for `fetchEntityMediaRefs`' cursor reason: most polygons contain nothing, and a cursor
 * advanced only by rows with hits would stall on the first empty page. The per-polygon hit cap bounds
 * the transfer under a campus-sized polygon in a photographed city.
 */
export async function fetchGeoCandidates(
  db: Querier,
  opts: {
    limit: number;
    after?: RecordRef;
    excludeCategory: string;
    areaCapM2: number;
    hitCap: number;
  },
): Promise<GeoCandidate[]> {
  const { rows } = await db.query(
    "WITH polys AS (" +
      "SELECT s.source, s.source_id, s.category, s.subcategory, s.point, s.geometry " +
      "FROM source_records s " +
      `WHERE ${geoPolygonSql("s")} AND ${geoAreaSql("s")} ` +
      "AND ($4::text IS NULL OR (s.source, s.source_id) > ($4, $5)) " +
      "ORDER BY s.source, s.source_id LIMIT $6) " +
      "SELECT p.source, p.source_id, p.category, p.subcategory, " +
      "ST_AsGeoJSON(p.point) AS point, g.page_id::text AS page_id, g.is_primary, g.dist_m " +
      "FROM polys p LEFT JOIN LATERAL (" +
      "SELECT gt.page_id, gt.is_primary, " +
      "round(ST_Distance(p.point::geography, gt.point::geography))::int AS dist_m " +
      "FROM commons_geo_tags gt WHERE ST_Contains(p.geometry, gt.point) " +
      "ORDER BY 3, gt.page_id LIMIT $7) g ON true " +
      "ORDER BY p.source, p.source_id, g.dist_m",
    [
      COMMONS_SOURCE,
      opts.excludeCategory,
      opts.areaCapM2,
      opts.after?.source ?? null,
      opts.after?.sourceId ?? null,
      opts.limit,
      opts.hitCap,
    ],
  );
  const out: GeoCandidate[] = [];
  for (const row of rows as GeoCandidateRaw[]) {
    // Adjacent-row grouping, `fetchEntityRecords`' idiom.
    let candidate = out[out.length - 1];
    if (!candidate || candidate.source !== row.source || candidate.sourceId !== row.source_id) {
      candidate = {
        source: row.source,
        sourceId: row.source_id,
        category: row.category as PlaceCategory,
        ...(row.subcategory ? { subcategory: row.subcategory as PlaceSubcategory } : {}),
        point: row.point,
        hits: [],
      };
      out.push(candidate);
    }
    if (row.page_id !== null && row.is_primary !== null && row.dist_m !== null) {
      candidate.hits.push({
        pageId: Number(row.page_id),
        isPrimary: row.is_primary,
        distM: row.dist_m,
      });
    }
  }
  return out;
}

interface GeoCandidateRaw {
  source: string;
  source_id: string;
  category: string;
  subcategory: string | null;
  point: string;
  page_id: string | null;
  is_primary: boolean | null;
  dist_m: number | null;
}

/** A resolved Commons page id — three-state, on the `wiki_articles` convention. */
export interface GeoPageRow {
  pageId: number;
  /** The `File:` title; absent when {@link absent}. */
  title?: string;
  /** Deleted since the dump, or not a File-namespace page — terminal either way. */
  absent: boolean;
}

/** What is already known about these page ids, so a run asks about none of them twice. */
export async function readGeoPages(
  db: Querier,
  pageIds: readonly number[],
): Promise<Map<number, GeoPageRow>> {
  const out = new Map<number, GeoPageRow>();
  if (pageIds.length === 0) return out;
  const { rows } = await db.query(
    "SELECT page_id::text AS page_id, title, absent FROM commons_geo_pages " +
      "WHERE page_id = ANY($1::bigint[])",
    [[...pageIds]],
  );
  for (const row of rows as { page_id: string; title: string | null; absent: boolean }[]) {
    const pageId = Number(row.page_id);
    out.set(pageId, { pageId, absent: row.absent, ...(row.title ? { title: row.title } : {}) });
  }
  return out;
}

/** Record what Commons said about these page ids. An unanswered batch never reaches here. */
export async function writeGeoPages(
  db: Querier,
  rows: readonly GeoPageRow[],
  now: string,
): Promise<void> {
  if (rows.length === 0) return;
  await db.query(
    "INSERT INTO commons_geo_pages (page_id, title, absent, fetched_at) " +
      'SELECT r."pageId", r.title, r.absent, $2::timestamptz ' +
      'FROM jsonb_to_recordset($1::jsonb) AS r("pageId" bigint, title text, absent boolean) ' +
      "ON CONFLICT (page_id) DO UPDATE SET title = EXCLUDED.title, " +
      "absent = EXCLUDED.absent, fetched_at = EXCLUDED.fetched_at",
    [JSON.stringify(rows), now],
  );
}

/** One Commons category listing — three-state, on the `wiki_articles` convention. */
export interface CommonsCategoryRow {
  /** Canonical `Category:Name` form. */
  category: string;
  /** The category's `File:` members, as listed (first page, up to 500). */
  members: string[];
  /** No such category page **and** nothing filed under it. */
  absent: boolean;
}

/**
 * Every distinct Commons category the staged records reference — the population the category pass
 * resolves. Canonicalization happens in the caller (`commonsCategoryTitle`), not here: SQL holding a
 * second spelling of that rule is how the cache misses its own rows.
 */
export async function distinctCategoryRefs(db: Querier): Promise<string[]> {
  // Unordered on purpose: the caller sorts after canonicalization, which can reorder and merge keys.
  const { rows } = await db.query(
    "SELECT DISTINCT ref->>'value' AS category " +
      "FROM source_records, jsonb_array_elements(media_refs) AS ref " +
      "WHERE ref->>'kind' = 'commons-category'",
  );
  return (rows as { category: string }[]).map((row) => row.category);
}

/**
 * Which of these categories are already answered for — keys only. The caller is deciding what to
 * *ask*, and pulling every known listing's 500-title `members` to answer a set-membership question
 * is the kind of read the media crawl's index actually needs and this one does not.
 */
export async function knownCategories(
  db: Querier,
  categories: readonly string[],
): Promise<Set<string>> {
  if (categories.length === 0) return new Set();
  const { rows } = await db.query(
    "SELECT category FROM commons_categories WHERE category = ANY($1::text[])",
    [[...categories]],
  );
  return new Set((rows as { category: string }[]).map((row) => row.category));
}

/** Every known listing — the media crawl's index; ≤ the referenced-category population in size. */
export async function readCommonsCategories(db: Querier): Promise<Map<string, CommonsCategoryRow>> {
  const out = new Map<string, CommonsCategoryRow>();
  const { rows } = await db.query(
    "SELECT category, members, absent FROM commons_categories ORDER BY category",
  );
  for (const row of rows as { category: string; members: string[]; absent: boolean }[]) {
    out.set(row.category, { category: row.category, members: row.members, absent: row.absent });
  }
  return out;
}

// ── the KartaView source ──────────────────────────────────────────────────────────────────────────

export const KARTAVIEW_SOURCE: SourceId = "kartaview";

/** One sequence as the sweep's listing pass records it. */
export interface KartaviewSequence {
  sequenceId: number;
  /** The storage host prefix (`storage1`) — the byte URL's subdomain. */
  storage: string;
  /** `countActivePhotos` at listing time — filter provenance (zero-photo sequences are never
   *  stored), not a promise the photos pass checks against. */
  photoCount: number;
}

/**
 * Upsert the listing. `photos_fetched` is deliberately NOT reset for a sequence already held: the
 * listing re-runs cheaply and must not un-do the slow half's progress. A sequence whose photo count
 * changed still keeps its mark — street sequences are effectively immutable uploads, and re-fetching
 * on a count wobble would turn every re-sweep into the full slow pass.
 */
export async function writeKartaviewSequences(
  db: Querier,
  rows: readonly KartaviewSequence[],
  now: string,
): Promise<void> {
  if (rows.length === 0) return;
  await db.query(
    "INSERT INTO kartaview_sequences (sequence_id, storage, photo_count, photos_fetched, fetched_at) " +
      'SELECT r."sequenceId", r.storage, r."photoCount", false, $2::timestamptz ' +
      'FROM jsonb_to_recordset($1::jsonb) AS r("sequenceId" bigint, storage text, "photoCount" int) ' +
      "ON CONFLICT (sequence_id) DO UPDATE SET storage = EXCLUDED.storage, " +
      "photo_count = EXCLUDED.photo_count, fetched_at = EXCLUDED.fetched_at",
    [JSON.stringify(rows), now],
  );
}

/** Sequences whose photos are not yet held, oldest-listed first — the slow pass's work queue. */
export async function unfetchedKartaviewSequences(
  db: Querier,
  limit: number,
): Promise<Pick<KartaviewSequence, "sequenceId" | "storage">[]> {
  const { rows } = await db.query(
    "SELECT sequence_id::text AS sequence_id, storage FROM kartaview_sequences " +
      "WHERE NOT photos_fetched ORDER BY sequence_id LIMIT $1",
    // `LIMIT NULL` is SQL for "no limit" — the no-budget default arrives as Infinity.
    [Number.isFinite(limit) ? limit : null],
  );
  return (rows as { sequence_id: string; storage: string }[]).map((row) => ({
    sequenceId: Number(row.sequence_id),
    storage: row.storage,
  }));
}

/** How the sweep stands — for the report, and for knowing a partial `--limit` run left work. */
export async function kartaviewSweepStats(
  db: Querier,
): Promise<{ sequences: number; fetched: number; photos: number }> {
  const { rows } = await db.query(
    "SELECT (SELECT count(*) FROM kartaview_sequences) AS sequences, " +
      "(SELECT count(*) FROM kartaview_sequences WHERE photos_fetched) AS fetched, " +
      "(SELECT count(*) FROM kartaview_photos) AS photos",
  );
  const row = (rows as { sequences: string; fetched: string; photos: string }[])[0];
  return {
    sequences: Number(row?.sequences ?? 0),
    fetched: Number(row?.fetched ?? 0),
    photos: Number(row?.photos ?? 0),
  };
}

/** One catalog photo. */
export interface KartaviewPhoto {
  photoId: number;
  sequenceId: number;
  /** Position in the sequence — the human details page (`/details/{seq}/{index}`) is addressed by it. */
  sequenceIndex?: number;
  lat: number;
  lon: number;
  /** Camera bearing in degrees, when the device recorded one. No heading, no aim gate, no pick. */
  heading?: number;
  /** The full byte URL — the blurred processed file on the sequence's storage host. */
  url: string;
}

/** Write one sequence's photos and mark it held — one transaction-free pair, photos first, so an
 *  interruption between the two re-fetches the sequence rather than losing it. */
export async function writeKartaviewPhotos(
  db: Querier,
  sequenceId: number,
  rows: readonly KartaviewPhoto[],
  now: string,
): Promise<void> {
  if (rows.length > 0) {
    await db.query(
      "INSERT INTO kartaview_photos (photo_id, sequence_id, sequence_index, point, heading, url) " +
        'SELECT r."photoId", r."sequenceId", r."sequenceIndex", ' +
        "ST_SetSRID(ST_MakePoint(r.lon, r.lat), 4326), r.heading, r.url " +
        'FROM jsonb_to_recordset($1::jsonb) AS r("photoId" bigint, "sequenceId" bigint, ' +
        '"sequenceIndex" int, lat float8, lon float8, heading float8, url text) ' +
        "ON CONFLICT (photo_id) DO UPDATE SET sequence_id = EXCLUDED.sequence_id, " +
        "sequence_index = EXCLUDED.sequence_index, point = EXCLUDED.point, " +
        "heading = EXCLUDED.heading, url = EXCLUDED.url",
      [JSON.stringify(rows)],
    );
  }
  await db.query(
    "UPDATE kartaview_sequences SET photos_fetched = true, fetched_at = $2::timestamptz " +
      "WHERE sequence_id = $1",
    [sequenceId, now],
  );
}

/**
 * The distinct 1° cells that contain primary staged records — the tiles a street sweep lists.
 *
 * Cells, not the bounding box: the us-west extent is one-third Pacific Ocean, and KartaView's bbox
 * query *times out on empty regions* (measured — proving absence full-scans their table, at any bbox
 * size). Listing only where places exist never asks about the ocean, and skips the empty interior
 * cells a rectangle would sweep for nothing.
 */
export async function stagedCells(db: Querier): Promise<{ south: number; west: number }[]> {
  const { rows } = await db.query(
    "SELECT DISTINCT floor(ST_Y(point))::int AS south, floor(ST_X(point))::int AS west " +
      "FROM source_records WHERE derived_from_source IS NULL ORDER BY 1, 2",
  );
  return (rows as { south: number; west: number }[]).map((row) => ({
    south: row.south,
    west: row.west,
  }));
}

/** What the catalog knows about one byte URL — the crawl's KartaView metadata service. */
export interface KartaviewImageMeta {
  sequenceId: number;
  sequenceIndex?: number;
}

/** Image metadata by URL — `readRidbImageMeta`'s sibling: catalog-backed, zero network on `--retry`. */
export async function readKartaviewImageMeta(
  db: Querier,
  urls: readonly string[],
): Promise<Map<string, KartaviewImageMeta>> {
  const out = new Map<string, KartaviewImageMeta>();
  if (urls.length === 0) return out;
  const { rows } = await db.query(
    "SELECT url, sequence_id::text AS sequence_id, sequence_index FROM kartaview_photos " +
      "WHERE url = ANY($1::text[])",
    [[...urls]],
  );
  for (const row of rows as { url: string; sequence_id: string; sequence_index: number | null }[]) {
    out.set(row.url, {
      sequenceId: Number(row.sequence_id),
      ...(row.sequence_index === null ? {} : { sequenceIndex: row.sequence_index }),
    });
  }
  return out;
}

/** One nearby catalog photo, as the aim gate judges it. */
export interface KartaviewHit {
  photoId: number;
  /** Metres from the record's representative point. */
  distM: number;
  /** Camera bearing; absent when the device recorded none — such a hit can never pass the gate. */
  heading?: number;
  /** Bearing from the camera to the place, degrees clockwise from north. */
  toPlace: number;
  url: string;
}

/** One primary staged record with the catalog photos near it (none, for most). */
export interface KartaviewCandidate {
  source: string;
  sourceId: string;
  category: PlaceCategory;
  subcategory?: PlaceSubcategory;
  /** GeoJSON text, handed straight back to PostGIS. */
  point: string;
  hits: KartaviewHit[];
}

/**
 * One page of the street join: primary records in keyset order, each with the catalog photos within
 * `radiusM` of its representative point.
 *
 * `derived_from_source IS NULL` is the self-exclusion this join needs where commons-geo's needed
 * only its own id: derived records carry their parent's *point* (copied verbatim), so every
 * enriched place would otherwise appear once per derived record and stage duplicate street refs.
 * `surveillance` is excluded per `apps/atlas/doc/spec/sources.md` §3's category rule. The bearing
 * math runs SQL-side (`ST_Azimuth`) because PostGIS already knows it; the *gate* stays in
 * TypeScript where it is a testable pure function.
 */
export async function fetchKartaviewCandidates(
  db: Querier,
  opts: {
    limit: number;
    after?: RecordRef;
    excludeCategory: string;
    radiusM: number;
    hitCap: number;
  },
): Promise<KartaviewCandidate[]> {
  const { rows } = await db.query(
    "WITH recs AS (" +
      "SELECT s.source, s.source_id, s.category, s.subcategory, s.point " +
      "FROM source_records s " +
      "WHERE s.derived_from_source IS NULL AND s.category <> $1 " +
      "AND ($2::text IS NULL OR (s.source, s.source_id) > ($2, $3)) " +
      "ORDER BY s.source, s.source_id LIMIT $4) " +
      "SELECT r.source, r.source_id, r.category, r.subcategory, " +
      "ST_AsGeoJSON(r.point) AS point, k.photo_id::text AS photo_id, k.dist_m, k.heading, " +
      "k.to_place, k.url " +
      "FROM recs r LEFT JOIN LATERAL (" +
      "SELECT p.photo_id, p.heading, p.url, " +
      "round(ST_Distance(r.point::geography, p.point::geography))::int AS dist_m, " +
      "round(degrees(ST_Azimuth(p.point, r.point)))::int AS to_place " +
      "FROM kartaview_photos p " +
      "WHERE ST_DWithin(r.point::geography, p.point::geography, $5) " +
      "ORDER BY 4, p.photo_id LIMIT $6) k ON true " +
      "ORDER BY r.source, r.source_id, k.dist_m",
    [
      opts.excludeCategory,
      opts.after?.source ?? null,
      opts.after?.sourceId ?? null,
      opts.limit,
      opts.radiusM,
      opts.hitCap,
    ],
  );
  const out: KartaviewCandidate[] = [];
  for (const row of rows as KartaviewCandidateRaw[]) {
    // Adjacent-row grouping, `fetchEntityRecords`' idiom.
    let candidate = out[out.length - 1];
    if (!candidate || candidate.source !== row.source || candidate.sourceId !== row.source_id) {
      candidate = {
        source: row.source,
        sourceId: row.source_id,
        category: row.category as PlaceCategory,
        ...(row.subcategory ? { subcategory: row.subcategory as PlaceSubcategory } : {}),
        point: row.point,
        hits: [],
      };
      out.push(candidate);
    }
    if (row.photo_id !== null && row.dist_m !== null && row.to_place !== null && row.url !== null) {
      candidate.hits.push({
        photoId: Number(row.photo_id),
        distM: row.dist_m,
        ...(row.heading === null ? {} : { heading: row.heading }),
        toPlace: row.to_place,
        url: row.url,
      });
    }
  }
  return out;
}

interface KartaviewCandidateRaw {
  source: string;
  source_id: string;
  category: string;
  subcategory: string | null;
  point: string;
  photo_id: string | null;
  dist_m: number | null;
  heading: number | null;
  to_place: number | null;
  url: string | null;
}

/** Record what Commons said about these categories. An unanswered category never reaches here. */
export async function writeCommonsCategories(
  db: Querier,
  rows: readonly CommonsCategoryRow[],
  now: string,
): Promise<void> {
  if (rows.length === 0) return;
  await db.query(
    "INSERT INTO commons_categories (category, members, absent, fetched_at) " +
      "SELECT r.category, r.members, r.absent, $2::timestamptz " +
      "FROM jsonb_to_recordset($1::jsonb) AS r(category text, members jsonb, absent boolean) " +
      "ON CONFLICT (category) DO UPDATE SET members = EXCLUDED.members, " +
      "absent = EXCLUDED.absent, fetched_at = EXCLUDED.fetched_at",
    [JSON.stringify(rows), now],
  );
}

/** One entity's media references, gathered from every record it holds. */
export interface EntityMediaRefs {
  entityId: string;
  refs: MediaRef[];
}

/** A page of entities, plus where the keyset got to. */
export interface MediaRefPage {
  entities: EntityMediaRefs[];
  /**
   * The last entity id in the page window — the next page's `after`. `undefined` means the input is
   * exhausted.
   *
   * **Not the last entity that had references.** 82.5% of entities carry none, so a cursor advanced by
   * returned rows would stall on the first page that filtered to empty. That is why the join below is a
   * LEFT join: every entity in the window yields a row, whether or not it has anything to fetch.
   */
  cursor?: string;
}

/**
 * A page of entities with the media references their records claimed — the **first reader** of
 * `media_refs`, which stage 1 has been writing since the beginning.
 *
 * Paged on `entity_id` with the whole-entity guarantee `fetchEntityRecords` explains: a place whose refs
 * split across pages would be ranked against half its candidates and publish the wrong photo.
 *
 * Deliberately not merged into `fetchEntityRecords`, whose docblock keeps media out for a reason
 * (`fields.ts`: "a merge that could see them could accidentally rank on them"). Ranking media is stage 4's
 * job and it needs `claimedBy`, which the field merge must never see.
 */
export async function fetchEntityMediaRefs(
  db: Querier,
  opts: { limit: number; after?: string },
): Promise<MediaRefPage> {
  const { rows } = await db.query(
    `WITH page AS (${ENTITY_KEYSET_PAGE}) ` +
      "SELECT p.entity_id, s.media_refs FROM page p " +
      "JOIN entity_members m ON m.entity_id = p.entity_id " +
      // LEFT, and the `media_refs` filter rides in the ON clause rather than a WHERE — see `cursor`.
      "LEFT JOIN source_records s ON s.source = m.source AND s.source_id = m.source_id " +
      "AND s.media_refs <> '[]'::jsonb " +
      "ORDER BY p.entity_id, m.source, m.source_id",
    [opts.limit, opts.after ?? null],
  );
  const entities: EntityMediaRefs[] = [];
  let cursor: string | undefined;
  for (const row of rows as { entity_id: string; media_refs: MediaRef[] | null }[]) {
    cursor = row.entity_id;
    if (!row.media_refs?.length) continue;
    const last = entities[entities.length - 1];
    if (last?.entityId === row.entity_id) last.refs.push(...row.media_refs);
    else entities.push({ entityId: row.entity_id, refs: [...row.media_refs] });
  }
  return { entities, ...(cursor !== undefined ? { cursor } : {}) };
}

/** What the crawl knows about one file. `state` is the four-way discriminator the DDL explains. */
export interface MediaFileRow {
  fileKey: string;
  source: string;
  state: "published" | "rejected" | "retryable";
  reason?: string;
  thumbHash?: string;
  fullHash?: string;
  bytes?: number;
  license?: string;
  licenseUrl?: string;
  author?: string;
  sourceUrl?: string;
  attempts: number;
  nextAttemptAt?: string;
}

interface MediaFileRaw {
  file_key: string;
  source: string;
  state: MediaFileRow["state"];
  reason: string | null;
  thumb_hash: string | null;
  full_hash: string | null;
  bytes: number | null;
  license: string | null;
  license_url: string | null;
  author: string | null;
  source_url: string | null;
  attempts: number;
  next_attempt_at: string | null;
}

const mediaFileRow = (row: MediaFileRaw): MediaFileRow => ({
  fileKey: row.file_key,
  source: row.source,
  state: row.state,
  attempts: row.attempts,
  ...(row.reason ? { reason: row.reason } : {}),
  ...(row.thumb_hash ? { thumbHash: row.thumb_hash } : {}),
  ...(row.full_hash ? { fullHash: row.full_hash } : {}),
  ...(row.bytes !== null ? { bytes: row.bytes } : {}),
  ...(row.license ? { license: row.license } : {}),
  ...(row.license_url ? { licenseUrl: row.license_url } : {}),
  ...(row.author ? { author: row.author } : {}),
  ...(row.source_url ? { sourceUrl: row.source_url } : {}),
  ...(row.next_attempt_at ? { nextAttemptAt: row.next_attempt_at } : {}),
});

/** What the crawl already knows about these file keys, so it asks about nothing twice. */
export async function readMediaFiles(
  db: Querier,
  fileKeys: readonly string[],
): Promise<Map<string, MediaFileRow>> {
  const out = new Map<string, MediaFileRow>();
  if (fileKeys.length === 0) return out;
  const { rows } = await db.query(
    "SELECT file_key, source, state, reason, thumb_hash, full_hash, bytes, license, " +
      "license_url, author, source_url, attempts, next_attempt_at::text FROM media_files " +
      "WHERE file_key = ANY($1::text[])",
    [[...fileKeys]],
  );
  for (const row of rows as MediaFileRaw[]) out.set(row.file_key, mediaFileRow(row));
  return out;
}

/**
 * Files a previous run left retryable and whose time has come, oldest first.
 *
 * The reason this stage can be run again rather than restarted: a 429 does not lose the file, it schedules
 * it. `--retry` reads this instead of walking entities, so picking up 300 deferred photos costs one indexed
 * read rather than a pass over 225k places.
 */
export async function fetchRetryableMedia(
  db: Querier,
  opts: { limit: number; now: string },
): Promise<MediaFileRow[]> {
  const { rows } = await db.query(
    "SELECT file_key, source, state, reason, thumb_hash, full_hash, bytes, license, " +
      "license_url, author, source_url, attempts, next_attempt_at::text FROM media_files " +
      "WHERE state = 'retryable' AND (next_attempt_at IS NULL OR next_attempt_at <= $1::timestamptz) " +
      "ORDER BY next_attempt_at NULLS FIRST, file_key" +
      (Number.isFinite(opts.limit) ? ` LIMIT ${Math.trunc(opts.limit)}` : ""),
    [opts.now],
  );
  return (rows as MediaFileRaw[]).map(mediaFileRow);
}

/**
 * Record what happened to each file — durable per batch, so an interrupted crawl keeps its work.
 *
 * A file that was never answered for reaches here as `retryable`, never as absent. Nothing in this stage
 * writes "no photo" on the strength of a fetch that did not complete.
 */
export async function writeMediaFiles(
  db: Querier,
  rows: readonly MediaFileRow[],
  now: string,
): Promise<void> {
  if (rows.length === 0) return;
  await db.query(
    "INSERT INTO media_files (file_key, source, state, reason, thumb_hash, full_hash, bytes, " +
      "license, license_url, author, source_url, attempts, next_attempt_at, fetched_at) " +
      'SELECT r."fileKey", r.source, r.state, r.reason, r."thumbHash", r."fullHash", r.bytes, ' +
      'r.license, r."licenseUrl", r.author, r."sourceUrl", r.attempts, ' +
      'r."nextAttemptAt"::timestamptz, $2::timestamptz ' +
      "FROM jsonb_to_recordset($1::jsonb) AS r(" +
      '"fileKey" text, source text, state text, reason text, "thumbHash" text, "fullHash" text, ' +
      'bytes int, license text, "licenseUrl" text, author text, "sourceUrl" text, attempts int, ' +
      '"nextAttemptAt" text) ' +
      "ON CONFLICT (file_key) DO UPDATE SET source = EXCLUDED.source, state = EXCLUDED.state, " +
      "reason = EXCLUDED.reason, thumb_hash = EXCLUDED.thumb_hash, full_hash = EXCLUDED.full_hash, " +
      "bytes = EXCLUDED.bytes, license = EXCLUDED.license, license_url = EXCLUDED.license_url, " +
      "author = EXCLUDED.author, source_url = EXCLUDED.source_url, attempts = EXCLUDED.attempts, " +
      "next_attempt_at = EXCLUDED.next_attempt_at, fetched_at = EXCLUDED.fetched_at",
    [JSON.stringify(rows), now],
  );
}

/**
 * Demote the `published` files behind these blob hashes back to `retryable` — their bytes are not on disk.
 *
 * **This pipeline's own rule, in mirror image.** Everywhere else the rule is never to record a give-up as a
 * fact; this is the other direction — never leave a *success* recorded once it has stopped being true.
 * `state = 'published'` asserts two things at once, "we resolved this file upstream" and "its bytes are here
 * at this hash", and only the first is durable: the build database lives in a container volume and the blobs
 * on a host bind mount, so one `rm -rf` parts them. `settled()` in the crawl believes the row without
 * looking, so those files became permanently unfetchable — the walk skips them and the retry ledger does not
 * hold them.
 *
 * `publish` is the only stage that reads blobs **and** holds the database, which is why it owns the repair.
 * `verify` reads and re-hashes every referenced blob too, and already reports the missing ones — but it takes
 * no `Querier` on purpose, because reading a volume the way a foreign consumer does is the property stage 6
 * exists to demonstrate.
 *
 * **Only `state`, `reason` and the schedule change.** The pair, `bytes` and the licence stay, because they
 * are what we learned from *upstream* and that is still true — the earlier cut cleared them, which threw away
 * a fact to express a different one and made a spurious demotion cost a full re-crawl instead of one UPDATE.
 * `attempts` is deliberately not incremented either: it bounds a file that keeps failing to fetch, and this
 * file failed at nothing. A `NULL` `next_attempt_at` makes it due immediately and sorts it first, so
 * `media --retry` takes it before anything merely deferred.
 *
 * It is **self-limiting**, which is worth knowing before reading publish's warning as a loop:
 * `fetchMergedPlaces` selects a place's photos through `f.state = 'published'`, so a demoted file stops
 * reaching a tile at all. Measured on the real build — 222 files demoted, 6 refetched — the next publish
 * reported nothing missing and carried exactly those 6. A one-time correction, not noise on every publish.
 */
export async function demoteMissingBlobs(
  db: Querier,
  hashes: readonly string[],
  now: string,
): Promise<number> {
  if (hashes.length === 0) return 0;
  // `RETURNING 1` and `rows.length`: `Querier` promises only `rows`, so `rowCount` would read as zero
  // against any fake. Not `pruneVanishedMembers`' `count(*)`-over-CTE, whose reason is that it can return
  // tens of thousands of rows — this set is bounded by the caller's hash array.
  //
  // `blob-missing` inline, like the five other `media_files.reason` values in `media.ts`. It is the one
  // reason no upstream produced, which is the point of naming it: an operator can tell "Commons refused us"
  // from "we lost the file".
  const { rows } = await db.query(
    "UPDATE media_files SET state = 'retryable', reason = 'blob-missing', " +
      "next_attempt_at = NULL, fetched_at = $2::timestamptz " +
      "WHERE state = 'published' AND (thumb_hash = ANY($1::text[]) OR full_hash = ANY($1::text[])) " +
      "RETURNING 1",
    [[...hashes], now],
  );
  return rows.length;
}

/** One place's ranked link to a file it publishes. */
export interface PlaceMediaLink {
  entityId: string;
  fileKey: string;
  rank: number;
}

/**
 * Replace the media links for exactly the entities named, leaving every other entity untouched.
 *
 * Delete-then-insert per entity rather than an upsert: a re-run whose ranking changed, or where a file
 * became `rejected`, must be able to *remove* a link. An upsert alone would leave a withdrawn photo
 * attached to the place forever.
 */
export async function writePlaceMedia(
  db: Querier,
  entityIds: readonly string[],
  links: readonly PlaceMediaLink[],
): Promise<void> {
  if (entityIds.length === 0) return;
  await db.query("DELETE FROM place_media WHERE entity_id = ANY($1::text[])", [[...entityIds]]);
  if (links.length === 0) return;
  await db.query(
    "INSERT INTO place_media (entity_id, file_key, rank) " +
      'SELECT r."entityId", r."fileKey", r.rank FROM jsonb_to_recordset($1::jsonb) ' +
      'AS r("entityId" text, "fileKey" text, rank int)',
    [JSON.stringify(links)],
  );
}

/**
 * Whether a linked photo actually publishes: the crawl resolved it **and** no reviewer refused it.
 *
 * Spelled once and shared by every site that decides what ships or reports what shipped — the
 * `geoPolygonSql` lesson, and here the drift would be worse than a wrong number: the coverage report
 * would claim photos the volume does not carry. `f`/`pm` are the `media_files`/`place_media` aliases.
 *
 * Both scopes in one predicate because both are the same question from the file's side: a global
 * `reject` names no entity and kills the file everywhere; an `unlink` names one place and leaves the
 * file publishing wherever else it is used.
 */
const MEDIA_PUBLISHABLE_SQL =
  "f.state = 'published' AND NOT EXISTS (SELECT 1 FROM media_decisions d " +
  "WHERE d.file_key = f.file_key AND (" +
  "(d.verdict = 'reject' AND d.entity_id IS NULL) OR " +
  "(d.verdict = 'unlink' AND d.entity_id = pm.entity_id)))";

/**
 * Whether a merged place ships at all — false once a reviewer removed it. `m` is the
 * `merged_places` alias (or the table name, in the read that cannot alias it).
 */
const placePublishableSql = (m: string): string =>
  `NOT EXISTS (SELECT 1 FROM place_decisions pd WHERE pd.entity_id = ${m}.entity_id ` +
  "AND pd.verdict = 'remove')";

/**
 * How many places end up with at least one publishable photo.
 *
 * Joined to `media_files`, not a bare count of `place_media`: the crawl links every file it resolved so a
 * later `--retry` needs no re-linking, so a link alone does not mean a photo. Publish's own read applies
 * the same filter — this number and the volume agree because both ask the same question.
 */
export async function placesWithMedia(db: Querier): Promise<number> {
  const { rows } = await db.query(
    "SELECT count(DISTINCT pm.entity_id)::int AS n FROM place_media pm " +
      `JOIN media_files f ON f.file_key = pm.file_key WHERE ${MEDIA_PUBLISHABLE_SQL} ` +
      // Both halves of the media report must agree about a removed place, or the headline counts a
      // place the per-category table below does not.
      `AND ${placePublishableSql("pm")}`,
  );
  return (rows as { n: number }[])[0]?.n ?? 0;
}

/**
 * Photo coverage **per category** — the number `sources.md` calls "the metric that tells you which
 * source to add next", and the one `apps/atlas/doc/spec/sources.md` §6 asks every stage to report.
 *
 * A single global percentage is exactly what `apps/atlas/doc/spec/sources.md` §6 warns about: it
 * hides a working park pipeline behind a broken `community` one. Computed here rather than
 * accumulated in the crawl because it is a property of the whole dataset, not of the pages one run
 * happened to walk.
 */
export async function mediaCoverageByCategory(
  db: Querier,
): Promise<{ category: string; places: number; withMedia: number }[]> {
  const { rows } = await db.query(
    "SELECT m.fields->>'category' AS category, count(*)::int AS places, " +
      "count(pm.entity_id)::int AS with_media FROM merged_places m " +
      // Same publishable-only filter as `placesWithMedia`, for the same reason.
      "LEFT JOIN (SELECT DISTINCT pm.entity_id FROM place_media pm " +
      `JOIN media_files f ON f.file_key = pm.file_key WHERE ${MEDIA_PUBLISHABLE_SQL}) pm ` +
      "ON pm.entity_id = m.entity_id " +
      // A removed place is not a coverage gap — it is not a place this dataset has at all.
      `WHERE ${placePublishableSql("m")} ` +
      "GROUP BY 1 ORDER BY 1",
  );
  return (rows as { category: string | null; places: number; with_media: number }[]).map((row) => ({
    category: row.category ?? "(none)",
    places: row.places,
    withMedia: row.with_media,
  }));
}

/**
 * What one published file contributes to a tile — the bytes' addresses plus the credit to publish alongside.
 *
 * Here rather than in `media.ts` because it is a shape of the read that `publish` performs, and declaring it
 * beside the crawl would make `store.ts` import the stage that imports it.
 */
export interface PublishedMedia {
  thumbHash: string;
  fullHash: string;
  bytes: number;
  license: string;
  licenseUrl?: string;
  author?: string;
  sourceUrl?: string;
  source: string;
}

/**
 * One row of `merged_places` — stage 3's answer for one place, and exactly what stage 5 reads back.
 *
 * **One type for both directions.** They were written out separately and were identical field for field,
 * which is a trap rather than mere duplication: the `jsonb` round trip erases any disagreement, so when
 * stage 4 adds `media` the write side and the read side would both compile and the field would simply
 * never reach a tile.
 *
 * That hazard is now discharged rather than merely noted: stage 4's photos arrive as a **joined column**
 * (`media` below), not as a key inside `fields`, so they cannot be written by accident or silently absent.
 */
export interface MergedPlaceRow {
  entityId: string;
  cell: string;
  fields: MergedFields;
  sources: string[];
  /** GeoJSON text; stored as geometry so stage 6 can ask PostGIS whether it really is in its cell. */
  point: string;
  geometry?: string;
  /**
   * Stage 4's photos, in rank order — **joined on the read, never stored in `fields`**.
   *
   * Deliberately not part of the `fields` jsonb, which is the trap the docblock above this type warns
   * about: the round trip erases any write/read disagreement, so a `media` key added there would compile on
   * both sides and simply never reach a tile. Being a joined column instead means it cannot be written by
   * accident and cannot be silently absent.
   */
  media?: PublishedMedia[];
}

/** The read direction's name for {@link MergedPlaceRow}, kept because `publish` reads rather than writes. */
export type PublishablePlace = MergedPlaceRow;

/**
 * Upsert a page of merged places — one statement, the page as one `jsonb` parameter.
 *
 * Upsert rather than insert-after-truncate so an interrupted run keeps its work and a re-run is
 * idempotent. Stale rows are not a concern the way they are for entities: a place whose members all
 * vanished is caught by `publish`'s completeness check, which compares this table against the entities
 * that still hold members.
 */
export async function writeMergedPlaces(
  db: Querier,
  places: readonly MergedPlaceRow[],
  now: string,
): Promise<void> {
  if (places.length === 0) return;
  await db.query(
    "INSERT INTO merged_places (entity_id, cell, fields, sources, point, geometry, merged_at) " +
      'SELECT r."entityId", r.cell, r.fields, r.sources, ' +
      "ST_SetSRID(ST_GeomFromGeoJSON(r.point), 4326), " +
      "CASE WHEN r.geometry IS NULL THEN NULL " +
      "ELSE ST_SetSRID(ST_GeomFromGeoJSON(r.geometry), 4326) END, $2::timestamptz " +
      "FROM jsonb_to_recordset($1::jsonb) AS r(" +
      '"entityId" text, cell text, fields jsonb, sources text[], point text, geometry text) ' +
      "ON CONFLICT (entity_id) DO UPDATE SET cell = EXCLUDED.cell, fields = EXCLUDED.fields, " +
      "sources = EXCLUDED.sources, point = EXCLUDED.point, geometry = EXCLUDED.geometry, " +
      "merged_at = EXCLUDED.merged_at",
    [JSON.stringify(places), now],
  );
}

/**
 * How many places the merge should have produced, and how many it has — `publish`'s completeness gate.
 *
 * Both numbers in one round trip because they are only meaningful together: "225,084 merged" says nothing
 * without "225,084 expected", and publishing on a shortfall emits a volume missing places that stage 6
 * would then read as **vanished**, which is the one assertion that must fail a build.
 */
export async function mergeCoverage(db: Querier): Promise<{ expected: number; merged: number }> {
  const { rows } = await db.query(
    "SELECT (SELECT count(DISTINCT entity_id) FROM entity_members)::int AS expected, " +
      "(SELECT count(*) FROM merged_places)::int AS merged",
  );
  const row = (rows as { expected: number; merged: number }[])[0];
  return { expected: row?.expected ?? 0, merged: row?.merged ?? 0 };
}

/**
 * A page of merged places in **cell-major** order, keyset-paged on `(cell, entity_id)`.
 *
 * Cell-major so `publish` can finish one tile before opening the next and never hold the whole dataset:
 * 225k places carrying descriptions is hundreds of megabytes, where one tile is a few dozen records.
 *
 * The upstream ids and aliases each place needs are **not** joined here on purpose. Keyset paging would
 * re-run those aggregations once per page — the mistake `readPriorEntities` already documents — so they
 * are read once for every entity instead, which is cheap because they are ids and nothing else.
 */
export async function fetchMergedPlaces(
  db: Querier,
  opts: { limit: number; after?: { cell: string; entityId: string } },
): Promise<PublishablePlace[]> {
  const { rows } = await db.query(
    "SELECT entity_id, cell, fields, sources, ST_AsGeoJSON(point) AS point, " +
      "ST_AsGeoJSON(geometry) AS geometry, " +
      // Stage 4's photos, aggregated per place in rank order. A lateral rather than a join so one place's
      // several photos cannot multiply its row and quietly publish it several times — the same reason
      // `fetchEntityRecords` chooses its page by a CTE over distinct ids.
      "(SELECT jsonb_agg(jsonb_build_object(" +
      "'thumbHash', f.thumb_hash, 'fullHash', f.full_hash, 'bytes', f.bytes, " +
      "'license', f.license, 'licenseUrl', f.license_url, 'author', f.author, " +
      "'sourceUrl', f.source_url, 'source', f.source) ORDER BY pm.rank) " +
      "FROM place_media pm JOIN media_files f ON f.file_key = pm.file_key " +
      `WHERE pm.entity_id = merged_places.entity_id AND ${MEDIA_PUBLISHABLE_SQL} ` +
      // A pair or nothing, and a licence or nothing — the two things `volume-format.md` cannot publish
      // half of. Enforced here because this read *is* what reaches a tile; a guard anywhere else would be
      // a claim about a path publish does not take.
      "AND f.thumb_hash IS NOT NULL AND f.full_hash IS NOT NULL AND f.license IS NOT NULL) AS media " +
      "FROM merged_places " +
      // The row-comparison form is what a multicolumn btree wants, and `EXPLAIN ANALYZE` confirms an index
      // scan on `merged_places_cell_idx` (10.9 ms mid-dataset, 1.5 s for all 113 pages). The
      // `$2 IS NULL OR` wrapper is free **only because node-postgres sends unnamed one-shot statements**,
      // so the planner folds it against real parameter values. Under a truly generic plan it degrades to a
      // filter — measured 105 ms per page and quadratic in the dataset. Do not add statement caching here
      // without re-measuring.
      "WHERE ($2::text IS NULL OR (cell, entity_id) > ($2::text, $3::text)) " +
      // A reviewer's removal, applied where publication is decided. Safe against the caller's
      // "a short page means exhausted" break: `LIMIT` applies AFTER the filter, so a page is short
      // only when no matching place is left, and the cursor advances past the last MATCH.
      `AND ${placePublishableSql("merged_places")} ` +
      "ORDER BY cell, entity_id LIMIT $1",
    [opts.limit, opts.after?.cell ?? null, opts.after?.entityId ?? null],
  );
  return (rows as PublishableRow[]).map((row) => ({
    entityId: row.entity_id,
    cell: row.cell,
    fields: row.fields,
    sources: row.sources ?? [],
    point: row.point,
    ...(row.geometry ? { geometry: row.geometry } : {}),
    // `jsonb_agg` yields NULL, not `[]`, when a place has no photos — and absent is what a tile needs.
    ...(row.media?.length ? { media: row.media } : {}),
  }));
}

/**
 * Every entity's upstream ids and aliases — ids and nothing else, for the publisher.
 *
 * Separate from {@link readPriorEntities} because publish needs strictly less, and measured, the
 * difference is not small: that function builds `jsonb_build_object('id', …, 'mergeKey', …)` per id —
 * **13.9 MB on the wire against 5.1 MB as `text[]`**, plus 225k `JSON.parse`s so the caller can throw the
 * flag away — and aggregates a `members` count publish never reads. 1,767 ms versus **390 ms**, on a 17 s
 * stage.
 *
 * `resolve` genuinely needs the flags and the count (`readPriorEntities` explains why), so this is a
 * narrower query rather than a replacement.
 */
export async function readEntityRefs(db: Querier): Promise<Map<string, EntityRefs>> {
  const { rows } = await db.query(
    "SELECT e.id, COALESCE(u.ids, '{}') AS upstream, COALESCE(a.ids, '{}') AS aliases " +
      "FROM entities e " +
      "LEFT JOIN (SELECT entity_id, array_agg(upstream_id ORDER BY upstream_id) AS ids " +
      "FROM entity_upstream GROUP BY entity_id) u ON u.entity_id = e.id " +
      "LEFT JOIN (SELECT entity_id, array_agg(alias_id ORDER BY alias_id) AS ids " +
      "FROM entity_aliases GROUP BY entity_id) a ON a.entity_id = e.id",
  );
  const refs = new Map<string, EntityRefs>();
  for (const row of rows as EntityRefsRow[]) {
    refs.set(row.id, { upstream: row.upstream ?? [], aliases: row.aliases ?? [] });
  }
  return refs;
}

/**
 * Which sources the merged data actually names — so `publish` can check them all against `SOURCE_TERMS`
 * before it writes anything.
 *
 * `unnest` over the arrays rather than a scan in JS: the answer is a handful of strings and the database is
 * already holding 225k rows of them.
 */
export async function sourcesInUse(db: Querier): Promise<string[]> {
  // The union with `media_files` is load-bearing, not tidiness. `merged_places.sources` lists only sources
  // that **won a field**, so a source that supplies nothing but photos — which is every media source, since
  // Commons describes no place — would be absent from this answer and sail through the preflight. It would
  // then fail inside the innermost write loop, at place 40,000, with a revision already claimed: exactly the
  // failure the preflight exists to catch before anything is written.
  const { rows } = await db.query(
    "SELECT DISTINCT s AS source FROM merged_places, unnest(sources) s " +
      "UNION SELECT DISTINCT source FROM media_files WHERE state = 'published' " +
      "ORDER BY 1",
  );
  return (rows as { source: string }[]).map((row) => row.source);
}

/** Every recorded build input, for the manifest's audit trail (`apps/atlas/doc/spec/volume-format.md` §2). */
export async function readInputs(db: Querier): Promise<InputRecord[]> {
  const { rows } = await db.query(
    "SELECT source, artifact, hash, bytes::text, mtime_ms::text FROM build_inputs " +
      "ORDER BY source, artifact",
  );
  return (rows as InputRow[]).map((row) => ({
    source: row.source,
    artifact: row.artifact,
    hash: row.hash,
    bytes: Number(row.bytes),
    mtimeMs: Number(row.mtime_ms),
  }));
}

/** What a publish recorded about itself. `revision` is assigned by the database, never by the caller. */
export interface PublishRecord {
  volume: string;
  version: string;
  manifestHash: string;
  places: number;
  cells: number;
}

/**
 * The `revision` for one version of a volume — monotonic across the volume's versions, and **stable for a
 * given version**.
 *
 * Claimed before the tree is written, because the number goes inside the signed manifest and inside every
 * tile, so it cannot be assigned after the fact.
 *
 * Re-publishing a version returns **the same** number rather than the next one. That is not a
 * convenience: `apps/atlas/doc/spec/volume-format.md` §10 says a version's bytes never change, and
 * a revision that advanced per attempt would emit a different manifest, a different signature and
 * 50,000 different tiles for the same `us-west@2026-08` — so "publish twice and diff" could never
 * be a reproducibility check, and a mirror could hold two artifacts both claiming to be that
 * version. The revision belongs to the version.
 */
export async function claimRevision(db: Querier, volume: string, version: string): Promise<number> {
  const { rows } = await db.query(
    "INSERT INTO publish_log (volume, version, manifest_hash, places, cells, published_at) " +
      "VALUES ($1, $2, NULL, NULL, NULL, NULL) " +
      // A no-op update so `RETURNING` fires on the conflict path too, handing back the revision this
      // version already owns.
      "ON CONFLICT (volume, version) DO UPDATE SET volume = EXCLUDED.volume " +
      "RETURNING revision::text",
    [volume, version],
  );
  return Number((rows as { revision: string }[])[0]?.revision ?? 0);
}

/** Fill in what the claimed revision actually published. */
export async function completePublish(
  db: Querier,
  revision: number,
  record: PublishRecord,
  now: string,
): Promise<void> {
  await db.query(
    "UPDATE publish_log SET manifest_hash = $2, places = $3, cells = $4, " +
      "published_at = $5::timestamptz WHERE revision = $1",
    [revision, record.manifestHash, record.places, record.cells, now],
  );
}

interface MergeSourceRow {
  entity_id: string;
  source: string;
  source_id: string;
  name: string | null;
  alt_names: string[] | null;
  description: string | null;
  description_credit: MediaCredit | null;
  website: string | null;
  wikipedia: string | null;
  category: string;
  subcategory: string | null;
  point: string;
  geometry: string | null;
}

interface EntityRefsRow {
  id: string;
  upstream: string[] | null;
  aliases: string[] | null;
}

interface PublishableRow {
  entity_id: string;
  cell: string;
  fields: MergedFields;
  sources: string[] | null;
  point: string;
  geometry: string | null;
  media: PublishedMedia[] | null;
}

interface ArticleCandidateRaw {
  source: string;
  source_id: string;
  title: string | null;
  category: string;
  subcategory: string | null;
  point: string;
  has_description: boolean;
}

interface ArticleRaw {
  title: string;
  summary: string | null;
  image_file: string | null;
  absent: boolean;
}

interface InputRow {
  source: string;
  artifact: string;
  hash: string;
  bytes: string;
  mtime_ms: string;
}

interface ConcordanceRaw {
  qid: string;
  claims: Record<string, WikidataValue[]> | null;
  enwiki_title: string | null;
  absent: boolean;
}

interface StagedIdentityRow {
  source: string;
  source_id: string;
  upstream_ids: string[] | null;
  derived_from_source: string | null;
  derived_from_id: string | null;
}

interface PriorEntityRow {
  id: string;
  upstream: { id: string; mergeKey: boolean }[] | null;
  members: number;
  aliases: string[] | null;
}

// ── the contribution source ───────────────────────────────────────────────────────────────────────

export const CONTRIB_SOURCE: SourceId = "contrib";

/**
 * The base layer's source name.
 *
 * Defined here with its five siblings rather than in `osm.ts`, which re-exports it: this file cannot
 * import that one (it imports this one), and a second `"osm"` literal is exactly the divergent
 * spelling `osm-refs.ts` warns "duplicates every place instead of merging it — silently".
 */
export const OSM_SOURCE: SourceId = "osm";

/**
 * A contributed photo's stated grant, keyed by the URL the crawl will fetch.
 *
 * A cache table like every other arm's, and for the same reason: the crawl's `--retry` must re-gate
 * a photo **offline**. The difference is where it comes from — NPS and RIDB answer per image from
 * their own APIs, while a contribution states its terms in the export file itself, so this table is
 * filled by the staging pass rather than by a network call. That is strictly better: there is no
 * API here to be down, and the grant is the contributor's, not a third party's to revise.
 */
export interface ContribImageMeta {
  license: string;
  licenseUrl?: string;
  /** The contributor's DID if they asked to be named, else the exporting server's. */
  author?: string;
}

/** Record the grants a contribution export stated, so the crawl can gate without the file. */
export async function writeContribMedia(
  db: Querier,
  entries: readonly (ContribImageMeta & { url: string })[],
  now: string,
): Promise<void> {
  if (entries.length === 0) return;
  await db.query(
    "INSERT INTO contrib_media (url, license, license_url, author, seen_at) " +
      'SELECT r.url, r.license, r."licenseUrl", r.author, $2::timestamptz ' +
      "FROM jsonb_to_recordset($1::jsonb) AS r(url text, license text, " +
      '"licenseUrl" text, author text) ' +
      "ON CONFLICT (url) DO UPDATE SET license = EXCLUDED.license, " +
      "license_url = EXCLUDED.license_url, author = EXCLUDED.author, seen_at = EXCLUDED.seen_at",
    [JSON.stringify(entries), now],
  );
}

/** Grants by URL — {@link readRidbImageMeta}'s sibling, read by the crawl's contrib arm. */
export async function readContribImageMeta(
  db: Querier,
  urls: readonly string[],
): Promise<Map<string, ContribImageMeta>> {
  const out = new Map<string, ContribImageMeta>();
  if (urls.length === 0) return out;
  const { rows } = await db.query(
    "SELECT url, license, license_url, author FROM contrib_media WHERE url = ANY($1::text[])",
    [[...urls]],
  );
  for (const row of rows as {
    url: string;
    license: string;
    license_url: string | null;
    author: string | null;
  }[]) {
    out.set(row.url, {
      license: row.license,
      ...(row.license_url ? { licenseUrl: row.license_url } : {}),
      ...(row.author ? { author: row.author } : {}),
    });
  }
  return out;
}

/**
 * Where a contributed record should join, given the source keys the exporting server said its place
 * is known by.
 *
 * **This is what makes an improvement an improvement.** A contribution to a place that already
 * exists here has to land on that place's entity; staged as an island it would publish a second pin
 * carrying half a description, next to the real one. The keys come from the exporting server's own
 * `place_sources`, in its spelling — which is deliberately the spelling stage 1 already writes
 * (`way/586464226`, not the builder's `osm:w/586464226`), so the common case is direct equality
 * against `source_records` rather than a translation that could disagree at one end.
 *
 * Two shapes resolve, and nothing else does:
 *
 * - **An OSM key** (`way/…`, `node/…`, `relation/…`) → the staged OSM record itself.
 * - **A ULID** → an Atlas place id (or a former one), so a place only this dataset knows about is
 *   still joinable. Resolved through `entity_aliases` as well as `entities`, because a place that
 *   merged since the server imported it answers to its old id and nothing else would find it.
 *
 * Returns the **record** to name as a parent, never the entity: derivation is a record→record claim
 * (`identity.ts`), which is what keeps a contribution from adding an asserter to the merge gate's
 * span measurement or counting as a second source agreeing with itself.
 */
export async function findContribParents(
  db: Querier,
  keys: readonly string[],
): Promise<Map<string, RecordRef>> {
  const found = new Map<string, RecordRef>();
  if (keys.length === 0) return found;
  // Deduped: several contributions to one place each list its keys, and the two `= ANY(...)`
  // arrays would otherwise repeat the same lookup.
  const unique = [...new Set(keys)];
  // The two forms this join understands, each recognized by the module that owns its spelling
  // rather than by a regex written here — a fourth spelling of `way/586464226` is the failure
  // `osm-refs.ts` names outright.
  const osmKeys = unique.filter(isOsmSourceId);
  const atlasIds = unique.filter((k) => ULID_RE.test(k));

  if (osmKeys.length > 0) {
    const { rows } = await db.query(
      "SELECT source_id FROM source_records WHERE source = $1 AND source_id = ANY($2::text[])",
      [OSM_SOURCE, osmKeys],
    );
    for (const row of rows as { source_id: string }[]) {
      found.set(row.source_id, { source: OSM_SOURCE, sourceId: row.source_id });
    }
  }

  if (atlasIds.length > 0) {
    // One member per entity, chosen deterministically: any record of the entity joins the same
    // component, and `MIN` makes two runs over the same data pick the same one — a derivation whose
    // parent moved between builds would be a diff in `source_records` that means nothing. One
    // lateral over a union of "ids that name an entity" — a place's own id and every id that ever
    // merged into it (`apps/atlas/doc/spec/place-identity.md` §5: a losing id keeps resolving,
    // forever). Written as one query rather than two UNION ALL halves so the member pick is not
    // duplicated, and so which half answered stops mattering: an id is in exactly one of the two
    // tables by construction.
    const { rows } = await db.query(
      "SELECT k.key, m.source, m.source_id FROM unnest($1::text[]) AS k(key) " +
        "JOIN (SELECT id AS key, id AS entity_id FROM entities " +
        "      UNION ALL SELECT alias_id, entity_id FROM entity_aliases) e ON e.key = k.key " +
        "JOIN LATERAL (SELECT source, source_id FROM entity_members " +
        "  WHERE entity_id = e.entity_id ORDER BY source, source_id LIMIT 1) m ON true",
      [atlasIds],
    );
    for (const row of rows as { key: string; source: string; source_id: string }[]) {
      found.set(row.key, { source: row.source, sourceId: row.source_id });
    }
  }
  return found;
}

// ── the blob prune ────────────────────────────────────────────────────────────────────────────────

/**
 * Every hash `media_files` still earns its bytes for — bare, no `sha256:` prefix.
 *
 * The publishability test is the **shared predicate pair** the publisher and the coverage report
 * already use, not a fourth spelling of it: a prune that decided publishability differently from
 * publish would delete the bytes of photos that were about to ship, and the two could disagree
 * without either erroring. So a file earns its bytes exactly when there is at least one
 * `(place, file)` pairing that would publish.
 *
 * Three ways a row lands in `keep`, and the reasoning differs for each:
 *
 * - **It publishes somewhere.** The ordinary case.
 * - **Its state is neither `published` nor `rejected`.** In practice that means a row `publish`
 *   demoted for a missing blob, which keeps its hashes deliberately — and those bytes may well
 *   exist under `media`'s output directory even when they are absent from `publish`'s. Cheaper to
 *   keep than to re-download.
 *
 *   `rejected` is excluded from that shelter **on purpose, against a future change**. Today a
 *   rejected row carries no hashes at all (`refusedRow` rebuilds without them, which is what
 *   strands the bytes in the first place), so the distinction is invisible. The day anyone makes
 *   that rebuild preserve the pair — a reasonable change, and `demoteMissingBlobs` argues for it —
 *   a blanket "not published ⇒ keep" would silently protect every refused photo and cancel this
 *   whole sweep, with no test and no error to say so.
 * - **It has no place link and `includeUnlinked` is false.** Unlinked is *also* the state of a
 *   crawl page whose file rows have committed and whose links have not — so by default it is read
 *   as "the crawl is not finished with this", never as "nothing wants it".
 *
 * A hash claimed by two rows is kept if **either** keeps it — set union, which is what the
 * `DISTINCT` over a passing-rows filter already is. That matters because blobs are
 * content-addressed: two sources serving identical bytes share one file on disk, and deleting on
 * the loser's behalf would take the winner's photo with it.
 */
export async function mediaBlobClaims(db: Querier, includeUnlinked: boolean): Promise<string[]> {
  // `unnest` in the FROM (an implicit LATERAL) rather than a CTE with `bool_or`: "kept if ANY row
  // keeps it" is exactly the distinct hashes of the rows that pass, so the aggregate would only
  // restate the filter. It also drops the "has a hash at all" guard — an empty array yields no rows.
  const { rows } = await db.query(
    "SELECT DISTINCT h AS hash FROM media_files f, " +
      "  unnest(array_remove(ARRAY[f.thumb_hash, f.full_hash], NULL)) AS h " +
      " WHERE f.state NOT IN ('published', 'rejected') " +
      "    OR EXISTS (SELECT 1 FROM place_media pm WHERE pm.file_key = f.file_key " +
      `         AND ${MEDIA_PUBLISHABLE_SQL} AND ${placePublishableSql("pm")}) ` +
      "    OR (NOT $1::boolean " +
      "        AND NOT EXISTS (SELECT 1 FROM place_media pm WHERE pm.file_key = f.file_key))",
    [includeUnlinked],
  );
  return (rows as { hash: string }[]).map((row) => mediaBareHash(row.hash));
}
