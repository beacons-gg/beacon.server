-- 0023_byte_order (postgres) — every text column takes the "C" collation: byte order.
--
-- Postgres orders `text` by the column's collation, and a column declared without one takes the
-- database's, which the operator chose at initdb (`en_US.utf8` in the stock image). A linguistic
-- collation folds case and skips punctuation on its first pass, so `zb` sorts before `zC` and
-- `a:z` after `ab`, where JavaScript's `<` puts them the other way round. The in-memory fakes the
-- service suites run on compare with `<`, and each is held to its store's parity suite, so without
-- this the two agreed only on data that happened not to tell the orders apart: DIDs and media
-- hashes are mixed-case, setting keys are camelCase, and attributions and sources are free text
-- with punctuation. Byte order is also what every server returns whatever its database was created
-- with.
--
-- On the column, not per query (`ORDER BY x COLLATE "C"`): an index sorts in its column's
-- collation, so a per-query collation that disagrees with it cannot walk it. Changing the column
-- rebuilds each index on it in byte order, and the keyset walks (the places PK, the media and
-- proposal listings) keep their index.
--
-- Every text column, not only the ones sorted today, so the rule has no list to fall behind: a
-- column added later declares `COLLATE "C"`, and store-factory.test.ts fails on one that does not.
-- No query lowercases or case-folds text, the one place "C" would change an answer.
--
-- A collation change is binary-compatible for `text`, so Postgres rewrites no table: the cost is
-- the index rebuilds, under the migration's lock at boot. Equality is unchanged (both collations
-- are deterministic). The tables are named, so a schema shared with anything else is left alone.
DO $$
DECLARE
  t record;
BEGIN
  FOR t IN
    SELECT table_name,
           string_agg(format('ALTER COLUMN %I TYPE text COLLATE "C"', column_name), ', ') AS alters
    FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND data_type = 'text'
      AND table_name = ANY (ARRAY[
        'schema_migrations', 'rooms', 'nonces', 'profiles', 'mailbox', 'media',
        'capability_nonces', 'geocode_cache', 'places', 'place_sources', 'place_cells',
        'place_snapshots', 'place_conflicts', 'place_proposals', 'blacklist', 'atlas_publishers',
        'settings'
      ])
    GROUP BY table_name
  LOOP
    EXECUTE format('ALTER TABLE %I %s', t.table_name, t.alters);
  END LOOP;
END $$;
