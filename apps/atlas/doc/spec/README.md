# Atlas specs

Atlas is the toolchain that builds place datasets for Beacon servers. An Atlas build reads
OpenStreetMap and a set of open sources, resolves which records describe the same place and
publishes the result as a **volume**: a signed set of static files that any Beacon server can
import. Atlas ships as code. Each operator builds and publishes their own volumes, with their own
signing key.

These specs describe how Atlas works and why: the design, the reasoning behind it and the rules the
code holds to. Each spec names the release it was checked against. Code comments cite a spec by its
section number, as in "volume format §7". A section keeps its number for good. A number missing from
a spec belongs to a section that was removed.

| Spec                                        | Covers                                                                             |
| ------------------------------------------- | ---------------------------------------------------------------------------------- |
| [Volume format](volume-format.md)           | the published artifact: layout, manifest, tiles, media, signing and verification   |
| [Place identity](place-identity.md)         | how records from many sources become one place, and why a place id never moves     |
| [Cartographer](cartographer.md)             | the builder's stages and storage, publishing and review                            |
| [Sources](sources.md)                       | each source, its license, the per-field priority and what a redistributor inherits |
| [Beacon integration](beacon-integration.md) | how a Beacon server trusts and imports a volume; the contribution round trip       |

The code:

| Directory                                    | Holds                                                      |
| -------------------------------------------- | ---------------------------------------------------------- |
| `apps/atlas/osm-import`                      | the `osm2pgsql` import that loads an OpenStreetMap extract |
| `apps/atlas/cartographer`                    | the builder, one subcommand per stage                      |
| `packages/server/atlas-volume`               | the volume format, shared by the builder and the server    |
| `packages/server/place-taxonomy`             | the place taxonomy, shared by the builder and the server   |
| `apps/server/src/places/connectors/atlas.ts` | the server's Atlas connector                               |

The server side of places is in the server's own [specs](../../../../doc/spec/README.md), starting
with [places](../../../../doc/spec/places.md).
