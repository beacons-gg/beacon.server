# @beaconsgg/server-app

The Beacon server is a NestJS and PostgreSQL service built on the `@beaconsgg/*` packages. The
server referees consistency and keeps custody of shared state. The server verifies identities and
signatures and never judges a gameplay claim. The NestJS layer stays thin, because every gameplay
decision lives in `@beaconsgg/policy-engine` and `@beaconsgg/server-runtime`.

Four optional, **generic** capabilities sit on top. An operator turns each on separately, and the
signed descriptor advertises the ones that are on:

- a **mailbox** per recipient ([spec](../../doc/spec/mailbox-and-media.md));
- a content-addressed **media** store (same spec);
- a cached reverse-**geocode** lookup ([spec](../../doc/spec/location-lookups.md));
- **places**, the server's own curated place dataset ([spec](../../doc/spec/places.md)).

The places dataset fills from three inputs: Atlas volume imports, approved player contributions and
the operator's own edits. The server merges the inputs per field and always serves from its own
store.

The design specs are in [`doc/spec/`](../../doc/spec/README.md). The [deploy
guide](../../doc/deploy.md) covers the container and the signing key, with backups and the topology.

## Module map (`src/`)

| Path                       | What it holds                                                                     |
| -------------------------- | --------------------------------------------------------------------------------- |
| `main.ts`                  | the NestJS boot                                                                   |
| `app.module.ts`            | the root module: the store module, the controllers, the gateways and the services |
| `config.ts`                | the `ServerConfig` read from the environment                                      |
| `rooms/`                   | the room routes, the room service and the live channels                           |
| `scouts/`                  | the scout relay                                                                   |
| `profiles/`                | profile publish and lookup over the durable revocation registry                   |
| `about/`                   | `GET /server/about`                                                               |
| `discovery/`               | the anonymous spatial query and the signed descriptor                             |
| `mailbox/`                 | the mailbox capability                                                            |
| `media/`                   | the media capability and its blob backends                                        |
| `geocode/`                 | the geocode capability                                                            |
| `places/`                  | the places capability, its admin routes and the import runner                     |
| `admin/`                   | the server-wide admin routes                                                      |
| `backup/`                  | the backup and restore jobs                                                       |
| `docs/`                    | the opt-in OpenAPI document and its browsable UI                                  |
| `home/`                    | the home page at `/`                                                              |
| `identity/key-provider.ts` | the signing-key providers                                                         |
| `server-identity.ts`       | the server's key pair, with `signDescriptor` and `rotateSigningKey`               |
| `health/`                  | the liveness and readiness probes                                                 |
| `common/`                  | the shared gates, rate limits and HTTP helpers                                    |
| `settings/`                | the runtime settings                                                              |
| `ws.adapter.ts`            | `OriginCheckedIoAdapter`, which refuses WebSocket origins that aren't allowed     |
| `stores/`                  | the store interfaces and their Postgres implementations                           |
| `migrations/`              | the forward-only SQL migrations and their runner                                  |
| `__tests__/`               | the unit, parity and durability suites                                            |

### The boot

`main.ts` creates the NestJS app and sets up CORS from `BEACON_CORS_ORIGINS`. The boot also installs
the WebSocket origin check (`OriginCheckedIoAdapter`) and sets `trust proxy`. `enableShutdownHooks`
drains the server on shutdown and closes the stores.

### Rooms

- `rooms.controller.ts` serves `POST /rooms`, `GET /rooms/:id` and `POST /rooms/:id/ops`. A
  placement passes the shared `SignedRequestGate`, then game admission and the player budget. The
  controller verifies the room's `mintedBy` over `{unique, kind, policy}`. The controller also
  verifies every item in `initialContents`, `initialRewards` and `initialPools` with
  `verifyItemProvenance`. A duplicate id answers `409 conflict`. The engine verifies an op inside
  `applyOp`, so the route for ops stays the same for every op.
- `rooms.service.ts` runs `PolicyEngine` as a **unit of work** under a per-room `KeyedMutex`. The
  service drives the timer wheel, which is seeded from `lifecycleRoomsDue` and reconciled on a
  coarse interval. Discovery reads `roomsInCells`, and the service broadcasts to the live cells.
- `rooms.gateway.ts` is the socket.io gateway. `subscribe` and `unsubscribe` deliver a room's
  `delta` events, and `setCells` delivers `map` events.
- `http-status.ts` maps an `OpResult` error code to an HTTP status.

### Scouts, profiles and discovery

- `POST /scouts` passes the shared gate, then game admission and the relay budget. The controller
  verifies the scout's `mintedBy` over `{unique, config}` and relays the report through `ScoutRelay`
  from `server-runtime`. An interval runs `sweepExpired` to age reports out.
- `POST /profiles` publishes a self-signed `ProfileDoc`, and the highest `version` wins. A profile
  over `MAX_PROFILE_BYTES` (64 KiB of canonical JSON) answers `413 tooLarge`. `GET /profiles/:id`
  returns an account's public name and avatar, or `404 unknownProfile`. The durable **revocation
  registry** backs both routes. The registry is a write-through cache over the `ProfileStore`, so
  `isRevoked` is a synchronous check on every op.
- `GET /server/about` serves the operator's long description (`BEACON_ABOUT`) as Markdown, kept out
  of the descriptor.
- `GET /discovery` is the anonymous spatial query. `GET /server/descriptor` is the signed coverage
  advertisement with its `capabilities`.

Beside the operator's services, `capabilities` carries the build's protocol markers. Each admitted
game gets a `game:<slug>`. Each room op that this build accepts beyond the baseline gets an
`op:<name>` marker. A policy feature gets a `policy:<feature>` marker, and a rule operator gets a
`rule:<name>` marker. The engine's `acceptedMarkers` lists them.

### Capabilities

- **Mailbox** (`BEACON_MAILBOX`): `POST /mailbox` sends, `POST /mailbox/fetch` reads the verified
  recipient's mail and `POST /mailbox/ack` deletes it. `mailbox.service.ts` stamps the TTL the
  server decides and runs the sweep. The stores keep opaque signed messages.
- **Media** (`BEACON_MEDIA`): `POST /media` uploads by content address. The server hashes the bytes
  again and checks them, and refuses EXIF and GPS metadata. Each DID has a quota and a rate.
  `GET /media/:hash` is public and cached as immutable. The route **streams** the bytes or
  **redirects** to a CDN with `302`. `media-blob.ts` holds the two backends: `FsMediaBlobStore` for
  development and `S3MediaBlobStore` for R2, DigitalOcean Spaces or AWS.
- **Geocode** (`BEACON_GEOCODE`): `GET /geocode?geohash=` turns a geohash into a coarse city, state
  and country label. A provider (Nominatim by default) answers through a durable cache, which keys
  on a coarsened cell and caches misses with a TTL sweep. An upstream failure answers `503` and
  never `500`.
- **Places** (`BEACON_PLACES`): the server **owns a curated place dataset** with exactly **three
  inputs** ([`beacon-integration.md`](../atlas/doc/spec/beacon-integration.md) §6). The server
  always serves from its own store, and **no path calls a third party**.

The places code splits like this:

- `places.controller.ts` and `places.service.ts` hold the public reads. `GET /places` returns
  summaries for several cells with derived attribution. `GET /places/:unique` returns one place with
  its GeoJSON geometry and provenance.
- `places-admin.controller.ts` holds the signed admin routes, which `BEACON_ADMINS` gates through
  the shared admin gate.
- `snapshot.service.ts` is the serial run engine. The engine fetches in chunks and skips unchanged
  elements. The engine logs admin conflicts and retires within the imported scope.
  `places.source.retire` closes out the records of a source that is no longer an input.
- `connectors/` is the source seam. The seam's one implementation is `atlas.ts`, built per import
  from the volume being imported.
- `merge.ts` is the pure merge by field priority (`admin > list: > contrib > atlas:`) with the
  conflict queue. An older `osm` record ranks after all of them.

### Admin

The server-wide **admin routes** ([spec](../../doc/spec/admin-api.md)) are gated by the shared
`common/admin-gate.ts`. The descriptor **never advertises** them, and they answer `404` when
`BEACON_ADMINS` is empty.

- `POST /admin/status` is a signed read of the descriptor's facts and cheap counts from every store.
- The **moderation** ops remove a room through the engine's normal close path, so watchers get the
  standard `closed` and `roomGone` events. The ops also remove media (the blob and its metadata) and
  manage the **durable blocklist** in the `0009_admin` table. `BEACON_BLOCKLIST` seeds the blocklist
  at boot.
- The media review ops list the media store and mark media reviewed.
- The **settings** ops return the whole configuration in one read: the 42 editable settings with
  where each value comes from, and the 28 deploy-time settings read-only beside them. Each setting
  names the variable behind it. A set takes several keys at once, because some settings constrain
  each other ([runtime settings spec](../../doc/spec/runtime-settings.md)).

Every admin action logs a structured `{op, actor, target, reason?}` audit line.

### The home page

`home/` serves the home page a browser gets at `/` (`BEACON_HOME`, on by default). The page shows:

- the server's name and description;
- the operator's contact behind a click, read from the descriptor so the HTML holds no address for a
  scraper;
- the server's address as text and as a QR code;
- the coverage on a map;
- what the server offers and its signing key;
- the room counts.

The page builds on the descriptor's facts, so the page says nothing a client can't already learn.
The counts are the exception, and an open server shows them unless `BEACON_HOME_STATS` says
otherwise. A request that doesn't ask for HTML still gets a `404 unknownRoute`, except a chat's link
preview.

### The shared helpers in `common/`

| File                       | What it does                                                                               |
| -------------------------- | ------------------------------------------------------------------------------------------ |
| `signed-request-gate.ts`   | `SignedRequestGate`, the one bracket **every** signed request passes through               |
| `signed-request.ts`        | `verifyOp` with the `issuedAt` freshness check, which yields the cryptographic actor       |
| `admin-gate.ts`            | `AdminGate`, the one admin gate with the brackets for admin writes and signed reads        |
| `capability-http.ts`       | the shared `4xx` shapes and the signed-read bracket every fetch route uses                 |
| `understands.filter.ts`    | `UnderstandsFilter`, the global exception filter every HTTP refusal leaves through         |
| `nonce.service.ts`         | replay dedupe over the durable nonce log                                                   |
| `rate-limit.guard.ts`      | `WriteRateLimitGuard` on the `POST` routes, keyed on IP                                    |
| `read-rate-limit.guard.ts` | the guards keyed on IP on the public reads                                                 |
| `did-rate-limit.ts`        | a fixed window per DID                                                                     |
| `did-budgets.ts`           | the two write classes per DID (player and relay), keyed on the verified actor              |
| `blocklist.ts`             | `SenderBlocklist`, a write-through cache over the durable blocklist table                  |
| `game-gate.ts`             | `GameGate`, the one game gate                                                              |
| `client-key.ts`            | the one resolver of the client IP that both rate limiters key on                           |
| `env.ts`                   | operational switches read from `process.env` outside the `ServerConfig` schema             |
| `media-metadata.ts`        | the `exifr` detector for EXIF and GPS metadata, **for images only**                        |
| `outbound-http.ts`         | the server's seam for third-party HTTP with a timeout, a user agent and an outbound budget |
| `query.ts`                 | `validatedCsvParam` and `MAX_QUERY_CELLS`, the one check on cell lists in a query          |

The signed-request gate checks the op name, verifies the signature and checks `issuedAt`. The gate
then checks that the actor isn't blocked and that the **device isn't revoked**. The gate answers as
a `check` verdict or as a `verify` call that throws. The exception filter sends a refusal code newer
than the caller's `beacon-understands` header as its `CODE_FALLBACKS` entry. The filter also gives
the framework's own answers the refusal body. A path no route serves answers `404 unknownRoute`, as
does a capability that is off. A route that names a missing thing answers a `404` with a code for it
(`unknownPlace`, `unknownMedia`, `unknownProposal`, `unknownRun`, `noAbout`), and the filter sends
`unknownRoute` in its place to a caller that has not declared that code. A body over the limit
answers `413 tooLarge`. A body that is not JSON answers `400 invalid`. A charset
or an encoding the parser does not take answers `415 invalid`. The game gate makes every game write
name its game, and `BEACON_GAMES` says which games this server takes.

### Settings

`settings/` holds the runtime settings ([spec](../../doc/spec/runtime-settings.md)):

- `registry.ts` classifies **every** `ServerConfig` field. The server stores 42 runtime fields. 28 deploy-time fields come from the environment only. Two derived fields are stored nowhere. Each runtime key
  has a zod schema. The registry covers `keyof ServerConfig` **at compile time**. A new field that
  isn't classified fails `typecheck` instead of becoming uneditable without notice.
- `settings.service.ts` keeps the durable store and a synchronous cache in memory, because reads are
  on the request path. The environment supplies every default. The **presence of a row** decides
  whether a later change to the environment lands. A setting no admin has touched follows the
  environment. A setting an admin has set stays set until the admin resets it. The assembled view
  coerces prerequisites. So no sequence of edits, resets or restarts can serve a combination that
  `loadConfig` couldn't produce.
- `live-config.ts` holds `createLiveConfig(boot, settings)`, the **live `ServerConfig`** that every
  consumer injects as `SERVER_CONFIG`. The live config has the same shape and type as
  `loadConfig()`. The 42 runtime fields read the settings cache, and `capabilities` recomputes from
  them. The deploy-time fields come from the boot snapshot. `liveView(src, { to: "from" })` builds
  the readers for the eight config slices and the three rate limiters per DID. So the rule that
  nothing copies a value holds at compile time. An operator's change then reaches the request path
  and the signed descriptor with no redeploy.
- `settings-report.ts` builds the view the admin ops answer with. The view lists every field and
  names the environment variable behind it. The view also says whether that variable is exported. A
  secret is reported only as set or unset. `DEPLOY_TIME_FIELDS` in `registry.ts` declares which
  fields are secret, as a required entry per key. A new deploy-time field can't compile until
  someone decides whether an admin may see it.

### Stores and migrations

`stores/` holds the persistence layer behind the async `Store` seam, on Postgres only:

- `pg.store.ts` implements `Store` with **node-postgres**. Each `commit(Mutation[])` is one
  transaction. Rooms are `JSONB`, with geohash and `lifecycle_due_at` indexes behind `roomsInCells`
  and `lifecycleRoomsDue`.
- `profile-store.ts` and `profile.pg.store.ts` hold the durable revocation registry.
- The mailbox, media, nonce and geocode stores keep the mailbox messages and the media metadata.
  They also keep the durable **replay nonce** log and the geocode label cache.
- `place-store.ts` and `place.pg.store.ts` hold the **places dataset** in five tables. `places` and
  `place_sources` hold the places and their sources, and `place_cells` is the geohash index.
  `place_snapshots` holds the runs, and `place_conflicts` is the conflict queue. `commitPlace` is
  atomic and writes `createdAt` once. The cell query uses the index.
- `settings-store.ts` and `settings.pg.store.ts` hold the durable **operator settings**
  (`0022_settings`). The table holds admin **overrides only**. One JSON `value` column carries every
  shape a setting can take, and a key with no row comes from the environment.
- `store.factory.ts` and `store.module.ts` build every store on the Postgres database at
  `BEACON_DATABASE_URL`, on **one pool** of `BEACON_PG_POOL_SIZE` connections. The bundle owns the
  pool and ends it on shutdown.
- `pg.migrations.ts` holds `migrate(pool)`, which the factory runs once before it builds a store.

Each `*-store.ts` file holds the interface and the types its callers and the in-memory fakes share.
Each `*.pg.store.ts` file holds its own SQL.

`migrations/` is a forward-only runner of raw SQL over `migrations/postgres/`. A missing directory
throws instead of migrating nothing. `0023_byte_order` gives every text column `COLLATE "C"`. Text
then sorts the same on every server whatever collation its database was created with. A new column
declares the collation. The custody path stays hand-written SQL behind `Store`.

The suites **need a Postgres database** (`BEACON_TEST_DATABASE_URL`). `global-setup.ts` fails the
run and names `pnpm test:db` when the setting is unset or the database is unreachable. Every store's
parity suite runs against Postgres and against the in-memory fake (`memory-stores.ts`) that the
service suites use. Both share the `pg-twin.ts` harness, so a fake can't drift from the store it
stands in for. A fake sorts text in byte order (`byte-order.ts`) and copies rows in and out, as the
database does. [Commands](#commands) has the recipe.

## Routes

All state-changing ops go over REST `POST`. The WebSocket carries only events from the server to the
client.

### REST

| Method | Route                                     | Purpose                                                                           |
| ------ | ----------------------------------------- | --------------------------------------------------------------------------------- |
| `POST` | `/rooms`                                  | place a room from a signed `place` op, idempotent by nonce                        |
| `GET`  | `/rooms/:id`                              | read a room's current state, or `404`                                             |
| `POST` | `/rooms/:id/ops`                          | apply a signed op such as `add`, `take` or `claim`                                |
| `POST` | `/scouts`                                 | relay a signed `report` or `cancel`                                               |
| `POST` | `/profiles`                               | publish a self-signed `ProfileDoc`                                                |
| `GET`  | `/profiles/:id`                           | read an account's public name and avatar                                          |
| `GET`  | `/discovery?cells=…&types=…`              | the anonymous spatial query                                                       |
| `GET`  | `/server/descriptor`                      | the signed `ServerDescriptor` with coverage and `capabilities`                    |
| `GET`  | `/server/about`                           | the operator's long description as Markdown, or `404 noAbout` when unset          |
| `POST` | `/mailbox`                                | **Mailbox:** send an opaque message to a recipient DID                            |
| `POST` | `/mailbox/fetch`                          | **Mailbox:** read the verified recipient's unexpired messages                     |
| `POST` | `/mailbox/ack`                            | **Mailbox:** delete delivered messages by id                                      |
| `POST` | `/media`                                  | **Media:** upload by content address and get `{ id: "<hash>@host" }`              |
| `GET`  | `/media/:hash`                            | **Media:** fetch by content address, streamed or redirected to a CDN              |
| `GET`  | `/geocode?geohash=…`                      | **Geocode:** a city, state and country label for a geohash                        |
| `GET`  | `/places?cells=…&categories=…`            | **Places:** summaries from the dataset in the queried cells                       |
| `GET`  | `/places/:unique`                         | **Places:** one place with its GeoJSON geometry and provenance                    |
| `GET`  | `/places/taxonomy`                        | **Places:** the category and subcategory vocabulary a proposal picks from         |
| `POST` | `/places/propose`                         | **Player:** propose a place or fields for one, which records a `pending` proposal |
| `POST` | `/places/proposals/fetch`                 | **Player:** read **your own** submissions and their outcomes                      |
| `POST` | `/places/admin/atlas/upload`              | **Places admin:** stage an uploaded volume archive and preview it                 |
| `POST` | `/places/admin/atlas/inspect`             | **Places admin:** preview a hosted or mounted volume                              |
| `POST` | `/places/admin/atlas/import`              | **Places admin:** import a volume as a queued run, idempotent by nonce            |
| `POST` | `/places/admin/atlas/survey`              | **Places admin:** count what a volume holds in an area                            |
| `POST` | `/places/admin/atlas/pins`                | **Places admin:** read every pin from a volume to its publisher                   |
| `POST` | `/places/admin/atlas/unpin`               | **Places admin:** remove a volume's publisher pin                                 |
| `POST` | `/places/admin/snapshots/fetch`           | **Places admin:** read one run by id, or the recent runs                          |
| `POST` | `/places/admin/snapshots/cancel`          | **Places admin:** cancel a run                                                    |
| `POST` | `/places/admin/sources/retire`            | **Places admin:** close out every record of a source that is no longer an input   |
| `POST` | `/places/admin/proposals/fetch`           | **Places admin:** the whole review queue for proposals                            |
| `POST` | `/places/admin/proposals/review`          | **Places admin:** approve or reject a proposal                                    |
| `POST` | `/places/admin/create`                    | **Places admin:** add a place by hand as an `admin` record                        |
| `POST` | `/places/admin/edit`                      | **Places admin:** set or clear fields on the admin record                         |
| `POST` | `/places/admin/conflicts/fetch`           | **Places admin:** read the conflict queue                                         |
| `POST` | `/places/admin/conflicts/resolve`         | **Places admin:** mark conflicts reviewed                                         |
| `POST` | `/places/admin/export`                    | **Places admin:** export the dataset as a `beacon-places/1` GeoJSON file          |
| `POST` | `/places/admin/import`                    | **Places admin:** import a `beacon-places/1` file as the `list:<name>` source     |
| `POST` | `/places/admin/contrib/export`            | **Places admin:** export the approved contributions as a `beacon-contrib/1` file  |
| `POST` | `/admin/status`                           | **Admin:** the descriptor's facts and the operational counts                      |
| `POST` | `/admin/rooms/remove`                     | **Admin:** remove a room through the engine's normal close path                   |
| `POST` | `/admin/media/list` `/review`             | **Admin:** browse the media store and mark media reviewed                         |
| `POST` | `/admin/media/remove`                     | **Admin:** delete a media object by content hash                                  |
| `POST` | `/admin/blocklist/add` `/remove` `/fetch` | **Admin:** manage the durable sender blocklist                                    |
| `POST` | `/admin/backup/start` `/runs`             | **Admin:** start a backup to an S3 prefix and read its runs                       |
| `POST` | `/admin/restore/inspect` `/start`         | **Admin:** check whether a backup would restore here, and restore it              |
| `POST` | `/admin/settings/get` `/set` `/reset`     | **Admin:** read the configuration, set several keys in one write or reset them    |
| `GET`  | `/docs`, `/docs/openapi.json`             | the OpenAPI document and its browsable UI (`BEACON_DOCS`)                         |
| `GET`  | `/`, `/_home/*`                           | the home page for a request that asks for HTML, and its files                     |
| `GET`  | `/health`, `/health/ready`                | liveness, and readiness backed by the store                                       |

More on the routes:

- `POST /rooms` verifies the provenance of the room and its contents. A duplicate id answers
  `409 conflict`.
- An approval on `/places/admin/proposals/review` lands a `contrib` record, and `edits` amends the
  proposal first. The first decision stands. The review queue answers whenever places is on, even
  with submissions closed.
- `/places/admin/create` is the one way to add a place that no connector produced.
- `/places/admin/import` replaces the whole list it names.
- `/places/admin/contrib/export` answers `404` unless `BEACON_PLACES_PROPOSALS_EXPORT` is on.
- `/admin/rooms/remove` sends `closed` and `roomGone` events, and racing ops see `expired`.
- The blocklist ops take effect at once.
- The backup routes answer while the server is locked, as the [deploy
  guide](../../doc/deploy.md#backup) describes. A restore exits the server so it restarts.

### Status codes

`rooms/http-status.ts` maps an `OpResult` error to an HTTP status:

| Status | Codes                                                              |
| ------ | ------------------------------------------------------------------ |
| `400`  | `invalid` and `clockSkew`                                          |
| `401`  | `badsig`                                                           |
| `403`  | `denied`, `gameNotAdmitted`, `gameNotAccepted` and `deviceRevoked` |
| `404`  | `unknownRoom` and `expired`                                        |
| `409`  | `phase`, `full`, `gone`, `empty`, `locked` and `stale`             |
| `429`  | `rateLimited`                                                      |

`deviceRevoked`, `clockSkew` and `gameNotAccepted` arrived after the capability markers. A caller
that didn't declare them in its `beacon-understands` header gets `denied`, `invalid` and `denied`
instead. The status stays the same (`common/understands.filter.ts`).

`denied`, `gameNotAdmitted` and `gameNotAccepted` share a status and differ in code on purpose. A
client's right response to each differs:

- `denied` means this server refuses the actor.
- `gameNotAdmitted` means this server refuses the actor's **game**.
- `gameNotAccepted` means this room doesn't open this op to the actor's game.

The capability routes (`/mailbox`, `/media`, `/geocode` and `/places`) **answer `404` when the
capability is off**. They add their own statuses:

| Status | Meaning                                                                                      |
| ------ | -------------------------------------------------------------------------------------------- |
| `401`  | a bad signature                                                                              |
| `403`  | a blocked sender or a DID **not on the operator list**, or a game write that fails admission |
| `404`  | a missing thing: `unknownPlace`, `unknownMedia`, `unknownProposal` or `unknownRun`           |
| `409`  | a replayed read nonce, or `tooManyPending` when a contributor's proposal queue is full       |
| `413`  | a body that is too large or over quota                                                       |
| `415`  | a media type that isn't allowed                                                              |
| `422`  | media that carries EXIF or GPS metadata                                                      |
| `429`  | `rateLimited` from a budget per DID or a budget per IP address                               |
| `503`  | the geocode upstream is unavailable                                                          |

A caller that hasn't declared one of the `404` codes in its `beacon-understands` header gets
`unknownRoute` in its place, at the same status.

Game admission applies on `places/propose`, `/mailbox` and `/media`. A game write that names no game
fails admission too.

The places reads are public and unsigned, with a read limit per IP. The **admin** routes are signed
like the mailbox and media routes. The admin routes also need the server-wide `BEACON_ADMINS` list,
because admin actions spend the outbound budget and moderate custody. So the admin routes are never
public, and they **answer `404` as if absent** when no admins are configured. A verified DID not on
the list gets the only `403`.

### WebSocket (socket.io)

| Client to server                                     | Server to client                                                      |
| ---------------------------------------------------- | --------------------------------------------------------------------- |
| `subscribe {room}` and `unsubscribe {room}`          | `delta`, a `LiveEvent` ordered by `version`                           |
| `setCells {cells}`, which replaces the watched cells | `map` with a `MapDelta` of `room`, `roomGone`, `scout` or `scoutGone` |

The watched cells are geohash-5 cells.

## Configuration

Copy [`.env.example`](.env.example) to `.env` for local development. The [deploy
guide](../../doc/deploy.md) covers the deployment settings in context.

**The environment supplies defaults and not the last word.** 42 of these settings are operator
policy. They live in the `settings` table, where an admin changes them without a redeploy. The rest
are the deployment's shape, its secrets or the access-control settings that protect the others. The
server reads those from the environment and nowhere else.
[`src/settings/registry.ts`](src/settings/registry.ts) declares which is which, and the [runtime
settings spec](../../doc/spec/runtime-settings.md) explains the split.

A change to a stored setting's variable lands on the next deploy **only if no admin has set the
setting**. A value an admin chose stays until the admin resets it. That rule is deliberate. A change
to the environment should do what an operator expects, and a redeploy should never revert a
deliberate choice without notice.

### Core

| Setting                      | Default                  | What it sets                                                                  |
| ---------------------------- | ------------------------ | ----------------------------------------------------------------------------- |
| `PORT`                       | `3001`                   | the listen port                                                               |
| `BEACON_HOST`                | `localhost:$PORT`        | the `@host` in minted `unique@host` room ids                                  |
| `BEACON_PUBLIC_URL`          | `http://localhost:$PORT` | the origin clients use for REST and the live channel                          |
| `BEACON_NAME`                | `Beacon Dev Server`      | the display name in the descriptor                                            |
| `BEACON_COVERAGE`            | every cell               | the geohash prefixes the descriptor advertises, comma-separated               |
| `BEACON_VERSION`             | `0.0.1`                  | the server version in the descriptor                                          |
| `BEACON_ACCESS_LEVEL`        | `open`                   | the access policy: `open`, `request` or `private`                             |
| `BEACON_DESCRIPTION`         | none                     | a short operator blurb in the descriptor, up to 280 characters                |
| `BEACON_ABOUT`               | none                     | the long description in Markdown, up to 8192 characters                       |
| `BEACON_CONTACT`             | none                     | the operator's email or URL, up to 200 characters                             |
| `BEACON_WRITE_LOCK`          | `off`                    | the read-only lock                                                            |
| `BEACON_MNEMONIC`            | ephemeral                | the `env` signing key: a BIP39 phrase                                         |
| `BEACON_KEY_PROVIDER`        | inferred                 | the signing-key provider: `env`, `file` or `encrypted-file`                   |
| `BEACON_KEY_FILE`            | none                     | the key file for the `file` and `encrypted-file` providers                    |
| `BEACON_KEY_PASSPHRASE`      | none                     | the passphrase that opens an `encrypted-file` key (AES-256-GCM at rest)       |
| `BEACON_DATABASE_URL`        | **required**             | the Postgres database every store runs on                                     |
| `BEACON_PG_POOL_SIZE`        | `10`                     | the most connections in the one pool every store shares                       |
| `BEACON_WRITER_LOCK_WAIT_MS` | `30000`                  | how long a booting server waits for the writer lock                           |
| `BEACON_MAX_NONCES`          | `50000`                  | the cap on the nonce log, first in and first out                              |
| `BEACON_CORS_ORIGINS`        | none                     | the allowed REST and WebSocket origins, comma-separated                       |
| `BEACON_TRUST_PROXY`         | no hop trusted           | the number of proxy hops Express trusts for `req.ip`                          |
| `BEACON_BLOCKLIST`           | none                     | DIDs refused on signed requests, which **seed** the durable blocklist at boot |
| `BEACON_ADMINS`              | none                     | the server-wide operator list for the signed admin routes                     |
| `BEACON_GAMES`               | every game               | the game slugs this server admits, comma-separated                            |

Some notes on the core settings:

- A build bakes `BEACON_VERSION` in at **build time** with the `Dockerfile` argument of the same
  name, and a release bakes its tag. The setting overrides the baked value.
- `BEACON_ACCESS_LEVEL` decides who may write. At `request` and `private` only members and admins
  may, and players ask to join a `request` server. The admin API spec covers the member list
  (`doc/spec/admin-api.md` §6).
- `GET /server/about` serves `BEACON_ABOUT` and isn't part of the descriptor. A change applies at
  once, and a value over the limit stops the boot.
- `BEACON_WRITE_LOCK` refuses writes with `503` and pauses the background writers. An admin usually
  sets the lock live (`writeLocked`), as the [deploy guide](../../doc/deploy.md#read-only-lock)
  describes.
- With no `BEACON_MNEMONIC` the identity changes on every restart.
- Without `BEACON_DATABASE_URL` the server logs why and exits 1.
- `BEACON_CORS_ORIGINS` set to `*` allows any origin. Left empty, the setting allows no cross-origin
  access.
- `BEACON_TRUST_PROXY` makes `req.ip` safe from spoofing behind a load balancer, as the [deploy
  guide](../../doc/deploy.md#beacon_trust_proxy-is-required-behind-any-edge) describes.
- An admin op unblocks a DID that `BEACON_BLOCKLIST` seeded.
- With no `BEACON_ADMINS` the admin routes answer `404`.
- An empty `BEACON_GAMES` admits every game, and so does `*`. The descriptor advertises each slug as
  `game:<slug>`. Admission gates placements, room ops, scout reports, place proposals, mail and
  media. A write that names no game is refused either way.

### Rate limits

| Setting                                   | Default | What it limits                                             |
| ----------------------------------------- | ------- | ---------------------------------------------------------- |
| `BEACON_WRITE_RATE_LIMIT_WINDOW_MS`       | `60000` | the window for write ops per IP                            |
| `BEACON_WRITE_RATE_LIMIT_MAX`             | `120`   | write ops per window                                       |
| `BEACON_WRITE_RATE_LIMIT_DEBUG`           | `off`   | `on` logs every guarded write as `key route count/max`     |
| `BEACON_OP_RATE_LIMIT_WINDOW_MS`          | `60000` | the player window per **DID**                              |
| `BEACON_OP_RATE_LIMIT_MAX`                | `120`   | player ops per account per window                          |
| `BEACON_SCOUT_RATE_LIMIT_WINDOW_MS`       | `60000` | the scout relay window per DID                             |
| `BEACON_SCOUT_RATE_LIMIT_MAX`             | `120`   | scout relay writes per account per window                  |
| `BEACON_REACT_RATE_LIMIT_WINDOW_MS`       | `60000` | the `react` window per DID                                 |
| `BEACON_REACT_RATE_LIMIT_MAX`             | `60`    | reactions per account per window                           |
| `BEACON_PLAYER_READ_RATE_LIMIT_WINDOW_MS` | `60000` | the window per IP for the anonymous **player-state** reads |
| `BEACON_PLAYER_READ_RATE_LIMIT_MAX`       | `600`   | player-state reads per IP per window                       |
| `BEACON_PLACES_READ_RATE_LIMIT_WINDOW_MS` | `60000` | the window per IP for the public places reads              |
| `BEACON_PLACES_READ_RATE_LIMIT_MAX`       | `120`   | places reads per IP per window                             |
| `BEACON_DESCRIPTOR_RATE_LIMIT_WINDOW_MS`  | `60000` | the window per IP for `GET /server/descriptor`             |
| `BEACON_DESCRIPTOR_RATE_LIMIT_MAX`        | `600`   | descriptor fetches per IP per window                       |
| `BEACON_ABOUT_RATE_LIMIT_WINDOW_MS`       | `60000` | the window per IP for `GET /server/about`                  |
| `BEACON_ABOUT_RATE_LIMIT_MAX`             | `300`   | about fetches per IP per window                            |
| `BEACON_SIGNED_READ_RATE_LIMIT_WINDOW_MS` | `60000` | the window per IP for the signed player reads              |
| `BEACON_SIGNED_READ_RATE_LIMIT_MAX`       | `300`   | `mailbox/fetch` and `places/proposals/fetch` per IP        |
| `BEACON_WS_DEBUG`                         | `off`   | `on` logs the map watch on the live channel                |

Some notes on the limits:

- The player window covers `place` and every signed room op, including the read-only `list`. The
  window keys on the verified actor and not on the IP.
- The scout relay covers `report` and `cancel`. The relay is a class of its own, so a heartbeat
  can't spend a player's room writes. A deployed scout posts once per covering server per minute.
- The `react` limit applies **on top of** the player class, so the limit can only tighten.
- The player-state reads are `/discovery`, `/rooms/:id`, `/profiles/:id` and `/media/:hash`. The
  read limits are a **backstop**. The edge is the real defense, as the [deploy
  guide](../../doc/deploy.md#what-the-edge-owns-and-what-the-server-owns) describes.
- The descriptor has its **own** bucket. The descriptor signs per request, and a client must fetch
  the descriptor to add the server. So the busy paths must not be able to use up its budget. The
  about page has its own bucket for the same reason.
- The signed player reads have a bucket of their own. They are `POST /mailbox/fetch` and
  `POST /places/proposals/fetch`. The bucket is checked before the signature, so it bounds how many
  signatures a stranger can make the server check. A player's mailbox poll is two fetches a minute
  per server.
- `BEACON_WS_DEBUG` logs connections and transports with `subscribe` and `setCells`. The setting
  also logs each `map` delta with its count of watchers.

### Capabilities

The capabilities are **off by default**. Turn each on separately, and the descriptor advertises the
set that is on.

**Mailbox** (`BEACON_MAILBOX=on`):

| Setting                               | Default         | What it sets                                                 |
| ------------------------------------- | --------------- | ------------------------------------------------------------ |
| `BEACON_MAILBOX`                      | `off`           | turns the mailbox on                                         |
| `BEACON_MAILBOX_TTL`                  | 604800 (7 days) | the message TTL in seconds, which senders can't set          |
| `BEACON_MAILBOX_MAX_BODY`             | `256`           | the largest message body in bytes (`413` over), at most 4096 |
| `BEACON_MAILBOX_RATE_LIMIT_MAX`       | `60`            | sends per DID per window                                     |
| `BEACON_MAILBOX_RATE_LIMIT_WINDOW_MS` | `60000`         | the send window per DID                                      |

**Media** (`BEACON_MEDIA=on`):

| Setting                             | Default                      | What it sets                                               |
| ----------------------------------- | ---------------------------- | ---------------------------------------------------------- |
| `BEACON_MEDIA`                      | `off`                        | turns the media store on                                   |
| `BEACON_MEDIA_MAX_BYTES`            | 5242880 (5 MiB)              | the largest object (`413` over)                            |
| `BEACON_MEDIA_QUOTA_BYTES`          | `52428800`                   | the total storage per DID (`413` over)                     |
| `BEACON_MEDIA_LIMIT_BYTES`          | none                         | the whole store's ceiling, set at deploy time              |
| `BEACON_MEDIA_RATE_LIMIT_MAX`       | `60`                         | uploads per DID per window                                 |
| `BEACON_MEDIA_RATE_LIMIT_WINDOW_MS` | `60000`                      | the upload window per DID                                  |
| `BEACON_MEDIA_TYPES`                | image types and `audio/mpeg` | the allowed MIME types                                     |
| `BEACON_MEDIA_BACKEND`              | `fs`                         | the blob backend: `fs` or `s3`                             |
| `BEACON_MEDIA_DIR`                  | `beacon-media`               | the blob directory for the `fs` backend                    |
| `BEACON_MEDIA_S3_ENDPOINT`          | none                         | the S3-compatible endpoint                                 |
| `BEACON_MEDIA_S3_REGION`            | `auto`                       | the region: `auto` for R2, or a region such as `us-east-1` |
| `BEACON_MEDIA_S3_BUCKET`            | none                         | the bucket, required for `s3`                              |
| `BEACON_MEDIA_S3_ACCESS_KEY_ID`     | none                         | the access key id, required for `s3`                       |
| `BEACON_MEDIA_S3_SECRET_ACCESS_KEY` | none                         | the secret access key, required for `s3`                   |
| `BEACON_MEDIA_S3_FORCE_PATH_STYLE`  | `false`                      | path-style addressing, for MinIO and some Spaces setups    |
| `BEACON_MEDIA_S3_PREFIX`            | none                         | a key prefix within the bucket                             |
| `BEACON_MEDIA_CDN_URL`              | none                         | a public CDN base that `GET /media/:hash` redirects to     |

Some notes on media:

- `BEACON_MEDIA_MAX_BYTES` **also sizes the JSON body parser for the whole process**, with media on
  or off. Media can be turned on at runtime.
- `BEACON_MEDIA_LIMIT_BYTES` covers every uploader and import together. Over the limit an upload
  answers `413`, and an import stops and counts what it left out.
- The EXIF and GPS check covers **images only**. A type that isn't an image (such as audio) is
  stored as is. The client must strip its metadata.
- A missing `BEACON_MEDIA_S3_BUCKET` stops the boot for the `s3` backend.

**Geocode** (`BEACON_GEOCODE=on`):

| Setting                          | Default                     | What it sets                                      |
| -------------------------------- | --------------------------- | ------------------------------------------------- |
| `BEACON_GEOCODE`                 | `off`                       | turns the geocode lookup on                       |
| `BEACON_GEOCODE_PROVIDER`        | `nominatim`                 | the provider                                      |
| `BEACON_GEOCODE_ENDPOINT`        | the public Nominatim        | the reverse-geocode base URL                      |
| `BEACON_GEOCODE_PRECISION`       | `7`                         | the geohash precision of the cache key            |
| `BEACON_GEOCODE_TTL`             | 2592000 (30 days)           | the cache TTL for a label in seconds              |
| `BEACON_GEOCODE_NEGATIVE_TTL`    | 86400 (1 day)               | the cache TTL for no label (such as the ocean)    |
| `BEACON_GEOCODE_MIN_INTERVAL_MS` | `1000`                      | the pause between outbound requests               |
| `BEACON_GEOCODE_TIMEOUT_MS`      | `8000`                      | the timeout per upstream request                  |
| `BEACON_GEOCODE_USER_AGENT`      | the version and the contact | the user agent for **all** outbound geocode calls |

Host your own Nominatim for production load. Below precision 7 the label loses its neighborhood, and
the cell's center stops being a reliable answer. Nominatim's fair use allows about one request a
second.

**Places** (`BEACON_PLACES=on`, as the [places spec](../../doc/spec/places.md) describes):

| Setting                                       | Default    | What it sets                                                    |
| --------------------------------------------- | ---------- | --------------------------------------------------------------- |
| `BEACON_PLACES`                               | `off`      | turns the places reads and the places admin routes on           |
| `BEACON_PLACES_PAGE_SIZE`                     | `1000`     | the most places per read page                                   |
| `BEACON_PLACES_QUERY_MAX_CELLS`               | `256`      | the most `cells` per query                                      |
| `BEACON_PLACES_CELL_PRECISION`                | `6`        | the precision of the `place_cells` index                        |
| `BEACON_PLACES_PROPOSALS`                     | `off`      | accepts **player-submitted** places                             |
| `BEACON_PLACES_PROPOSALS_EXPORT`              | `off`      | turns on the export of approved contributions                   |
| `BEACON_PLACES_PROPOSAL_RATE_LIMIT_MAX`       | `20`       | submissions per DID per window                                  |
| `BEACON_PLACES_PROPOSAL_RATE_LIMIT_WINDOW_MS` | `86400000` | the submission window (24 hours)                                |
| `BEACON_PLACES_PROPOSAL_MAX_PENDING`          | `10`       | the most **unreviewed** submissions per DID                     |
| `BEACON_PLACES_TIMEOUT_MS`                    | `25000`    | the timeout per request when the server fetches a hosted volume |
| `BEACON_ATLAS_STAGING_DIR`                    | the OS tmp | where uploaded volume archives stage                            |
| `BEACON_ATLAS_VOLUMES_DIR`                    | none       | the root a path import may name volumes under                   |
| `BEACON_PLACES_IMAGE_MAX_BYTES`               | `10485760` | the largest photo an import downloads                           |
| `BEACON_PLACES_IMAGE_TIMEOUT_MS`              | `15000`    | the timeout per photo fetch in an import                        |
| `BEACON_PLACES_IMAGE_MIN_INTERVAL_MS`         | `250`      | the pause between paced photo transfers                         |

Some notes on places:

- The admin routes also need `BEACON_ADMINS`.
- Reads are paged by key, and a full page returns a `cursor`. The cell cap is the bound discovery
  shares. A query's precision can go as low as the index precision minus 2.
- Proposals need places on, and the descriptor advertises them as `places-proposals`. Nothing a
  player submits publishes without an operator's review. The pending cap guards the queue against a
  flood, apart from the rate.
- The server stages in a `beacon-atlas-staging` directory it creates inside the staging directory,
  and deletes only that directory at boot. Point the setting at real disk if `/tmp` is a small tmpfs.
- With no `BEACON_ATLAS_VOLUMES_DIR` the server refuses a path import.
- An Atlas volume's own media skips the photo pacing, because the volume serves static files.

**Docs** (`BEACON_DOCS=on`) serves the generated OpenAPI document and its browsable UI at `/docs`.
`BEACON_DOCS_PATH` mounts them elsewhere. The setting is off by default, because a public server may
not want to advertise its routes.

Each signed route's request body names the route's op and the schema of its params. Both come from
the table in `src/common/signed-routes.ts`, which the controllers read their op names and params
schemas from too. A room op lists only its name, because the room's policy defines its params.

The repository commits the same document as [`openapi.json`](openapi.json), with a template server
in place of this one. So a pull request shows its API change, and each release attaches the document
to its GitHub Release with the release's version. A test fails when the file is out of date. Rebuild
the file with `pnpm --filter @beaconsgg/server-app openapi`.

**Backup and restore** (deploy time):

| Setting                               | Default | What it sets                                          |
| ------------------------------------- | ------- | ----------------------------------------------------- |
| `BEACON_BACKUP_PRIVATE_ENDPOINTS`     | `on`    | whether a backup endpoint may be on a private network |
| `BEACON_RESTORE_DATABASE_LIMIT_BYTES` | none    | the largest database a restore loads, uncompressed    |

**Home page** (deploy time, read at boot):

| Setting                   | Default                                          | What it sets                              |
| ------------------------- | ------------------------------------------------ | ----------------------------------------- |
| `BEACON_HOME`             | `on`                                             | serves the home page at `/` to browsers   |
| `BEACON_HOME_CONSOLE_URL` | `https://console.beacons.gg`                     | the operator console the page links to    |
| `BEACON_HOME_SITE_URL`    | `https://beacons.gg`                             | the network's site that the page links to |
| `BEACON_HOME_MAP_TILES`   | `https://tile.openstreetmap.org/{z}/{x}/{y}.png` | the raster tiles for the coverage map     |
| `BEACON_HOME_STATS`       | `auto`                                           | the room counts                           |
| `BEACON_SOURCE_URL`       | `https://github.com/beacons-gg/beacon.server`    | the server's source code, in the footer   |

Some notes on the home page:

- `BEACON_HOME=off` keeps `/` a `404` for everyone.
- The console link carries this server's address so the console can add it. `off` removes the link.
- The site URL feeds the footer's "Part of the Beacon Server Network" and the header's "About Beacon
  servers" (`/docs`). `off` removes both.
- `off` for the map tiles removes the map.
- The room counts show what the server holds and what changed in the last 30 days. `auto` shows them
  on an open server only, and `on` or `off` decides.
- `BEACON_SOURCE_URL` puts a source code link in the footer and takes an https URL. Unset or empty
  links the public repository, `https://github.com/beacons-gg/beacon.server`. The server is licensed
  under the AGPLv3, which asks a modified server to offer its source to the people who use it over
  a network. A server that runs a modified build must set the link to that build's code
  ([`doc/deploy.md`](../../doc/deploy.md)).

The map's tiles are the one thing the page loads from elsewhere. The visitor's browser loads them,
so the server still makes no third-party call for the page. The server serves everything else: the
fonts, the map library and the QR code. The files are gzipped, under addresses that carry their
content hash. A server whose access level isn't `open` asks search engines not to index the page.
The page and its files have their own read budget: `BEACON_HOME_RATE_LIMIT_MAX` per
`BEACON_HOME_RATE_LIMIT_WINDOW_MS` (300 per 60 seconds).

## Commands

```bash
pnpm --filter @beaconsgg/server-app typecheck
pnpm --filter @beaconsgg/server-app build        # tsc to dist, and copies the migration SQL

pnpm test:db   # from the repository root: starts the database and prints the URL below
BEACON_TEST_DATABASE_URL=postgres://beacon:beacon@127.0.0.1:55432/beacon_test \
  pnpm --filter @beaconsgg/server-app test
docker compose stop db-test   # the data directory is a tmpfs, so this also empties it
```

The suite needs a Postgres database. Both workflows start a `postgres:16` service. Locally, the
compose service `db-test` provides one. Without a database the run fails at once and prints the two
lines above.

`db-test` sits behind the compose `test` profile, so `docker compose up` never starts it. The
service publishes port 55432 on loopback only, because `db` already has 5432. The data lives in a
tmpfs. A stop discards the data, and the next start is an empty database that the suites migrate on
first use.

One container serves every suite. The suites truncate separate tables, and an advisory lock
serializes their migration runs. So the suites can run in parallel. **The isolation is per process
and not per database**, though. Two suite runs against the same `BEACON_TEST_DATABASE_URL` at once
truncate each other's rows in the middle of a test. So give a second worktree its own port.
`BEACON_TEST_DB_PORT=55433 pnpm test:db` starts a separate container, because compose names the
project after the checkout's directory. The command prints the matching URL.

To run the deployable shape (the server and Postgres), run `docker compose up --build` from the
repository root. The [deploy guide](../../doc/deploy.md) has the details.

## What the server doesn't do yet

- **A key provider for a KMS or a secret manager.** `identity/key-provider.ts` documents the seam,
  and `BEACON_KEY_PROVIDER=kms` throws by design. A hardened managed deployment needs this provider,
  as the [deploy guide](../../doc/deploy.md#a-key-from-a-secret-manager) describes.
- **A rate limiter shared across processes.** The guards run in the process, which is right for one
  server process per database. A shared limiter matters only if the topology runs several processes.
- **Metadata checks for media that isn't an image.** The EXIF and GPS check covers **images only**
  (`exifr`). An allowed type that isn't an image (such as `audio/mpeg`) is stored as is. The
  **client** must strip its metadata before upload. A server-side scanner for audio would extend the
  guarantee. So would a refusal of types the server can't inspect. An operator who wants the check
  for everything sets `BEACON_MEDIA_TYPES` to image types only.
