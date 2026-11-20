# @beaconsgg/place-taxonomy

**[S] server-only.** The package maps OSM tags to the place taxonomy. The package holds the
classifier every ingestion path runs, and the category and subcategory vocabulary derived from the
map.

## Why this is a package

The taxonomy is a fixed vocabulary of 14 categories (the server's places spec, `doc/spec/places.md`
§1 and §4). Two programs read the vocabulary and must agree exactly:

| Consumer                  | Uses the package to                                                                           |
| ------------------------- | --------------------------------------------------------------------------------------------- |
| `apps/server`             | serve `GET /places/taxonomy` and check the category pair on a player's place proposal         |
| `apps/atlas/cartographer` | classify OSM rows when it normalizes an OSM source into Atlas's staging table                  |

A second copy would drift, and the **curation rules** would drift with it. The dataset holds no
sensitive locations. `tourism=attraction` comes last so that the generic tag never shadows a
specific type. Those rules belong to the dataset and not to one program. So they sit beside the map,
and the tests here pin them.

## Why `server/` and not `core/`

`server/` means that `apps/server` imports the package and a client never does. A game never sees
OSM vocabulary. A game reads the neutral `PlaceCategory` off the wire, and a client that needs the
slug list fetches `GET /places/taxonomy`. A package in `core/` must stay safe for React Native, and
no React Native code imports this one. `normalizeWebsite` also relies on `new URL()`, which behaves
differently under React Native's partial polyfill. To promote the package later, rename its
directory: the tier gate reads the tier from the directory.

## Exports

| Purpose          | Exports                                                                                                                                                                            |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The map          | `OSM_TAG_MAP` holds every OSM key and value the dataset admits, most specific first. The first match wins. `OsmTagMapping` is its entry type.                                         |
| Classify         | `entryForTags(tags, entries?)` is the one classifier every consumer calls. `entriesForCategories(categories)` filters the map by category.                                          |
| Subcategory      | `subcategoryOf(entry)` returns the entry's group slug, or the tag value when the entry has none.                                                                                    |
| Vocabulary       | `PLACE_VOCABULARY` is derived from the map, so it can't advertise a slug nothing produces. `isVocabularyPair(category, subcategory)` checks a player's submission against it.      |
| Descriptor facts | `enrichmentForTags(tags, entry)` returns a `PlaceEnrichment` with `description`, `website`, `wikipedia` and `altNames`. The package also exports `enwikiArticleUrl(title)` and `DESCRIPTION_MAX`. |

For surveillance gear, `enrichmentForTags` also builds a name and a description from the device's
tags.

## Notes

- **First-match order matters.** `entryForTags` returns the first entry whose key and value the tags
  carry, so a specific type must come before a vaguer one. `tourism=attraction` is last in the whole
  map, and a test enforces that.
- **A new value under a known key needs no new import.** Classification happens when a source is
  normalized. So a new value takes a new Cartographer run and no re-import of the extract. A new
  **key** or a new nameless pair also needs `apps/atlas/osm-import/beacon-places.lua` edited and
  the extract imported again. The Lua import filter works on keys. `lua-mirror.test.ts` fails when
  the map and the filter drift. That test is the only way to notice: a row that was never imported
  looks the same as a place that doesn't exist.
- **`nameless` is for surveillance gear only.** Cameras almost never have a name. Every other entry
  still needs a name in the Lua filter.
- **Check any new tag against the curation rules first.** `curation.test.ts` names the exclusions.
