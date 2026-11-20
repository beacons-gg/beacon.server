# Deploy a Beacon server

A Beacon server runs as one container with a NestJS process and one PostgreSQL database. **One
server process runs per database** (see [Topology](#topology-one-process-per-database)). The server
runs its migrations at boot, so a fresh database needs no setup.

> **Note:** the server needs Postgres. Without `BEACON_DATABASE_URL` the server logs why and exits 1
> before it listens. An orchestrator then sees a failed start and not a server that
> `/health/ready` can't reach. The server no longer reads `BEACON_DB_PATH`. An old `.env` that sets
> it gets the same error with a line that says so, or a warning at boot when a URL is set too. A
> `beacon-rooms.db` file from a SQLite run isn't migrated, and no export path exists.

## Files

- **`../Dockerfile`** is a multi-stage build. Stage 1 builds the pnpm workspace. `pnpm deploy` then
  writes a bundle of `apps/server` that holds everything it needs: `dist`, the built `@beaconsgg/*`
  packages and the production dependencies. Stage 2 is a small `node:22` runtime that runs
  `node dist/main.js` as the non-root `node` user.
- **`../.dockerignore`** keeps installed dependencies, build output and the client app out of the
  build context.
- **`../docker-compose.yml`** wires the server to a `postgres:16` service. The database waits on
  `pg_isready`, and the server's health check calls `/health/ready`. The file also sets the
  environment.
- **`../docker-compose.dual.yml`** is an optional override that runs **two** separate server stacks.
  Each stack has its own database, port and `BEACON_COVERAGE`. Use the override to test several
  servers and coverage routing, as [Two servers](#two-servers) describes. The override also serves
  for contention tests.

## Run

```sh
docker compose up --build          # build the image, start Postgres and the server
curl localhost:3001/health/ready   # {"status":"ready"} once the migrations ran
docker compose down                # stop, and keep the database volume
docker compose down -v             # stop, and drop the database volume
```

> **Warning:** `docker compose down -v` deletes the database volume and every room, nonce and
> revocation in it. The deletion can't be undone.

## Released images

Every release (`.github/workflows/release.yml`) pushes this image to
`ghcr.io/beacons-gg/beacon-server`, tagged with the release tag and `latest`. The two Atlas
images ship in the same job. The [Atlas README](../apps/atlas/README.md) describes building them
locally or pulling them from a registry. Building from source with compose still works. Pull a tagged image when a deploy machine shouldn't build:

```sh
docker pull ghcr.io/beacons-gg/beacon-server:<tag>
```

`<tag>` is a release tag such as `v0.0.0-260101-1`. The images are public, so a pull needs no login.

The Postgres data lives in the named volume `beacon-pgdata`. So `docker compose restart server` or a
container crash keeps every room, nonce and revocation: the state is in the database and not in the
process.

## Upgrading to 1.1

Server 1.1 enforces `BEACON_ACCESS_LEVEL`. Before 1.1 the level was shown to players and nothing
more. An `open` server works as before. A server at `request` or `private` now takes writes only
from members and admins, and starts with no members.

Check the level before you upgrade. Leave it at `open` to keep things as they are. To keep a
non-open server's players, open **Members** in the console after the upgrade and admit everyone
with a profile on the server (`admin.access.admitAll`). Migration `0030_access` runs at boot and
adds the member list.

## Upgrading to 1.0

Server 1.0 is built on core 1.0.0, the first stable release of Beacon's wire contract. To upgrade
from 0.4, pull the 1.0 image and restart the server. The server runs its migrations at boot. No
setting is renamed, and no setting needs a change. A server older than 0.4 also takes the changes in
[From 0.3](#from-03), and a server older than 0.3 also needs the
[settings renamed in 0.3](#settings-renamed-in-03).

Clients built on core 0.3 and 0.4 keep working against a 1.0 server. The skew matrix in CI runs
the five player flows with the 0.3.4 and 0.4.3 client SDKs against the server.

### The nonce migration

Migration `0029_nonce_scope` runs at boot and needs no action. A signed request carries a nonce, and
the server remembers each nonce with the answer the request got. The server now keys that record on
the account, the op and the nonce together. The room engine's nonce log uses the same key. Before
1.0 the nonce alone was the key.

The migration keeps the records already in the database. For about 10 minutes after the server
starts it still reads those records by nonce alone. A request retried across the upgrade is
therefore not applied twice. The room engine reads its old records for the same 10 minutes, and the
nonce sweep clears them afterward.

A client sees the change in three cases:

- A request that reuses a nonce from another account or under another op is now applied. Before 1.0
  that request got the other request's stored answer back and never ran. A retry of the same signed
  request still gets its first answer.
- A console that reads and then saves with one nonce now has its save applied. Before 1.0 the save
  answered `409` `replayed`.
- A mailbox send is deduplicated per sender and nonce. Before 1.0 another account's send that
  reused a nonce got the first sender's message id back and was dropped.

### Rate limits

- `POST /mailbox/ack` now counts against the write limit like every other write. The limit is
  `BEACON_WRITE_RATE_LIMIT_MAX` (default 120) per `BEACON_WRITE_RATE_LIMIT_WINDOW_MS` (default
  60000 milliseconds) for each IP address.
- `POST /mailbox/fetch` and `POST /places/proposals/fetch` have a new budget for each IP address.
  The budget is `BEACON_SIGNED_READ_RATE_LIMIT_MAX` (default 300) per
  `BEACON_SIGNED_READ_RATE_LIMIT_WINDOW_MS` (default 60000 milliseconds). The server checks the
  budget before the signature and answers `429` `rateLimited` over the budget.

A player's mailbox poll is two fetches a minute per server. The default budget therefore covers more
than 100 players behind one address. For a crowd on shared egress raise
`BEACON_SIGNED_READ_RATE_LIMIT_MAX`, as
[`BEACON_TRUST_PROXY` is required behind any edge](#beacon_trust_proxy-is-required-behind-any-edge)
describes.

### Refusals

A route that names a missing thing answers `404` with a code for that thing:

| Route                                | Missing thing    | Code              |
| ------------------------------------ | ---------------- | ----------------- |
| `GET /places/:unique`, `places.edit` | the place        | `unknownPlace`    |
| `GET /media/:hash`                   | the media object | `unknownMedia`    |
| `places.proposals.review`            | the proposal     | `unknownProposal` |
| `places.snapshot.cancel`             | the run          | `unknownRun`      |
| `GET /server/about`                  | the about text   | `noAbout`         |

A client gets one of these codes only when the client declares the code in its `beacon-understands`
header (`code:unknownPlace` and so on). Every other client gets `unknownRoute` at the same `404`, so
the client SDKs before 1.0 keep working. `unknownRoute` now means only a route that doesn't exist or
a capability that is off.

The other refusals that changed:

- `tooManyPending` answers `409`. The code used to answer `429`. A full proposal queue clears
  when an operator reviews a proposal. A client that retries every `429` would retry this refusal
  forever. The client SDK returns the refusal body at any status, so `proposePlace` callers see no
  change.
- Bad params answer `400` `invalid` on every signed route. When unknown keys are the only
  problem, `fields` names them. The mailbox, media, admin moderation, admin settings and places
  admin routes used to answer zod's raw message with no `fields`.
- `mailbox.fetch` params must be `{}`. The client SDK sends `{}`. An unknown key answers `400`
  `invalid` with `fields`.
- An op name that isn't a room op answers `400` `invalid` on `POST /rooms/:id/ops`. The route
  used to answer `403` `denied`. `denied` still answers an op that the room's policy doesn't permit.
- The Atlas upload checks the surface first. With places off or no admins configured,
  `POST /places/admin/atlas/upload` answers `404` `unknownRoute` before the server reads the
  `x-beacon-op` header. A request without the header used to answer `400`.

### Answers and the OpenAPI document

- `places.create` and `places.edit` answer `{ ok, place }`. The `place` field now has the
  `PlaceDetail` shape that `GET /places/:unique` answers, with `hasGeometry` and `sources`. The field
  used to hold the store's internal record with `status` and `createdAt`. The operator console reads
  only `place.unique`, which is unchanged.
- The OpenAPI document at `/docs` (`BEACON_DOCS`) is OpenAPI 3.1. Version 0.4 served OpenAPI 3.0.
  Regenerate any client built from the document.
- Every operation has an `operationId` built from its method and path, such as
  `postPlacesAdminEdit`.
- Each signed request body names its op and its params schema. The params components carry core's
  names, so every `Places*Params` component is now `Place*Params`. `MailboxFetchParams` is new.
- Each route lists the refusals the route can answer. `Refusal.error` is an open string that lists
  the documented codes, because a newer server may add codes.

### Licensing and the compose file

- The server is licensed under the AGPLv3. The new `BEACON_SOURCE_URL` (default none) puts a link to
  the source code in the home page footer. A server that runs a modified build must link that
  build's source code, as [Capabilities](#capabilities) describes.
- The images carry `LICENSE` and `COPYRIGHT`. The Atlas import image now builds from the repository
  root, as the Cartographer image does. `apps/atlas/docker-compose.yml` and the release workflow
  already set that context.
- `docker-compose.yml` sets `BEACON_HOST` and `BEACON_PUBLIC_URL` to `localhost:3001` by default.
  Export your machine's LAN address in both variables when a phone must reach the server.

### From 0.3

Version 0.4 brought these changes, and a server upgraded from 0.3 takes them too:

- `BEACON_MAILBOX_MAX_BODY` (default 256 bytes) can't go above 4096 bytes. A larger value stops the
  boot with `Invalid BEACON_MAILBOX_MAX_BODY`. Lower the value to 4096 or less before you upgrade.
- A stored console override of the mailbox body limit above 4096 is ignored at boot with an error
  in the log. The limit then falls back to `BEACON_MAILBOX_MAX_BODY`. Set the override again from
  the console.
- A message body over the server's limit always answers `413` `tooLarge`. A 0.3 server answered
  `400` `invalid` to a body over 4096 characters.

## Two servers

`../docker-compose.dual.yml` runs two full stacks side by side. Each stack has its own Postgres
database, port and coverage. One machine can then test discovery across servers, coverage routing
with priority and fallback (`selectCoveringServer` and `selectPlacementServer`) and the live channel
of a contested room.

```sh
docker compose -f docker-compose.dual.yml up --build
curl localhost:3001/health/ready && curl localhost:3002/health/ready
docker compose -f docker-compose.dual.yml down -v
```

The last command stops both stacks and drops **both** database volumes.

|                   | server-a                          | server-b                          |
| ----------------- | --------------------------------- | --------------------------------- |
| Port              | `3001`                            | `3002`                            |
| Database          | `db-a` (volume `beacon-pgdata-a`) | `db-b` (volume `beacon-pgdata-b`) |
| `BEACON_COVERAGE` | `9q` (San Francisco)              | `dr` (New York)                   |
| `did:key`         | mnemonic A                        | mnemonic B                        |

YAML anchors share everything else: the image, the health check and the development CORS settings.
So the two servers differ only where they must. The setup follows the rule of one process per
database: each server is the only writer of its own database.

The **client** ties the two servers together:

1. Add **both** origins (`http://<lan-ip>:3001` and `http://<lan-ip>:3002`) to the app's list of
   approved servers. `<lan-ip>` is your machine's address on the local network.
2. Order the two servers in Settings. Each write goes to the server with the highest **priority**
   whose coverage matches. A placement that no coverage matches goes to your **fallback** server.
3. Set `BEACON_HOST` and `BEACON_PUBLIC_URL` to your machine's LAN address and not `localhost` when
   a phone must reach the servers.

To test **contention**, give both servers overlapping or empty coverage. The same cell then resolves
to both servers, and the client relays to both through the live channel.

## Configuration

The compose file sets defaults for local use. `apps/server/.env.example` lists every setting.

| Setting                      | Default     | What it sets                                                                      |
| ---------------------------- | ----------- | --------------------------------------------------------------------------------- |
| `PORT`                       | `3001`      | the listen port                                                                   |
| `BEACON_DATABASE_URL`        | none        | the Postgres connection string, **required**                                      |
| `BEACON_PG_POOL_SIZE`        | `10`        | the most connections in the one pool every store shares                           |
| `BEACON_WRITER_LOCK_WAIT_MS` | `30000`     | how long a booting server waits for another server to release the writer lock     |
| `BEACON_HOST`                | none        | the `@host` in minted `unique@host` room ids                                      |
| `BEACON_PUBLIC_URL`          | none        | the origin clients use for REST and the socket.io live channel                    |
| `BEACON_COVERAGE`            | all cells   | the geohash prefixes the descriptor advertises, comma-separated                   |
| `BEACON_NAME`                | none        | the display name in the descriptor                                                |
| `BEACON_VERSION`             | the release | the server software version in the descriptor                                     |
| `BEACON_ACCESS_LEVEL`        | `open`      | the access policy: `open`, `request` or `private`                                 |
| `BEACON_DESCRIPTION`         | none        | a short operator blurb in the descriptor, up to 280 characters                    |
| `BEACON_ABOUT`               | none        | a long description in Markdown, up to 8192 characters                             |
| `BEACON_CONTACT`             | none        | the operator's email or URL, up to 200 characters                                 |
| `BEACON_CORS_ORIGINS`        | none        | the allowed REST and WebSocket origins, comma-separated                           |
| `BEACON_WRITE_LOCK`          | `off`       | the read-only lock, as [Read-only lock](#read-only-lock) describes                |
| `BEACON_GAMES`               | every game  | the game slugs this server admits, as [Game admission](#game-admission) describes |
| `BEACON_MNEMONIC`            | none        | the signing key for the **env** provider, for development                         |
| `BEACON_KEY_PROVIDER`        | inferred    | the signing-key provider: `env`, `file` or `encrypted-file`                       |
| `BEACON_KEY_FILE`            | none        | the key file for the **file** and **encrypted-file** providers                    |
| `BEACON_KEY_PASSPHRASE`      | none        | the passphrase that opens an **encrypted-file** key file (AES-256-GCM at rest)    |

Some notes on those settings:

- `BEACON_WRITER_LOCK_WAIT_MS` is in milliseconds. After the wait the server refuses to start, as
  [Topology](#topology-one-process-per-database) describes.
- A server that starts before its database waits up to 60 seconds for Postgres to accept a
  connection. The server logs each attempt and exits after the wait. A wrong password or a missing
  database stops the server at once.
- An empty `BEACON_COVERAGE` covers every cell, and so does `*`.
- A released image sets `BEACON_VERSION` to its release tag without the `v`. A build from source
  defaults to `0.0.1`. The setting overrides either.
- `BEACON_ACCESS_LEVEL` decides who may write. At `request` and `private` only members and admins
  may, and reads stay open. The [admin API spec](spec/admin-api.md) §6 covers the member list.
- `GET /server/about` serves `BEACON_ABOUT`, and the server applies a change at once. A value over
  the limit refuses to boot.
- `BEACON_CORS_ORIGINS` set to `*` allows any origin. Left empty, the setting allows no cross-origin
  access.
- The key settings are described in [Signing-key management](#signing-key-management).

### Settings renamed in 0.3

0.3 renamed these settings so that every name follows one pattern. Rate limits are
`BEACON_<AREA>_RATE_LIMIT_MAX` and `_WINDOW_MS`. The old names have no aliases. While an old name is
set, the server refuses to start and names the setting that replaced it.

| Old name                                | New name                                      |
| --------------------------------------- | --------------------------------------------- |
| `BEACON_RATE_LIMIT_MAX`                 | `BEACON_WRITE_RATE_LIMIT_MAX`                 |
| `BEACON_RATE_LIMIT_WINDOW_MS`           | `BEACON_WRITE_RATE_LIMIT_WINDOW_MS`           |
| `BEACON_RATE_LIMIT_DEBUG`               | `BEACON_WRITE_RATE_LIMIT_DEBUG`               |
| `BEACON_READ_RATE_LIMIT_MAX`            | `BEACON_PLACES_READ_RATE_LIMIT_MAX`           |
| `BEACON_READ_RATE_LIMIT_WINDOW_MS`      | `BEACON_PLACES_READ_RATE_LIMIT_WINDOW_MS`     |
| `BEACON_MAILBOX_RATE_MAX`               | `BEACON_MAILBOX_RATE_LIMIT_MAX`               |
| `BEACON_MAILBOX_RATE_WINDOW_MS`         | `BEACON_MAILBOX_RATE_LIMIT_WINDOW_MS`         |
| `BEACON_MEDIA_RATE_MAX`                 | `BEACON_MEDIA_RATE_LIMIT_MAX`                 |
| `BEACON_MEDIA_RATE_WINDOW_MS`           | `BEACON_MEDIA_RATE_LIMIT_WINDOW_MS`           |
| `BEACON_PLACES_PROPOSAL_RATE`           | `BEACON_PLACES_PROPOSAL_RATE_LIMIT_MAX`       |
| `BEACON_PLACES_PROPOSAL_RATE_WINDOW_MS` | `BEACON_PLACES_PROPOSAL_RATE_LIMIT_WINDOW_MS` |
| `BEACON_GEO_USER_AGENT`                 | `BEACON_GEOCODE_USER_AGENT`                   |
| `BEACON_PLACES_CONTRIBUTIONS`           | `BEACON_PLACES_PROPOSALS`                     |
| `BEACON_PLACES_CONTRIB_EXPORT`          | `BEACON_PLACES_PROPOSALS_EXPORT`              |
| `BEACON_BLACKLIST`                      | `BEACON_BLOCKLIST`                            |

Three values changed with the names:

- `BEACON_CORS_ORIGINS` left empty now allows **no** cross-origin request. The setting used to allow
  every origin. Set `*` to allow every origin, or list your clients' origins.
- The debug switches (`BEACON_WRITE_RATE_LIMIT_DEBUG` and `BEACON_WS_DEBUG`) take `on` and `off`
  like every other switch.
- `BEACON_MEDIA_MAX_BYTES` defaults to 5 MiB (5242880 bytes). Byte sizes are binary throughout.

The capability a server advertises for player place proposals is now `places-proposals`. The old
name was `places-contrib`.

## Capabilities

Each capability is turned on separately and advertised in the signed descriptor. A capability that
is off answers `404`. The [server README](../apps/server/README.md#configuration) lists every
setting.

- **`BEACON_MAILBOX`** turns on the mailbox, a notification drop per recipient. Send, fetch and ack are signed. The server decides the TTL.
- **`BEACON_MEDIA`** turns on the content-addressed media store. The store keeps files on the local
  disk (`fs`) or in S3 (`s3`), and `BEACON_MEDIA_CDN_URL` can serve them by redirect. Both compose
  files include MinIO, so the S3 path runs without cloud credentials.
- **`BEACON_GEOCODE`** turns on a cached reverse-geocode lookup. The default provider is Nominatim,
  and a busy server should host its own.
- **`BEACON_PLACES`** turns on the server's own curated place dataset, as the [places
  spec](spec/places.md) describes. Public reads always serve the server's own store.
- **`BEACON_DOCS`** serves the OpenAPI document and its browsable UI at `/docs`. Consider leaving
  the setting off on a public server.
- **`BEACON_HOME`** serves the home page a browser gets at `/` (default `on`).

The places dataset fills only over the signed admin routes that `BEACON_ADMINS` allows. The dataset
takes places from exactly **three inputs** (the Atlas integration spec,
[`beacon-integration.md`](../apps/atlas/doc/spec/beacon-integration.md) §6):

- an **Atlas volume import**, at runtime from the console by URL or by uploaded archive;
- a `beacon-places/1` GeoJSON import, with the matching export;
- the operator's edits per field and the review queue for player proposals.

No path calls a third party. The dataset starts empty, so import a volume for each deployment. The
publisher a volume pins is durable state and needs no setting. A server upgraded from a release that
still had OSM connectors closes out its `osm` records with `places.source.retire`. Run that op
_after_ you import the volumes that cover the region.

The home page shows the server's details, its address, a QR code that adds the server to a game and
the server's coverage on a map:

- `BEACON_HOME_MAP_TILES` sets the map tiles. The default is OpenStreetMap's, and `off` removes the
  map. The visitor's browser loads the tiles, and the server never does. The tiles are the only
  thing the page loads from elsewhere.
- `BEACON_HOME_CONSOLE_URL` and `BEACON_HOME_SITE_URL` set or turn off the page's two outbound
  links.
- `BEACON_HOME_STATS` shows the room counts. By default an open server shows them. Set `on` or `off`
  to decide.
- `BEACON_SOURCE_URL` (default `https://github.com/beacons-gg/beacon.server`) is the footer's link to
  the server's source code, an https URL. Unset or empty links the public repository.
- Behind a proxy `BEACON_PUBLIC_URL` must be the address players use, because the QR code carries
  that address.

The server is licensed under the AGPLv3. Section 13 of the license says a server that runs a
modified build must offer that build's source to the people who use the server over a network. If
you run a modified build, set `BEACON_SOURCE_URL` to that build's source code. With `BEACON_HOME=off`
the page is gone, so offer the source another way.

### Game admission

`BEACON_GAMES` says what this server is for. Empty (the default) admits every game, which suits a
general-purpose server. Set it to the slugs you run the server for, such as `kites`. The descriptor
then advertises each slug as a `game:<slug>` capability, so a client can tell before it tries. A
slug is opaque to the protocol, so `kites/1` works too if you want to pin a build. What you put here
decides whether a slug names a game, a publisher or a release. An invalid slug stops the boot
instead of admitting nothing.

Whatever you set, **every game write must name its game**. Without a game the server refuses these
writes with `gameNotAdmitted`:

- placements and room ops;
- scout reports;
- place proposals;
- mailbox sends and media uploads.

A media upload signed by one of `BEACON_ADMINS` is the exception: the console's place photos belong
to no game. No setting changes that rule. A room belongs to the game that placed it. Only that
game's ops apply to the room, unless the room's policy opens an op to other games. The admin routes
and profile publishes aren't game writes and are never gated.

Two points are easy to get wrong:

- **Game admission is segmentation and not security.** The client attests its own slug. The slug
  rides inside the signed op envelope, so nothing can change the slug in transit. The signer is the
  _player's_ device key, though, and a modified build holds one of those too. Admission keeps a
  well-meaning second game out of your server's way. Admission does nothing against a player who
  edits their client, and isn't meant to.
- **Admission gates writes and only filters reads.** Discovery, room reads and the live map take a
  game filter so each game sees its own content. The caller applies the filter. A server set to
  `kites` is still readable by anyone who asks without the filter. A server that strangers can't
  read needs network isolation: a VPN or a proxy that authenticates.

Rooms and mail written before game slugs carry no game. No game can read or act on them until they
are stamped. The server logs how many there are at boot.

### The operator allowlist

**`BEACON_ADMINS`** is the server-wide list of operators. The setting isn't a capability, and the
descriptor never advertises it. The list gates the signed admin routes, as the [admin API
spec](spec/admin-api.md) describes. The routes include `POST /admin/status`, the moderation ops and
the places admin routes. The moderation ops are `admin.room.remove`, `admin.media.remove` and the
durable `admin.blocklist.*`. `BEACON_BLOCKLIST` seeds the blocklist table at boot. An empty list
(the default) turns the admin routes off, and they answer `404` as if absent.

The **operator console** (beacon.admin) is the companion app. A browser wallet signs every admin
request. The console holds no state on its server, so the console deploys as static files or with
`next start`. To pair the console with a server, put the wallet's account DID in `BEACON_ADMINS` and
the console's origin in `BEACON_CORS_ORIGINS`.

## What the edge owns, and what the server owns

The server **never terminates TLS**: `main.ts` listens over plain HTTP. So every public deployment
has an edge in front of the server. The edge can be a cloud ingress, a CDN, Caddy, nginx or a
Cloudflare tunnel. This repository ships an image and not a topology, and community operators choose
their own edge. So this section states how the work divides.

The rule is that **a control belongs where its key becomes trustworthy**.

| Layer          | Owns                                                       | Why                                                                                      |
| -------------- | ---------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| **The edge**   | TLS, floods, body caps, network blocks and media bandwidth | The edge keys on IP, path and packet shape. The edge sees those first and at least cost. |
| **The server** | anything keyed on a **verified identity**                  | The key exists only once the signature verifies, and verification is the server's job.   |
| **Both**       | per-IP read limits on the anonymous routes                 | The edge is the real defense, and the server's guards are the floor.                     |

The server's verified controls are the sender blocklist and the per-DID budgets, with device
revocation and item provenance. A proxy that read `actor` without verifying the signature would gate
on a claim anyone can put in a body. The media bandwidth at the edge is the traffic on
`GET /media/:hash`.

The server's read guards are the floor for a deployment whose edge does TLS and nothing else, which
is most of them. The floor covers REST only. The live socket's `subscribe` and `setCells` serve the
same map deltas as `GET /discovery` and carry no budget. So the read limits don't cover everything
discovery exposes.

**A rate limit isn't an admission gate.** The guards bound how _fast_ a stranger who learns the URL
reads this server. The guards don't stop the stranger reading. This server doesn't restrict who may
read. Network isolation through a VPN or a proxy that authenticates remains the answer
for a server that must not be reachable.

### `BEACON_TRUST_PROXY` is required behind any edge

Every rate limiter here keys on `req.ip`. Express resolves `req.ip` from `X-Forwarded-For` **only**
as far as the configured `trust proxy` hop count. The default is `false`, which trusts no hop and
resolves to the socket peer. **Behind a load balancer the socket peer is the load balancer.** So
with the default every client shares one key, and the budgets stop binding per client without
notice.

- **Count the hops** between the client and the container and set that number. One ingress or one
  reverse proxy is `BEACON_TRUST_PROXY=1`. A CDN in front of an ingress is `2`.
- **Don't set `true`.** `true` trusts the whole chain. `req.ip` then becomes the leftmost
  `X-Forwarded-For` entry, which the client controls. A caller could then defeat every limiter by
  rotating a header.
- **Check the setting at boot.** The startup line reports the resolved key. The line
  `clientKey=socket-peer (BEACON_TRUST_PROXY unset)` on a deployment with an ingress shows the
  mistake without a repro.

**One key is often several players, even when the setting is right.** Carrier NAT and a venue's
Wi-Fi put many clients on one address. A location game gathers people at one real-world place on
purpose. That is why the _write_ budgets key on the verified account and not on IP. Reads can't do
the same, because reads are anonymous by design and IP is the only key. So in honest play the read
guards fire only for a crowd on shared egress. The fix there is to raise
`BEACON_PLAYER_READ_RATE_LIMIT_MAX` and not to change the key. If players report `429` answers at an
event, raise that setting. The signed reads of a player's mail and proposals (`POST /mailbox/fetch`
and `POST /places/proposals/fetch`) have their own budget for each IP address. The budget is
`BEACON_SIGNED_READ_RATE_LIMIT_MAX` (default 300) per `BEACON_SIGNED_READ_RATE_LIMIT_WINDOW_MS`
(default 60000 milliseconds). A crowd can reach that budget the same way, so raise
`BEACON_SIGNED_READ_RATE_LIMIT_MAX` for a crowd too.

**A wrong setting fails in both directions.** One key for every caller _loosens_ the per-client
budgets. One key also _tightens_ the shared budgets, because one global budget then covers every
player. `GET /server/descriptor` has its own bucket so that other traffic can't use up the path that
adds a server. The player-state reads share their budget, though. With this setting wrong, a busy
server can answer `429` to its own players.

The same holds for the write limiter. A small player base rarely hits a pooled budget, so the
mistake can go unnoticed for a long time.

## Signing-key management

The server holds its own account key pair. The key's `did:key` is the stable identity the server
signs its coverage descriptor with. So the key must be **stored securely** and stay **stable across
restarts** (beacon.core `doc/spec/identity.md` §11). A provider in
`apps/server/src/identity/key-provider.ts` sources the key, and the configuration selects the
provider:

- **`env`** (`BEACON_MNEMONIC`) is the default for development. A fixed BIP39 phrase keeps the
  identity stable across restarts. With no phrase the identity is **ephemeral** and changes on every
  restart. That suits local development and never a server that players discover. Keep the phrase
  out of source control, because the phrase is the private key.
- **`file`** (`BEACON_KEY_FILE`) suits local and self-hosted production. The key file holds a BIP39
  phrase, and the same file always recovers the same `did:key`. The provider **refuses a file that
  the group or others can read**. Mount the file with mode `600`, owned by the container's `node`
  user. An example compose override follows the list.
- **`encrypted-file`** (`BEACON_KEY_FILE` and `BEACON_KEY_PASSPHRASE`) suits self-hosted production
  with the key **encrypted at rest**. The provider is described below.
- **`kms` is a documented seam and isn't implemented.** The provider is described below.

```yaml
services:
  server:
    environment:
      BEACON_KEY_PROVIDER: file
      BEACON_KEY_FILE: /run/secrets/beacon-key
    secrets:
      - beacon-key
secrets:
  beacon-key:
    file: ./secrets/beacon-server.key # chmod 600 on the host
```

### The encrypted-file provider

The key is encrypted with AES-256-GCM under a key derived by scrypt. Unlike `file`, the security
rests on the passphrase and not on file permissions. So the passphrase must come from the
orchestrator's secret settings and never from source control.

The provider doesn't check the file's mode, on purpose. An orchestrator that mounts files with
default permissions can deliver an encrypted key, and couldn't deliver a plain one. Where you can,
still set mode `600` for defense in depth. Where you can't, two points matter more:

- Use a generated passphrase such as the output of `openssl rand -base64 32`. Anyone who can read
  the file can copy it and attack the passphrase offline. The minimum of 8 characters is a floor and
  not a recommendation.
- Keep the file and the passphrase in separate systems if the orchestrator allows. A system that
  holds both protects the key only as well as it protects itself.

Create the key file with the operator helper:

```sh
BEACON_KEY_PASSPHRASE='<passphrase>' node apps/server/scripts/encrypt-mnemonic.mjs '<recovery-phrase>' > beacon.key.enc
```

`<passphrase>` is the passphrase you generated, and `<recovery-phrase>` is the server's BIP39
phrase. Then set `BEACON_KEY_PROVIDER=encrypted-file` and
`BEACON_KEY_FILE=/run/secrets/beacon.key.enc`. Supply `BEACON_KEY_PASSPHRASE` from your secret
store. The server infers the provider when a key file and a passphrase are both present. Set the
provider explicitly anyway. A missing passphrase is then reported as missing. Without the setting
the server would infer a plain `file` and refuse the file for its permissions.

### A key from a secret manager

A managed deployment should keep the account root in a secret manager and never on the container's
filesystem. AWS Secrets Manager, GCP Secret Manager and HashiCorp Vault are examples. The plug point
is `ServerKeyProvider` in `key-provider.ts`. A new provider fetches the phrase or seed from the
store at boot and returns `accountFromMnemonic(...)`, and `resolveKeyProvider()` selects the new
provider. Today `BEACON_KEY_PROVIDER=kms` throws by design. The `TODO` block in `key-provider.ts`
describes the two shapes and what each needs. In one shape the secret manager holds the phrase. In
the other a KMS signs and never exports the key.

### Rotation

The account root is the durable identity, and a **device key** rotates under the root. The client
works the same way (beacon.core `doc/spec/identity.md` §11).
`ServerIdentity.rotateSigningKey()` mints a new device key that the root authorizes and signs the
descriptor again. The advertised `did:key` doesn't change, because the change is a rotation and not
a migration. This release has no route or setting that calls `rotateSigningKey()`, so an operator
can't rotate the device key yet.

Rotating the **account root** changes `did:key`. Every client that pinned the old identity must
discover the server again. That change is a **migration** (beacon.core `doc/spec/identity.md` §11).
To migrate, provision a new root in the key provider. The new root can be a new phrase, key file or
secret.

## Read-only lock

`writeLocked` makes a server read-only for maintenance or a final backup. An admin sets the value
with `admin.settings.set`. The change is signed, audited and shown like any other setting. The lock
takes effect on the next request. `BEACON_WRITE_LOCK=1` supplies the default, so a server started
with the setting comes up locked. A value an admin has set overrides the default, as with any
runtime setting. The server stores a lock an admin sets, so a restart can't lift the lock.

While the server is locked:

- Every `POST` is refused with `503` and `Retry-After: 60`, unless the route is marked to answer. An
  admin can then see and lift the lock and take a backup. Signed reads such as `admin.media.list`
  and `mailbox/fetch` are refused too. So are room and media removal, place edits and the Atlas
  routes.
- Clients retry a 5xx, but nothing queues a player's action. A signed request goes stale after five
  minutes. So a game's writes and mailbox stop for the length of the lock, and players try again
  afterwards. Keep a lock on a live server short.
- `GET` routes still answer. A media fetch doesn't stamp `last_access_at`, and a geocode lookup
  doesn't cache its answer.
- The room timers pause. So do the nonce, mailbox and geocode sweeps. Rooms that came due during the
  lock fire within a minute of the unlock, with no restart.

These routes answer while the server is locked:

- `admin.status`;
- `admin.settings.get`, `admin.settings.set` and `admin.settings.reset`;
- reading or canceling a place run;
- the backup and restore routes.

The server refuses a lock while a place import is queued or running. Wait for the import to finish,
or cancel it. Setting the lock doesn't wait for a request already in flight. A backup taken while
locked waits until the lock is 15 seconds old, so those writes land first.

## Backup

An admin (`BEACON_ADMINS`) starts a backup from the console with `admin.backup.start` over a signed
envelope, and follows it with `admin.backup.runs`. A backup writes to an S3 bucket or an
S3-compatible store, and MinIO covers anyone without S3. The admin types the credentials in for each
run, and the server never stores or logs them. One backup or restore runs at a time. The next boot
closes out an interrupted run.

A backup is a folder and not an archive, because photos make a backup large:

```text
manifest.json              written last; a run that dies leaves the previous backup in place
db/<timestamp>/*.copy.gz   gzipped COPY output of every table except schema_migrations and backup_runs
media/<aa>/<hash>          the files the snapshot's media rows name; a second run uploads only new ones
media-missing.txt          hashes of rows whose file was missing or corrupt, when any were
identity.key               the server's recovery phrase, when included
```

A backup is consistent on a live server. The database is one `REPEATABLE READ` snapshot taken first,
and the files follow the snapshot. The server writes a photo's file before the photo's row. Lock the
server first for a final copy that nothing can change afterwards, and the manifest then records
`locked: true`. Settings supplied by environment variables are written into the backup's `settings`
rows, so the restored server keeps them.

`identity.key` is optional. Only a restore that includes the key comes up as the same server. A
server with no stored key material has an ephemeral identity. When the key was asked for, such a
server warns that it can't restore as itself.

An admin chooses where a backup goes, so the endpoint is the admin's input.
`BEACON_BACKUP_PRIVATE_ENDPOINTS` (default `on`) decides at deploy time whether the endpoint may be
on a private network. MinIO on a LAN needs the default. A hosting provider sets the value to `off`.
The server then refuses a start with `400` when the endpoint is or resolves to a non-public address.
Loopback, private and link-local addresses are all non-public. The server checks each connection
again as it opens, so a name can't point elsewhere after the check.

### Restore

A restore is the same job in reverse. A server takes a restore when it holds no player data, or when
this job already restored it and the server is locked. So an owner can restore once to load the
photos early and again after the final backup. `admin.restore.inspect` reads the manifest and says
in a sentence why this server wouldn't restore it. The server refuses:

- a schema newer than its own;
- media over `BEACON_MEDIA_LIMIT_BYTES`;
- a database over `BEACON_RESTORE_DATABASE_LIMIT_BYTES`, uncompressed and counted as it loads;
- a backup of another server whose key the server can't take.

`admin.restore.start` runs the restore:

- The server locks itself for the restore, so a crash stays safe. A failed restore stays locked and
  says so. Lift the lock with `admin.settings.set` once the data looks right, or retry.
- The server copies the photos first, while the old data still serves. A file absent from the backup
  is a warning. On a second restore, a file whose photo is no longer in the backup is removed
  afterwards.
- The server replaces the database in one transaction. A failed load rolls back, and a retry starts
  from where this one began. An older backup loads at its own schema version and is migrated
  forward. Reads wait while the restore holds the tables, and so do health checks.
- The server drops `publicUrl`, `mediaCdnUrl` and a `mediaEnabled=false` setting. Those belong to
  the old machine. The lock comes from the backup: a backup taken locked restores locked.
- The server then exits with status 75, so the server comes back with the restored state in memory.
  The compose files set `restart: unless-stopped`.

> **Warning:** a server run without a restart policy must restart itself after a restore. A server
> that doesn't restart keeps answering from what it held before.

A restored server becomes the server in its backup, whatever its environment says. Room ids and
photo addresses contain the server's name, and players' apps trust the server's key. From then on
the name replaces `BEACON_HOST`, so renaming a restored server isn't supported.

A server with `BEACON_KEY_PASSPHRASE` set takes the backup's `identity.key`. The server keeps the
key in the database sealed with the passphrase. The server refuses to boot when the passphrase can't
open the key. Without a passphrase, start the server with the backup's key instead
(`BEACON_KEY_PROVIDER=file` and `BEACON_KEY_FILE`). Keep the passphrase, because the passphrase now
opens the server's identity.

So you can restore a server and check it at any address before the domain moves. To switch over:

1. Point the domain at the server.
2. Check the server.
3. Unlock the server.

Until the unlock you can roll back: point the domain back and unlock the old server. Players' apps
send ids and photo addresses to the original domain. So a phone reaches the new server only once the
domain has moved. Until then, check the server from the console and with `GET /media/<hash>`.

> **Warning:** backups aren't encrypted, and `identity.key` is the plain recovery phrase. Secure the
> bucket.

A backup is sized for a small server (0.5 CPU and 512 MB). Database tables stream with no buffering
beyond the upload parts, and photos are copied a few at a time.

## Topology: one process per database

The server holds the in-memory `KeyedMutex`, `geoIndex` and timer wheel. So the server must be the
**only writer** of its database. **Don't** run `server` with `replicas > 1` against one database.
Two separate mutexes would let two ops interleave on one room and break the guarantee that nothing
is spent twice.

Scaling out would take optimistic concurrency in the database, a distributed lock or room sharding.
That change isn't built.

The server enforces the one-writer rule itself. Before the server touches its database, it takes a
Postgres session advisory lock and holds the lock on its own connection for as long as it runs. A
second server on the same database waits up to `BEACON_WRITER_LOCK_WAIT_MS` (default 30 seconds) for
the first to stop. The second server then refuses to start and names the problem. A wait of 0
refuses at once.

If the server loses the connection that holds the lock, the server exits and doesn't serve on
without the lock. A failed ping or Postgres ending the connection both count. Postgres keeps short
keepalives on its side of that connection. So the lock of a server that vanished is released within
about 25 seconds.

The wait covers a redeploy that **stops the old container and then starts the new one**. The wait
also covers an orchestrator that starts the new container shortly before the old one has exited. The
wait can't cover an update that starts the new container first and stops the old one once the new
one is healthy. The new server waits for the lock before it listens, so the new server never becomes
healthy while the old one runs. The deploy then fails when the wait runs out. Use an update order
that stops first, such as `docker compose up` recreating the container or Swarm's
`update_config.order: stop-first`.

The lock takes one connection beyond `BEACON_PG_POOL_SIZE` for the server's whole life. Count that
connection when you size Postgres's `max_connections`.
