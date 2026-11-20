# Server specs

These specs describe how the Beacon server works and why: the design, the reasoning behind it and
the rules the code holds to. Each spec names the release it was checked against. Code comments cite
a spec by its section number, as in "places §3.1". A section keeps its number for good. A number
missing from a spec belongs to a section that was removed.

| Spec                                      | Covers                                                                                        |
| ----------------------------------------- | --------------------------------------------------------------------------------------------- |
| [Room operation](room-operation.md)       | the signed op envelope, consistency, custody transfer, the policy engine and the live channel |
| [Mailbox and media](mailbox-and-media.md) | the per-account mailbox and the content-addressed media store                                 |
| [Places](places.md)                       | the owned place dataset: its data model, merge, read API, imports and curation                |
| [Place proposals](place-proposals.md)     | player-submitted places, operator review and the contributor's license grant                  |
| [Location lookups](location-lookups.md)   | reverse geocoding and the server's outbound HTTP rules                                        |
| [Admin API](admin-api.md)                 | operator authorization and the signed admin routes                                            |
| [Runtime settings](runtime-settings.md)   | which settings an operator changes on a running server, and how                               |

The identity and discovery specs live in `doc/spec/` of the Beacon core repository, beside the
packages that implement them. Section 2 and section 3 of `doc/game-author.md` in the same repository
describe rooms and policies for game authors.

The Atlas toolchain builds the place volumes a server imports. Atlas has its own
[specs](../../apps/atlas/doc/spec/README.md), which cover the volume format and place identity. They
also cover the builder, the sources and how a server imports a volume.

For running a server, read the [deploy guide](../deploy.md).
