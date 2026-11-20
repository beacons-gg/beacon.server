// @beaconsgg/place-taxonomy — [S] server-only
// The OSM tag → taxonomy classifier and the vocabulary derived from it. Server-only because the
// tag map is an ingestion concern: a game never sees OSM vocabulary, it reads the neutral
// categories off the wire. Two consumers run this exact map — the beacon server's snapshot
// connectors, and Cartographer's normalizer — and a second copy would drift, taking the curation
// rules (no sensitive locations; `tourism=attraction` last) with it.

export * from "./taxonomy";
export * from "./osm-refs";
