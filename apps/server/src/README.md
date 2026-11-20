# apps/server/src/

The server's NestJS modules. Keep the controllers, gateways and services **thin**. Every gameplay
decision lives in `@beaconsgg/policy-engine` and `@beaconsgg/server-runtime`. This layer handles
HTTP and WebSocket traffic, persistence and wiring.

`main.ts` boots the NestJS graph over the durable async `Store`. The boot sets up CORS from an
allow list, the WebSocket origin adapter and graceful shutdown. `GET /health` reports liveness, and
`GET /health/ready` reports readiness by reading the database.

## Module map

| Path                                                        | What it holds                                                                                                              |
| ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `main.ts`, `app.module.ts`, `config.ts` and `ws.adapter.ts` | the boot and the dependency graph, with the environment settings and the WebSocket origin adapter                          |
| `server-identity.ts`                                        | the server's key pair and its signed descriptor                                                                            |
| `rooms/`                                                    | the room routes and the room service, with the live channels and the op status mapping                                     |
| `scouts/`, `profiles/` and `discovery/`                     | the scout relay and the revocation registry, with the anonymous discovery and descriptor routes                            |
| `mailbox/`, `media/`                                        | the mailbox and the content-addressed media store, both opt in ([spec](../../../doc/spec/mailbox-and-media.md))            |
| `geocode/`                                                  | the opt-in cached reverse-geocode lookup from a geohash to a place label                                                   |
| `backup/`                                                   | the signed backup and restore jobs against an S3 prefix, with durable runs in one job log                                  |
| `places/`                                                   | the opt-in places dataset and its admin routes, with the import runner and the merge ([spec](../../../doc/spec/places.md)) |
| `docs/`                                                     | the opt-in OpenAPI document and its browsable UI, generated from the protocol schemas                                      |
| `identity/key-provider.ts`                                  | the signing-key providers: `env`, `file` and `encrypted-file`                                                              |
| `health/`, `common/`                                        | the health probes, the shared request gates and the rate limits                                                            |
| `settings/`, `admin/`                                       | the runtime settings and the admin routes                                                                                  |
| `stores/`, `migrations/`                                    | the store interfaces with their Postgres implementations, and the forward-only SQL migrations                              |

The room service runs `PolicyEngine` as a unit of work under a per-room `KeyedMutex`. The service
also keeps the timer wheel and the discovery index, and broadcasts to the live cells. A server
calls no third party for place data: an Atlas volume import is the one connector. A KMS key
provider is a documented seam and isn't implemented.

The server's [README](../README.md) describes the REST and WebSocket routes. The design specs are
in [`doc/spec/`](../../../doc/spec/README.md).
