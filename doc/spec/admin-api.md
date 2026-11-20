# Admin API

This spec covers the server's admin surface: how an operator is authorized and which signed routes
an operator console calls. Through those routes an operator watches, moderates and configures a
server. The console itself is a separate application.

Checked against Beacon 0.3.

## 0. Overview

- **One allowlist.** `BEACON_ADMINS` lists the operators' account DIDs. One shared gate guards every
  admin route.
- **One credential.** An operator signs an `OpEnvelope` for each request with the same Ed25519
  `did:key` a player uses. The server issues no passwords, tokens or API keys.
- **The routes.** The surface offers these groups of routes:
  - a status overview;
  - moderation of rooms and media;
  - a durable blocklist;
  - media review;
  - the runtime settings;
  - backup and restore;
  - the places curation routes ([places](places.md) §6.3).

## 1. Authorization: signed requests only

The admin credential is the platform credential: an Ed25519 `did:key` that signs `OpEnvelope`s. An
operator console is one more client that holds a key, like a game.

| Option                     | Result                                                                                       |
| -------------------------- | -------------------------------------------------------------------------------------------- |
| Signed requests (Beacon's) | one trust model with no server secrets, attribution on every action and many servers at once |
| Session tokens             | a second auth system with session state and a window for token theft                         |
| API keys                   | shared secrets on the server, no per-action attribution and slow rotation across servers     |
| OAuth or OIDC              | an outside identity dependency for tooling that manages self-hosted servers                  |

Signed requests win on four counts:

- The server holds no secret that could leak, because it only verifies signatures.
- Each request is replay-safe through the durable nonce log and the `issuedAt` freshness window, so
  no session artifact exists to steal.
- Every admin action is attributed to a DID that anyone can verify offline. A run's `requestedBy`
  and a source record's `editedBy` work this way.
- One operator DID manages many servers. Each server checks its own allowlist, and no cross-server
  session exists.

The wire packages `@beaconsgg/identity` and `@beaconsgg/protocol-types` are plain TypeScript and run
in a browser. A console signs requests in the browser with the same functions a game uses, and the
operator's key never reaches a server.

The surface has one role. A DID is on `BEACON_ADMINS` or it isn't.

## 2. The admin gate

Every admin route passes one gate, in this order:

1. With no admins configured the route answers `404` `unknownRoute` as if absent. The gate does no
   signature work first.
2. The shared signed-request gate checks the op name and the signature. The gate then checks
   `issuedAt` freshness, the blocklist and device revocation. The
   [mailbox and media](mailbox-and-media.md) spec describes this gate in §3.2.
3. The verified actor must be on `BEACON_ADMINS`, or the route answers `403` with `denied`.

A route of an optional capability first answers `404` when its capability is off. The places admin
routes therefore answer `404` when `BEACON_PLACES` is off or `BEACON_ADMINS` is empty. Only a
verified actor who isn't an admin gets `403`.

The gate owns two brackets that routes reuse:

- **The signed read.** A fetch-style route parses its params and records the nonce. A repeated nonce
  answers `409`, so a captured read can't be replayed.
- **The idempotent write.** A write runs once per nonce. A retry with the same nonce returns the
  first result and changes nothing.

The nonce log keys each record on the actor and the op beside the nonce. A write therefore never
answers with another op's record ([mailbox and media](mailbox-and-media.md) §3.2). Params that don't
parse answer `400` `invalid` on every admin route, with `fields` naming the keys this server doesn't
know when those are the only problem. That includes the moderation routes and the settings writes.

**The admin surface isn't advertised.** The descriptor lists no admin capability, because an
operator's console already knows its servers and a stranger gains nothing from a map of the surface.
The durable nonce log runs whatever capabilities are on, so the admin routes are replay-safe on any
server.

Every route is a `POST` because each carries a signed body. That holds for signed reads too.

## 3. Routes

A console reads public routes wherever they are enough: `GET /server/descriptor`, `GET /discovery`
and `GET /places`. The admin routes add what those don't show.

### Status

`POST /admin/status` (`admin.status`, a signed read) answers one overview for a dashboard:

```ts
{
  host, name, version, startedAt, accessLevel, coverage, capabilities, // the descriptor's facts
  writeLocked,                 // whether the server is locked read-only
  counts: {
    rooms,                     // live rooms of every type
    profiles,                  // published profiles
    places, placesRetired,
    conflictsPending,          // unresolved place conflicts
    snapshots,                 // recorded place runs
    mediaObjects, mediaBytes,
    mediaLimitBytes,           // the store's limit, when one is set
    mediaUnreviewed,           // media objects no admin has reviewed
    accessPending,             // requests to join no admin has answered (§6)
  },
}
```

The facts come from the same mapping that builds the signed descriptor, so the status and the
descriptor never disagree. Each count is one aggregate query.

### Moderation

| Route                 | Op                   | Does                                                                           |
| --------------------- | -------------------- | ------------------------------------------------------------------------------ |
| `/admin/rooms/remove` | `admin.room.remove`  | removes a room `{id, reason?}` through the engine's normal close path          |
| `/admin/media/remove` | `admin.media.remove` | deletes a media object `{hash, reason?}`, the blob first and then its metadata |

Removing a room runs under the room's lock like any other change. Watchers get the standard `closed`
room event and the `roomGone` map delta, and an op that races the removal gets `expired`. Both
routes answer `{ removed }`, which is `false` when the target didn't exist.

A removed media object comes back if someone uploads the same bytes, since the address is the hash.
Blocking the owner is the remedy for repeated abuse.

### Blocklist

| Route                     | Op                       | Does                           |
| ------------------------- | ------------------------ | ------------------------------ |
| `/admin/blocklist/add`    | `admin.blocklist.add`    | blocks a DID `{did, reason?}`  |
| `/admin/blocklist/remove` | `admin.blocklist.remove` | lifts a block `{did, reason?}` |
| `/admin/blocklist/fetch`  | `admin.blocklist.fetch`  | lists the blocks               |

A block refuses every signed request from that DID from the next request on. The room ops and
profile publishing consult the same list. The list is a durable table behind an in-memory cache, so
the check on each request is a set lookup.

`BEACON_BLOCKLIST` seeds the table at boot. A seed adds only DIDs that have no row, so a seed never
overwrites a row an admin wrote. Removing a DID from the variable lifts nothing once the DID is
seeded: lift the block with `admin.blocklist.remove`. A seeded entry's `addedBy` is `env`.

The server never blocks a DID on `BEACON_ADMINS`. The gate checks the blocklist before the
allowlist, so a blocked admin couldn't reach the op that lifts the block. An add for an admin
answers `400`, and a seed for one is skipped with a warning.

### Media review

| Route                 | Op                   | Does                                                       |
| --------------------- | -------------------- | ---------------------------------------------------------- |
| `/admin/media/list`   | `admin.media.list`   | one page of the media store's metadata (a signed read)     |
| `/admin/media/review` | `admin.media.review` | sets or clears an object's review stamp `{hash, reviewed}` |

The list takes `owner`, `type` and `reviewed` filters and sorts by `recent` or by `size`. A page
holds up to 100 items, and an opaque `cursor` walks the pages by keyset. Each item carries the hash,
type, size and owner. An item also carries its upload, access and review times. The bytes were
already public by hash, so the list adds only the ability to enumerate. Enumeration stays behind
`BEACON_ADMINS`.

A review stamp records who reviewed an object and when. The stamp belongs to the content hash, so a
deleted and re-uploaded object needs a new review.

### Settings

| Route                   | Op                     | Does                                                  |
| ----------------------- | ---------------------- | ----------------------------------------------------- |
| `/admin/settings/get`   | `admin.settings.get`   | the whole configuration, editable and read-only alike |
| `/admin/settings/set`   | `admin.settings.set`   | overrides one or more settings in one signed write    |
| `/admin/settings/reset` | `admin.settings.reset` | hands settings back to the environment                |

The [runtime settings](runtime-settings.md) spec covers these routes in full (§5).

### Backup and restore

| Route                    | Op                      | Does                                                       |
| ------------------------ | ----------------------- | ---------------------------------------------------------- |
| `/admin/backup/start`    | `admin.backup.start`    | starts a backup to an S3 prefix                            |
| `/admin/backup/runs`     | `admin.backup.runs`     | reads one run by id, or the latest backup and restore runs |
| `/admin/restore/inspect` | `admin.restore.inspect` | reads a backup's manifest and whether the backup fits here |
| `/admin/restore/start`   | `admin.restore.start`   | restores a backup, then exits so the server restarts       |

The S3 credentials arrive in the signed params and stay in the run's memory. They appear in no audit
line, and the nonce log keeps only the run id. The [deploy guide](../deploy.md) covers backups for
operators.

### The read-only lock

While the `writeLocked` setting is on every HTTP write answers `503`. A signed read records a nonce,
so a signed read answers `503` too. A route answers during a lock only when it carries an explicit
exemption, so a new route stays refused by default. The exempt routes are what an operator needs to
see and to end a lock:

- `admin.status` and the three settings routes;
- the backup and restore routes;
- `places.snapshots.fetch` and `places.snapshot.cancel`.

The server refuses to set the lock while a place run is queued or running, because the run would
keep writing through it.

### Audit

Every admin action logs one structured line: `{op, actor, target, reason?}`, plus whether a removal
removed anything and a short summary of written setting values. A settings write logs its line once,
even when a retry replays its nonce. The `reason` is an operator note of up to 500 characters that
players never see. The log is the only audit history. The settings table records who holds each
override now.

## 5. Settings

| Setting               | Default | Meaning                                                                                   |
| --------------------- | ------- | ----------------------------------------------------------------------------------------- |
| `BEACON_ADMINS`       | none    | the operators' `did:key`s as a comma-separated list; with none, admin routes answer `404` |
| `BEACON_BLOCKLIST`    | none    | `did:key`s to block, seeded into the durable blocklist at boot                            |
| `BEACON_CORS_ORIGINS` | none    | allowed origins; a browser console needs its origin listed like any web client            |

All three are read from the environment only. An admin can't change who the admins are through the
admin API.

## 6. Members

`accessLevel` (a runtime setting, `BEACON_ACCESS_LEVEL`) decides who may write:

| Level     | Who may write      | Requests to join              |
| --------- | ------------------ | ----------------------------- |
| `open`    | anyone             | none needed                   |
| `request` | members and admins | players ask, an admin answers |
| `private` | members and admins | none; an admin adds members   |

Reads stay open at every level, so a non-member still sees the map. These writes need membership:

- a placement, and a room op other than `list`;
- a scout report or cancel;
- a mailbox send and a media upload;
- a place proposal.

A non-member gets `403 notMember`, which falls back to `denied` for a client that hasn't declared the
code. These never need membership:

- a profile publish, since the operator needs the requester's profile to decide;
- the signed reads and a mailbox ack;
- the admin surface.

The server lists `access:members` in its descriptor's `capabilities`, so a client knows the level is
enforced.

### The player's routes

| Route             | Op               | Does                                                        |
| ----------------- | ---------------- | ----------------------------------------------------------- |
| `/access/request` | `access.request` | asks to join `{note?}`, with a note of up to 280 characters |
| `/access/status`  | `access.status`  | reads where the signer stands (a signed read)               |

Both answer `{ok, accessLevel, status}`. The `status` is `member`, `pending`, `declined` or `none`.
Everyone is a member of an `open` server, and an admin is a member of every server.

- At `open` a request answers `member` and records nothing.
- At `private` a request is refused `403 denied`.
- At `request` a request is recorded as pending. Asking again while pending replaces the note. A
  member or a declined player is answered as they stand, so a declined player can't ask again until
  an admin approves them or removes the entry.

At most 1000 requests wait at once. Past that a new request is refused `429 rateLimited` until an
admin answers some. A request also counts against the player's write budget.

### The admin routes

| Route                    | Op                      | Does                                                   |
| ------------------------ | ----------------------- | ------------------------------------------------------ |
| `/admin/access/fetch`    | `admin.access.fetch`    | lists the entries `{status?}`, pending oldest first    |
| `/admin/access/add`      | `admin.access.add`      | makes `{did, reason?}` a member, approving its request |
| `/admin/access/decline`  | `admin.access.decline`  | declines `{did, reason?}`'s pending request            |
| `/admin/access/remove`   | `admin.access.remove`   | removes `{did, reason?}`'s entry                       |
| `/admin/access/admitAll` | `admin.access.admitAll` | makes a member of every account with a profile here    |

Add and decline answer `{ entry }`. Decline answers `400` when the account has no pending request.
Remove answers `{ removed }`: a member loses write access, and a declined player may ask again.
`admitAll` answers `{ added }`. Changing the level admits nobody by itself, so `admitAll` is how a
live server moves off `open` without shutting out its players.

The list is a durable table (`access_members`) behind an in-memory cache, so the check on each write
is a map lookup. An admin can manage the list at any level and so build it before closing the
server.

## 9. What the admin surface does not do

- The surface has one role. A scoped role such as a places curator or a moderator doesn't exist.
- The audit history is the log stream. The server keeps no durable audit table.
- The status is polled. The server doesn't push dashboard updates over a socket.
- Each server is managed on its own. A console that shows several servers reads each one and merges
  the results itself.
