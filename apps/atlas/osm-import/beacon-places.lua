-- ───────────────────────────────────────────────────────────────────────────── Beacon places —
-- osm2pgsql flex output (`apps/atlas/doc/spec/cartographer.md` §1.1).
--
-- Coarse filter, precise classification: this script keeps objects that have a
-- `name` AND any taxonomy KEY; the value-level tag→category match happens at
-- snapshot time in the server through the shared matcher, so growing the
-- taxonomy re-runs a snapshot — never a re-import.
--
-- KEYS mirrors the key set of OSM_TAG_MAP's name-required entries, and
-- NAMELESS_OK its `nameless: true` exact pairs (surveillance gear is ~never
-- named — those objects are kept without a name; nothing else is, so a bare
-- key like `highway` never floods the import with named roads).
-- packages/server/place-taxonomy is the single source of truth (the server AND
-- Cartographer both classify through it); a CI test there pins both lists.
-- New KEY or nameless pair there → update here + re-import.
-- ─────────────────────────────────────────────────────────────────────────────

local KEYS = {
  "amenity",
  "shop",
  "leisure",
  "tourism",
  "natural",
  "historic",
  "man_made",
  "railway",
  "waterway",
}

local NAMELESS_OK = {
  man_made = "surveillance",
  highway = "speed_camera",
}

local places = osm2pgsql.define_table({
  name = "beacon_places",
  -- 'any' + type_column keeps node/way/relation ids in separate namespaces —
  -- the connector rebuilds the Overpass-parity sourceId ("node/123") from it.
  ids = { type = "any", id_column = "osm_id", type_column = "osm_type" },
  columns = {
    { column = "name", type = "text" }, -- NULL only for NAMELESS_OK objects
    { column = "tags", type = "jsonb", not_null = true },
    { column = "geom", type = "geometry", projection = 4326, not_null = true },
  },
  indexes = {
    { column = "geom", method = "gist" },
    -- Cartographer's stage 1 pages this table with `ORDER BY osm_type, osm_id` and a keyset cursor, so
    -- the index is what keeps each of ~430 pages an index scan rather than a sort of 862k rows.
    -- osm2pgsql only builds an id index when it thinks updates need one (`--create` without `--slim`
    -- decides they don't), so it has to be asked for. It was originally added for the `osm-enrich`
    -- job's UPDATEs; that job is gone and the paging reason outlived it.
    { column = { "osm_type", "osm_id" }, method = "btree" },
  },
})

-- A nameless-allowed exact pair, or named + carrying at least one taxonomy key.
local function relevant(tags)
  for key, value in pairs(NAMELESS_OK) do
    if tags[key] == value then
      return true
    end
  end
  if not tags.name then
    return false
  end
  for _, key in ipairs(KEYS) do
    if tags[key] then
      return true
    end
  end
  return false
end

local function insert(object, geom)
  if geom:is_null() then
    return
  end
  places:insert({ name = object.tags.name, tags = object.tags, geom = geom })
end

function osm2pgsql.process_node(object)
  if relevant(object.tags) then
    insert(object, object:as_point())
  end
end

-- Closed ways become areas; named linear features (roads, rivers) aren't places.
function osm2pgsql.process_way(object)
  if relevant(object.tags) and object.is_closed then
    insert(object, object:as_polygon())
  end
end

-- osm2pgsql assembles relation member rings natively — this is where the local
-- path surpasses Overpass (which defers multipolygon assembly to a trigger).
function osm2pgsql.process_relation(object)
  local t = object.tags.type
  if relevant(object.tags) and (t == "multipolygon" or t == "boundary") then
    insert(object, object:as_multipolygon())
  end
end
