# Mailbox and media

The mailbox and the media store are two optional server capabilities that any game can use. The
mailbox holds messages per account, and the media store holds content-addressed files. This spec
covers their model, wire, storage and abuse controls.

Checked against Beacon 0.3.

Both are platform capabilities. The server stores signed, addressed payloads and never interprets
them. What a message says and what an image shows stay with the game.

## 0. Overview

An operator turns each capability on separately, and the signed descriptor advertises the ones that
are on.

| Capability | Keyed by          | Purpose                                                                            | Lifetime                                         |
| ---------- | ----------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------ |
| Mailbox    | the recipient DID | reach a player who isn't connected, such as with a friend request or an invitation | until read and acknowledged, or the server's TTL |
| Media      | the content hash  | store an item's or a room's images and sounds so other players can fetch them      | as long as the server keeps them                 |

Content on a Beacon server is public, or fine to be public. Both capabilities reuse the signed
request and the per-DID controls the rest of the server uses, and neither knows which game it serves
beyond the game's slug.

## 1. Principles

A capability belongs on the server when it is addressed, signed, opaque, advertised and at risk.
Mailbox and media are all five.

- **Opaque.** The server checks an envelope: who sent it, the signature and the size. The server
  stores the body as bytes it never parses.
- **The actor is cryptographic.** Every write and every private read carries an Ed25519 signature.
  The server takes the actor's DID from the signature and never from a field. That is what makes
  "return only my messages" and "block this sender" enforceable (§3.2).
- **Public.** A media object is a public blob addressed by its hash. A server's access level limits
  who may query or upload. The access level doesn't make stored bytes secret.
- **At risk, with little state.** Messages expire, and the server keeps no contact lists or other
  per-recipient relationships. A server that goes away takes its media with it, and a game must stay
  playable without it.

## 3. Shared foundation

### 3.1 Capability advertisement

The signed descriptor carries `capabilities`, a flat list of strings. `mailbox` and `media` appear
when the operator turns them on, beside the other service capabilities and the protocol markers. The
list stays small and stable. Each capability's own routes enforce its limits with `413` and `429`.
The largest mailbox body is one such limit. A client reads the list from a verified descriptor
before it sends mail or uploads media to a server.

### 3.2 Signed requests

A mailbox or media request is an `OpEnvelope` with a capability op name and a `params` payload. The
envelope has no room.

```ts
// send:  { op: "mailbox.send",  actor, device, auth, nonce, issuedAt, game, params: { to, body },         sig }
// fetch: { op: "mailbox.fetch", actor, device, auth, nonce, issuedAt, game, params: {},                   sig }
// ack:   { op: "mailbox.ack",   actor, device, auth, nonce, issuedAt, game, params: { ids },              sig }
// media: { op: "media.put",     actor, device, auth, nonce, issuedAt, game, params: { hash, type, size }, sig }
```

Every signed request passes the server's one signed-request gate, in this order:

1. The op name matches the route.
2. `verifyOp` checks the signature and returns the actor.
3. `issuedAt` is within the freshness window.
4. The actor isn't on the blocklist.
5. The signing device isn't revoked.

Each route then checks its game and its nonce, and acts. The whole envelope is signed over its
canonical JSON, so the sender signs the message body too. The server still never reads the body.

The nonce log keys each record on the actor and the op beside the nonce. A retry of one request gets
that request's first answer back. Two requests that differ in signer or op never share an answer,
even when a client reuses a nonce across them. The actor and the op are both signed, so a captured
request still replays to its own record.

Params that don't parse answer `400` `invalid` on every signed route, mailbox and media included.
When the only problem is keys this server doesn't know, the refusal names them in `fields`. That
tells a client the server is older than it is.

### 3.3 Storage

Each capability has its own store in the server's Postgres database, with forward-only migrations.
Messages and media metadata live in SQL. Media bytes live in a separate blob backend (§5.4).

### 3.4 Abuse controls

- The IP-keyed write limit (`BEACON_WRITE_RATE_LIMIT_MAX` per `BEACON_WRITE_RATE_LIMIT_WINDOW_MS`)
  guards `POST /mailbox`, `POST /mailbox/ack` and `POST /media` as a backstop.
- The signed reads `POST /mailbox/fetch` and `POST /places/proposals/fetch` have an IP-keyed budget
  of their own, `BEACON_SIGNED_READ_RATE_LIMIT_MAX` (default 300) per
  `BEACON_SIGNED_READ_RATE_LIMIT_WINDOW_MS` (default 60000 ms). The server checks it before the
  signature, so a flood of junk envelopes can't buy unlimited signature checks.
- **Per-DID controls are the real levers.** The server keys them on the verified actor, which a
  sender can't forge or rotate away:
  - a send budget and an upload budget per DID;
  - the durable blocklist, which refuses a blocked sender with `403`.
- **Game admission.** A send or an upload names its game, and the server refuses a game it doesn't
  admit (`BEACON_GAMES`). An upload signed by an admin may name no game. The operator console
  uploads place photos that way.
- Muting a sender is a client-side choice and keeps per-recipient preferences off the server.

## 4. Mailbox

### 4.1 Model

A mailbox is a notification drop for a player who isn't connected. Messages are stored per recipient
DID, expire after the server's TTL and are delivered on a signed pull. The mailbox has no contact
list, no first-contact gate and no read receipts.

Mail is kept per game. A send stamps the sending game's slug, and a fetch or an ack sees only the
mail of the game it names. A message stored with no game reaches no game and expires on its TTL.

**Live delivery.** A client can also hold a socket.io connection to the `/mailbox` namespace. A
signed `mailbox:subscribe` passes the same gate as a REST request and joins the socket to a room
keyed on the verified DID and the game. A socket serves one identity at a time:

- A subscribe that the gate refuses leaves the socket in the room it was already in.
- A subscribe that passes the gate leaves any earlier mailbox room first.
- A subscribe that passes the gate and names no game is then refused with `gameNotAdmitted`. The
  socket is left in no mailbox room.

The server pushes a message to the recipient's room as `mail` once the store has inserted it. The
push comes before the server records the send's nonce. A retried send that the store dedupes isn't
pushed again. The push is best effort, and a recipient who misses one gets the message on the next
fetch.

### 4.2 Addressing

The recipient is a DID, and the mailbox lives on a host. A `did:key` contains colons, so `DID@host`
isn't a valid GlobalId. Mailbox addressing therefore has a scheme of its own:

- A player names the server that holds their mailbox in their signed profile, as a `services` entry
  of type `mailbox`. Changing it is a new profile version.
- To send, a client resolves the recipient's mailbox host from their profile and posts to that host.

### 4.3 Wire

```ts
// params for op:"mailbox.send"
{
  to:   DidKey, // the recipient's account did:key
  body: string, // opaque; the server never parses it
}
```

- **The body has no server-side schema.** The server enforces a size limit of
  `BEACON_MAILBOX_MAX_BODY` (default 256 bytes of UTF-8) and answers `413 tooLarge` above the
  limit. The wire ceiling is 4096 bytes of UTF-8 (`MAX_MAILBOX_BODY`). The setting can't go above
  the ceiling: a larger value in the environment stops the boot, and the console refuses one. The
  server checks its own limit before the wire schema, so any over-size body gets `413`. The small
  default fits a template index and a short payload that the game decodes against its own message
  catalog. With template bodies spam comes down to volume. The per-DID budget covers volume, so the
  server needs no content moderation.
- **The server decides the TTL.** The envelope carries none. On receipt the server stamps
  `receivedAt` and `expiresAt = receivedAt + BEACON_MAILBOX_TTL`. A recipient who doesn't fetch
  before `expiresAt` loses the message.

A fetched message is `{ id, from, body, receivedAt, expiresAt }`. The server assigns `id`, and
`from` is the verified sender.

### 4.4 Routes

| Route                                        | Does                                                                                             |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `POST /mailbox` (`op:"mailbox.send"`)        | stores the message and answers `{ ok, id }`; a retried nonce returns the same `id`               |
| `POST /mailbox/fetch` (`op:"mailbox.fetch"`) | takes empty `params`; returns the actor's unexpired messages from the named game, oldest first   |
| `POST /mailbox/ack` (`op:"mailbox.ack"`)     | deletes up to 256 of the actor's messages by id and answers how many; a retried nonce replays it |

Every route is a `POST` because every route carries a signature. The server has no unsigned way to
read a box by DID, since such a read would expose who writes to whom and let anyone empty a box. A
fetch nonce can't be used twice: a repeated one answers `409`, so a captured fetch can't read the
box again.

A send stays idempotent after its message is acknowledged or expired, because the nonce log keeps
the send's result.

### 4.5 Storage and expiry

The `mailbox` table holds one row per message: `id`, `recipient`, `sender`, `game`, `body`,
`received_at`, `expires_at` and the send's `nonce`. The table is indexed on `recipient` and on
`expires_at`. The table is also unique on the sender and the nonce together. A retried send
therefore stores one row, and another sender's nonce never stands in for this one's. A sweep deletes
expired rows once a minute. The sweep waits while the server is locked read-only. An ack deletes the
acknowledged rows. A fetch never returns an expired row, even before the sweep removes it.

### 4.6 Abuse

- Each sender has a budget of `BEACON_MAILBOX_RATE_LIMIT_MAX` sends (default 60) per
  `BEACON_MAILBOX_RATE_LIMIT_WINDOW_MS` (default 60000 ms), keyed on the verified sender. Over the
  budget a send answers `429`.
- A blocked sender gets `403`.
- Template bodies are a contract between the game and its clients. The server enforces only the
  size.
- Abuse handling is reactive. A recipient mutes a sender in their own client, and the server-side
  blocklist is for senders who abuse the network.

### 4.7 Encryption

The server doesn't encrypt bodies, and the server's operator can read them. A game that needs
private text encrypts the body on the client. A DID is an Ed25519 signing key and can't be encrypted
to directly, so such a game needs an X25519 key for each player. The profile reserves `keyAgreement`
for that key. The sender's `from` stays verified in the clear envelope, so the abuse controls keep
working on encrypted mail.

## 5. Media

### 5.1 Model

Media is shared, public and content-addressed. An upload returns a content address. A game mints an
item or a room that references the address, and other clients fetch the bytes and verify them
against the hash. When the host goes away the media goes with it. The item stays valid without it.

### 5.2 Content addressing

A media entry is bound to the hash of its bytes. A server-assigned id would prove where the bytes
were and not what they were.

```ts
const mediaSchema = z
  .object({
    type: z.string(), // "image" | "sound" | ...
    role: z.enum(["full", "thumb"]).optional(),
    hash: z.string().min(1), // sha256 of the bytes, base64url without padding
    uris: z.array(z.string().min(1)).min(1), // content addresses: `<hash>@host`
    credit: mediaCreditSchema.optional(), // attribution for third-party media
  })
  .strict();
```

- A base64url hash fits the GlobalId `unique` class, so `<hash>@host` is a valid GlobalId and media
  resolves through the same host routing as everything else. The host is a hint and the hash is the
  identity. The same bytes on any host are the same media, which allows mirrors and fallbacks.
- When a game puts `media` in an item's signed `birth`, the item's signature covers each hash. A
  client re-hashes the bytes it fetches and rejects a mismatch.
- **The hash covers the clean bytes.** The client strips metadata before it hashes (§5.5). The
  signed hash, the uploaded bytes and the bytes every client fetches are then identical. The server
  checks an upload and refuses a bad one, and the server never rewrites bytes. Rewriting would
  change the hash and break the address.
- **An item's effects never depend on its media.** Missing media leaves a valid, playable item with
  no picture. This is what makes the loss of a media host acceptable.

### 5.3 Routes

| Route                            | Auth   | Does                                                                                                              |
| -------------------------------- | ------ | ----------------------------------------------------------------------------------------------------------------- |
| `POST /media` (`op:"media.put"`) | signed | checks and stores the bytes, then answers `{ ok, id: "<hash>@host" }`; the same bytes always get the same address |
| `GET /media/:hash`               | public | serves the bytes with an immutable cache header                                                                   |

An upload carries the bytes as base64 beside the signed envelope: `{ env, data }`. The envelope
attests `{ hash, type, size }`, so the transport could change without changing what is signed. The
server checks an upload in this order and stops at the first failure:

| Check                                                | Failure                 |
| ---------------------------------------------------- | ----------------------- |
| the type is on `BEACON_MEDIA_TYPES`                  | `415` `unsupportedType` |
| the byte length equals the attested `size`           | `400` `invalid`         |
| the size is within `BEACON_MEDIA_MAX_BYTES`          | `413` `tooLarge`        |
| the uploader is within their upload budget           | `429` `rateLimited`     |
| the bytes hash to the attested `hash`                | `400` `hashMismatch`    |
| the bytes carry no EXIF or GPS metadata              | `422` `metadataPresent` |
| the uploader stays within `BEACON_MEDIA_QUOTA_BYTES` | `413` `quotaExceeded`   |
| the store stays within `BEACON_MEDIA_LIMIT_BYTES`    | `413` `quotaExceeded`   |

Bytes the server already holds skip the metadata and quota checks and return their address. The
cheap checks come before the hash and the metadata parse, so a throttled flood costs the server
little.

`GET /media/:hash` answers `404` `unknownMedia` for an unknown hash, and `404` `unknownRoute` while
media is off. The fetch shares the player-state read budget
per IP address with discovery, rooms and profiles. The budget is `BEACON_PLAYER_READ_RATE_LIMIT_MAX`
(default 600) per minute.

### 5.4 Storage and blob backend

Metadata and bytes are stored apart.

- **Metadata** is the `media` table, keyed by `hash`. A row holds `type`, `size`, `uploaded_at`,
  `last_access_at` and the operator's review stamp. The row's `owner` is the uploader's DID. A fetch
  stamps `last_access_at` at most once an hour for each object, and never while the server is locked
  read-only.
- **Bytes** sit behind a blob store with two backends, chosen by `BEACON_MEDIA_BACKEND`:
  - `fs` keeps files under `BEACON_MEDIA_DIR`, sharded by hash. The app streams them.
  - `s3` works with any S3-compatible service through `BEACON_MEDIA_S3_ENDPOINT` and its region and
    credentials. A missing bucket or credential stops the server at boot. An upload sets an
    immutable `Cache-Control` and the content type on the object.
- **Serving.** With `BEACON_MEDIA_CDN_URL` set the S3 backend answers a fetch with a `302` to
  `<cdn>/<key>`. The CDN then serves the bytes. Without a CDN the app streams the object, so a
  client can re-verify the hash either way. Media is public, so a fetch needs no signing.

The server also ingests media of its own. The server fetches a place photo from an import and checks
the bytes for metadata. The server then verifies the hash and stores the photo as its own.
Server-owned bytes skip the per-DID quota and still respect the type list, the size limit and the
store limit.

### 5.5 Metadata: detect and reject

A photo taken at home carries GPS coordinates in its EXIF data. Stored raw, the photo would give a
player's address to anyone who fetches it. Removing metadata is therefore required. The server can't
remove it, because changing the bytes changes the hash the client signed.

- **The client** strips metadata, then hashes, signs and uploads the clean bytes.
- **The server** never changes bytes. The server re-hashes what arrives and refuses a mismatch. The
  server then parses the bytes for metadata and refuses an upload that carries EXIF or GPS data. The
  parse reads the bytes themselves, so a false `type` can't carry a dirty image past it.

The content address stays exact, and the server enforces the privacy rule. The server needs a
metadata reader (`exifr`) and no image encoder.

**Warning:** the server's check covers images only. Bytes the reader can't parse count as clean, and
audio is one such case. The allowlist includes `audio/mpeg` by default. For a non-image type the
client must strip the metadata, and the server can't check the result. To make the guarantee hold
for every upload, set `BEACON_MEDIA_TYPES` to image types only.

### 5.6 Quotas and retention

- Each uploader has a total storage quota (`BEACON_MEDIA_QUOTA_BYTES`) and an upload budget, both
  keyed on the verified DID. `BEACON_MEDIA_LIMIT_BYTES` caps the whole store.
- An allowlist of types and a size limit bound every object.
- A blocked uploader gets `403`.
- **The server never deletes media on a timer.** The host can't tell cheaply whether an item still
  references a blob, since the item may live in a room on another server. The server enforces the
  quotas and records `last_access_at`. An operator removes an object by hand with
  `admin.media.remove` ([admin API](admin-api.md) §3).

### 5.7 Access

The media host has no record of who can see a room, and that room may sit on another server. The
host therefore can't limit a fetch to the players who can see the item. Referenced media is public
through its content address. Private media would need encryption on the client, which would also
take away the operator's ability to moderate it.

## 6. Security and privacy

- Mailbox reads are signed and scoped to the verified reader.
- The actor comes from the signature everywhere, so blocking, budgets and read scoping hold.
- Every signed write carries a fresh `issuedAt` and a nonce, so a replay changes nothing and a retry
  is safe.
- Size limits bound message bodies and media objects.
- The server refuses images that carry EXIF or GPS metadata and never changes bytes (§5.5).
- A mailbox host learns who writes to whom. The server stores only `{to, from, game, body, times}`
  and doesn't log bodies. A short `BEACON_MAILBOX_TTL` keeps less of that record.
- The IP limits rely on `BEACON_TRUST_PROXY` being set right behind a proxy.
- A server with a capability turned off answers `404` `unknownRoute` on all of that capability's
  routes.

## 7. Settings

| Setting                               | Default                                      | Meaning                                                            |
| ------------------------------------- | -------------------------------------------- | ------------------------------------------------------------------ |
| `BEACON_MAILBOX`                      | `off`                                        | turns the mailbox on                                               |
| `BEACON_MAILBOX_TTL`                  | `604800` (7 days)                            | the message lifetime in seconds                                    |
| `BEACON_MAILBOX_MAX_BODY`             | `256`                                        | the largest body in bytes, at most 4096                            |
| `BEACON_MAILBOX_RATE_LIMIT_MAX`       | `60`                                         | sends per DID per window                                           |
| `BEACON_MAILBOX_RATE_LIMIT_WINDOW_MS` | `60000`                                      | the send window                                                    |
| `BEACON_MEDIA`                        | `off`                                        | turns media on                                                     |
| `BEACON_MEDIA_MAX_BYTES`              | `5242880` (5 MiB)                            | the largest object; also sizes the JSON body limit for every route |
| `BEACON_MEDIA_TYPES`                  | `image/jpeg,image/png,image/webp,audio/mpeg` | the allowed MIME types                                             |
| `BEACON_MEDIA_QUOTA_BYTES`            | `52428800` (50 MiB)                          | the storage quota per DID                                          |
| `BEACON_MEDIA_LIMIT_BYTES`            | none                                         | the whole store's limit, set at deploy time                        |
| `BEACON_MEDIA_RATE_LIMIT_MAX`         | `60`                                         | uploads per DID per window                                         |
| `BEACON_MEDIA_RATE_LIMIT_WINDOW_MS`   | `60000`                                      | the upload window                                                  |
| `BEACON_MEDIA_BACKEND`                | `fs`                                         | `fs` or `s3`                                                       |
| `BEACON_MEDIA_DIR`                    | `beacon-media`                               | the `fs` backend's directory                                       |
| `BEACON_MEDIA_S3_ENDPOINT`            | none                                         | the S3-compatible endpoint                                         |
| `BEACON_MEDIA_S3_REGION`              | `auto`                                       | the region                                                         |
| `BEACON_MEDIA_S3_BUCKET`              | none                                         | the bucket, required for `s3`                                      |
| `BEACON_MEDIA_S3_ACCESS_KEY_ID`       | none                                         | the access key id, required for `s3`                               |
| `BEACON_MEDIA_S3_SECRET_ACCESS_KEY`   | none                                         | the secret key, required for `s3`                                  |
| `BEACON_MEDIA_S3_FORCE_PATH_STYLE`    | `false`                                      | path-style addressing, for MinIO and some providers                |
| `BEACON_MEDIA_S3_PREFIX`              | none                                         | a key prefix inside the bucket                                     |
| `BEACON_MEDIA_CDN_URL`                | none                                         | a public CDN base; set, a fetch redirects there                    |

The [runtime settings](runtime-settings.md) spec says which of these an operator can change without
a redeploy.
