# Room operation

Rooms are the shared objects a server holds. This spec covers how clients place, observe and change
rooms and how they advertise scouts. The spec describes these parts:

- the signed op envelope;
- the consistency contract and atomic custody transfer;
- the generic policy engine and the lifecycle;
- the live channel and the rejection model.

Checked against Beacon 0.3.

Section 2 and section 3 of `doc/game-author.md` in the Beacon core repository describe the op
vocabulary and the policy fields for game authors. Signing and device authorization are in the core
identity spec.

## 1. Goals

The room layer must:

1. **Change shared state safely under concurrency**, with no lost updates and no item taken twice.
2. **Stay game-agnostic.** The server runs a generic op and policy engine over declarative data, and
   knows nothing of what a room means to a game.
3. **Sign for attribution.** A signature says who acted. The server trusts situational claims such
   as a player's location.
4. **Make handoffs safe.** Taking an item must neither duplicate it nor lose it across a network
   failure.
5. **Separate custodied rooms from advertised scouts.** The server serializes rooms and relays
   scouts.
6. **Compose with discovery.** Ops act on the `unique@host` addresses that discovery returns.

## 2. Two op paths

The number of writers decides the path:

| Path       | Used by                                     | Server role                                                    | Concurrency                     |
| ---------- | ------------------------------------------- | -------------------------------------------------------------- | ------------------------------- |
| Serializer | rooms: custodied and written by many        | holds the canonical state and applies ops in order, atomically | real, and the server arbitrates |
| Relay      | scouts: advertised and written by the owner | caches the owner's latest report and fans it out               | none, with one writer           |

§4 to §9.3 cover the serializer path, and §9.5 covers the relay path.

## 3. The signed op envelope

Every state-changing op uses one envelope. An op is attributed to the account and signed by a device
key the account authorized:

```jsonc
{
  "op": "take", // the op name (§9)
  "room": "01J8…@beacon.example", // the target room; omitted by place and the scout ops
  "actor": "did:key:ACCOUNT", // the account: the attribution target
  "device": "did:key:DEVICE", // the signing device key
  "auth": {/* the account's signed authorization of the device */},
  "game": "example-game", // the game that produced the op
  "nonce": "01J8…", // a ULID: idempotency and replay protection (§6.2)
  "issuedAt": "2026-11-01T00:00:00Z",
  "baseVersion": 42, // optional optimistic concurrency (§6.3)
  "params": { "item": "01J8…" }, // the op's own params
  "sig": "…", // Ed25519 by the device over the canonical JSON of the rest
}
```

The server verifies attribution offline: `sig` is a valid signature by `device`, and `auth` is a
valid authorization of `device` by `actor`. The server otherwise trusts the params. Roles resolve to
`actor`, the account, and never to the device key. The envelope is strict, so a top-level key this
server doesn't know is refused by name instead of being signed silently.

## 4. The room

A custodied room as the server holds it:

```jsonc
{
  "id": "01J8…@beacon.example",
  "type": "example-chest", // informational; the engine never branches on it
  "version": 42, // monotonic; bumped by every applied op
  "location": { "lat": 0, "lng": 0 },
  "state": { "contents": [], "phase": "open" },
  "policy": {}, // declarative; the engine interprets it (§8)
  "placedBy": "did:key:…", // the place op's actor, and the `owner` role
  "game": "example-game", // the placing game, stamped by the server
  "mintedBy": {}, // the signed room provenance
  "name": "Optional display name",
  "media": [], // an optional preview, content-addressed
}
```

The policy travels with the room and arrives at placement (§9.1). The server receives what to
enforce as data.

## 5. The op pipeline

Every serializer op runs the same steps, and only the policy data differs. Each step ends the op
with a rejection on failure:

1. Verify the signature and the device authorization: `badsig`, or `invalid` for a malformed
   envelope.
2. Check `issuedAt` against the 5-minute replay window: `clockSkew`.
3. Look up the nonce. A known nonce returns its recorded result without applying the op again.
4. Refuse a blocked actor (`denied`) and a game the server doesn't admit (`gameNotAdmitted`).
5. Refuse a revoked device (`deviceRevoked`).
6. Charge the actor's per-DID budget: `rateLimited`.
7. Load the room: `unknownRoom`, or `expired` when the room closed recently.
8. Compare `baseVersion` when the op asserts one: `stale`.
9. Check the policy. A policy that doesn't name the op answers `denied`. An op closed to the
   caller's game answers `gameNotAccepted`. The actor's role must allow the op (`denied`), and the
   clock's phase must allow it (`phase`).
10. Run the op's handler. The handler checks structure and applies the intent. The handler's
    refusals are `full`, `gone`, `empty` and `locked`. An item the room already holds answers
    `invalid` (§7).
11. Recompute the derived state from the whole contents (§8.3).
12. Commit: bump the version and write the room and the nonce record in one atomic transaction, or
    delete a room that closes.
13. Broadcast the deltas on the live channel (§10) and reply `{ ok, version, result }`.

Steps 9 to 11 are pure functions of the policy, the current state and the op. Steps 4 to 6 come
after the nonce lookup, so an op that already applied still recovers its result. Their verdicts
aren't recorded under the nonce, so a lifted block lets the same op through on its next attempt.

A read-only op (`list`) returns state at step 10 without a version bump, a record or a broadcast.

## 6. Concurrency and consistency

### 6.1 Serialization

All ops on one room apply in a single ordered sequence. The server holds a per-room lock across each
op's read, compute and commit. Every write of the op lands in one atomic commit. This is what
prevents a double take and a lost contribution. A `place` holds a lock on its nonce instead, since
the room doesn't exist yet.

### 6.2 Idempotency and recoverable results

Each op carries a `nonce`. The server keeps a durable record of each nonce's result, committed in
the same transaction as the state change. A client that never got a response retries with the same
nonce and gets the original result, and the op isn't applied twice. A `take` that succeeded on the
server and lost its reply is therefore recovered: the item is neither duplicated nor lost.

- Rejections that depend on the room are recorded too, so a retry gets the same answer.
- `place` and the room ops keep their records under separate namespaces, so an op that reuses a
  placement's nonce still runs.
- A record is keyed on the actor and the op beside the nonce. An op that reuses a nonce runs as a
  request of its own when another account sends it or when the op differs. A captured envelope still
  meets its own record, since the actor and the op are both signed.
- The replay window still applies. A retry more than 5 minutes after `issuedAt` answers `clockSkew`.
- The record log holds up to `BEACON_MAX_NONCES` entries (default 50000) and drops the oldest first.

### 6.3 Optimistic concurrency

`baseVersion` lets an op say "apply only if the room is still at version 42", and a mismatch answers
`stale`. Most ops don't need it. An item op names its item, so `take` answers `gone` when the item
has left. A `contribute` appends unless the room already holds the item (§7). A client may send
`baseVersion` and isn't required to.

## 7. Atomic custody transfer

An item is authoritative in exactly one place, and a transfer happens inside one serialized op:

- **`take`:** in one atomic step the server removes the item from the room, sets its owner to the
  actor and returns it in the result. The client adds it to its inventory. At no moment does the
  item exist in both places or in neither. A lost reply is recovered through §6.2.
- **`claim`:** the server returns the actor's contributed items in the result and records the claim.
  The items stay in the frozen `contents` (§9.3).
- **`add` and `contribute`:** the reverse. The client drops the item from its inventory after the
  server confirms custody, and recovers through §6.2 on a failure. The server answers `invalid` to an
  item the room already holds in `contents` or in a pool that hasn't granted it yet. The same item
  therefore can't count twice. A contributor who sends their own contribution again under a fresh
  nonce gets a success that changes nothing, so the client still drops the item.
- **Grants:** a grant rule hands the actor items from a pool in room state, as the same custody
  transfer (§9.6).

The wire defines a server-signed grant receipt (`grantReceiptSchema`). The server doesn't issue one
yet, and a client must not depend on receiving one.

## 8. Declarative policy and the generic engine

A room's `policy` is the only thing that gives the room its behavior. The engine interprets it as
data.

### 8.1 Policy shape

A timed room: players contribute while it is open, it locks, then it unlocks and each contributor
claims.

```jsonc
{
  "ops": {
    "contribute": { "role": "public", "phase": "open" },
    "claim": { "role": "contributor", "phase": "unlocked" },
  },
  "lifecycle": {
    "phases": ["open", "locked", "unlocked"],
    "transitions": { "locked": "lockAt", "unlocked": "unlockAt" },
  },
  "derived": {
    "lockAt": { "max": [{ "var": "placedAt" }, { "+": [{ "var": "placedAt" }, 86400] }] },
    "unlockAt": {
      "max": [
        { "var": "lockAt" },
        {
          "+": [
            { "var": "lockAt" },
            604800,
            { "*": [{ "sum": [{ "var": "contents" }, "speed"] }, -3600] },
          ],
        },
      ],
    },
  },
  "claimTtl": "7d",
}
```

The `max` clamp keeps the timeline from inverting, so a large contributed level can shrink a window
to nothing and never move unlock before lock. The clamp also drops an operand that isn't a safe
integer, so an absurd level collapses the window instead of failing the op.

The policy schema is strict at every level, because the room's minter signs the policy. A field this
server stripped would still be covered by the signature, and the room would read as forged. A new
policy field ships with a `policy:<path>` capability marker so a client can ask before it places.

### 8.2 Roles

| Role          | Means                    | Resolved by                        |
| ------------- | ------------------------ | ---------------------------------- |
| `public`      | anyone                   | nothing                            |
| `owner`       | the player who placed it | `actor == placedBy`                |
| `contributor` | anyone who contributed   | `actor` is in `state.contributors` |
| a key list    | specific accounts        | `actor` is in the list             |

Roles rest on identity, so they ride the verified signature. A role says nothing about gameplay.

An op rule may also name `games`: the other games that may use the op. A room's own game always may,
and `["*"]` opens the op to every game. A game the rule doesn't open answers `gameNotAccepted`.

### 8.3 Derived state is a bounded formula

A timed room's `lockAt` and `unlockAt` are contended values. For those the server recomputes the
whole `derived` block from the full contents on every change. The formulas use a bounded JSONLogic
profile (`@beaconsgg/jsonlogic-profile`): a whitelist of operators, four aggregators and integers
only. The formulas evaluate in declaration order, so a later formula can read an earlier one. A full
recompute makes racing contributions independent of order and free of lost updates.

Clients send intent only and never a computed timer, which concurrent writers would overwrite.
Uncontended math stays on the client. The `unlockTransform` a client applies at claim is one case.
The server validates and stores `unlockTransform` and never evaluates it.

A derived sum can overflow, since clients set item levels. The engine answers such an op `invalid`,
applies nothing and records the rejection. A transition more than 10 years after placement counts as
"never". The server refuses a placement that schedules one, and an op that would push a transition
past that horizon answers `invalid`.

### 8.4 Time is server-authoritative

Phase changes fire on the server clock. The server schedules `lockAt` and `unlockAt` and emits the
transitions. A client never asserts that a room has unlocked.

**Gating and broadcasting are separate.** An op is gated by the clock at the moment it arrives: the
engine compares the current time with the derived timestamps to get the effective phase. Gating is
therefore correct whatever the tick has done. The lifecycle tick only broadcasts `phaseChanged`,
stamps `settledAt` on the last phase and closes rooms. A late tick delays a broadcast, and
consistency doesn't depend on the tick.

**The tick is a timer wheel.** Each lifecycle room is scheduled at its next transition: the earliest
of `lockAt`, `unlockAt` and the end of its claim window. A min-heap wakes only when the earliest
room is due, so each wake handles only the due rooms. The total number of rooms doesn't matter.
Placement, ops and each advance update the schedule. A coarse periodic pass rebuilds it from the
store as a safety net. Each advance runs under the room's lock, so the tick never interleaves with
an op. A tick that crosses several phases broadcasts each with its own version.

## 9. Ops

`HANDLERS` in `@beaconsgg/policy-engine` is the full op vocabulary: `add`, `take`, `list`,
`contribute`, `claim`, `collect` and `react`. A game can't add an op. A new op is a platform
release, advertised as an `op:<name>` marker. A policy may name an op this server doesn't handle:
the room places, and the op answers `denied` until a server that handles it hosts the room.

### 9.1 Placement

`POST /rooms` with a signed `place` op creates a room:

```text
place({ type, unique, mintedBy, location, policy, name?, media?,
        initialContents?, initialRewards?, initialPools? }) → the room
```

The client mints the room's `unique`. The room's provenance `mintedBy` is a signature over
`{unique, kind, policy}`. The covering server checks, in this order:

1. The shared signed-request gate: the signature, freshness, the blocklist and device revocation.
2. Game admission, then the actor's per-DID budget.
3. Every JSONLogic rule in the policy, so a bad rule answers `400` instead of failing later.
4. The room's `mintedBy` against `{unique, kind, policy}`.
5. The provenance of every seeded item, from `initialContents`, `initialRewards` and `initialPools`.
   A placement therefore can't slip an unsigned item into a room. A pool that no grant rule draws
   from is refused.

The server then takes custody and stamps `placedBy`, `game` and `placedAt`. The server also sets the
first phase and computes the initial derived state. The minter needn't be the placer. A retried
`place` with the same nonce returns the room it created. A different actor placing an existing id
gets `409` `conflict`.

The server doesn't need to know the room's type. The server stores and enforces the policy it was
given.

### 9.2 A bag: give and take

| Op     | Role   | Effect                                                                                      |
| ------ | ------ | ------------------------------------------------------------------------------------------- |
| `add`  | public | puts a signed item into `contents` with no owner, after the provenance and `accept` checks  |
| `take` | public | removes the item and makes the actor its owner; `gone` if taken, `empty` if nothing is left |
| `list` | public | reads `contents`                                                                            |

With `onEmpty: "close"` the room closes when the last item leaves.

### 9.3 A timed room

| Op or event  | Trigger                               | Effect                                                                       |
| ------------ | ------------------------------------- | ---------------------------------------------------------------------------- |
| `contribute` | an actor, in the first phase          | appends the item, records the contributor and recomputes the timeline (§8.3) |
| locked       | the server clock at `lockAt`          | contributions stop                                                           |
| unlocked     | the server clock at `unlockAt`        | the room settles: `settledAt` is stamped and claims open                     |
| `claim`      | a contributor, in the last phase      | returns that contributor's items, once per contributor                       |
| close        | everyone claimed, or `claimTtl` ended | the room closes and unclaimed items are dropped                              |

A claimed item stays in the frozen `contents`, so every remaining claimant's client computes
`unlockTransform` over the same set. `maxContributors` caps the number of distinct contributors.

A room with a lifecycle closes once it is in its last phase and one of these holds:

- every contributor has claimed;
- nobody contributed;
- nobody is still owed a grant, when the room has grant rules;
- the claim window has ended, `claimTtl` after `settledAt`.

### 9.5 Scouts: the relay path

The owner's client is the authority, and the server is a bulletin board. `POST /scouts` carries both
ops:

| Op       | Signed by | Effect                                                                             |
| -------- | --------- | ---------------------------------------------------------------------------------- |
| `report` | the owner | publishes or refreshes the advertisement: a movement descriptor and an `expiresAt` |
| `cancel` | the owner | removes the scout at once for live viewers                                         |

- A redirect is a new `report` with a new destination.
- The server keeps the latest report per scout `unique` and ignores an older one. Only the scout's
  first owner may refresh or cancel it, and anyone else gets `denied`.
- The server verifies the scout's `mintedBy` over `{unique, config}` and never reads the `config`.
- The server reads the lifetime a report asks for as `expiresAt` minus the envelope's signed
  `issuedAt`. Both come from the client's clock, so the difference holds whatever that clock's error.
  The server applies the lifetime from its own receipt time and stores that `expiresAt`. The server
  refuses a lifetime over 1 hour with `invalid`, and refuses a lifetime of zero or less the same way.
  An owner refreshes before the report expires, or the report ages out. The server holds up to 10000
  scouts and drops the oldest past that.
- The server doesn't check movement against the scout's limits. That math belongs to the owner's
  client. The schema bounds `speedKmh` with a sanity ceiling.
- Scout writes have their own per-DID budget, so a heartbeat never spends a player's room budget.
- An owner reports to every server whose area the path may cross, and viewers dedupe by `unique`.

The relay is in memory. A restart forgets every scout until its owner reports again.

### 9.6 Grants, `collect` and `react`

- **Grant rules** (`policy.grant`) hand the actor `count` items from a named pool in room state when
  an op applies. A grant is a bonus and never a gate: the op succeeds whether or not the grant pays.
  A rule's `when` formula decides whether it pays, against the post-op state. A number pays at 1 or
  more, and a comparison pays when true. A `when` that fails to evaluate pays nothing. Each actor
  draws once per pool. Granted items return in `result.granted` and as `itemGranted` deltas.
- **`collect`** does nothing itself. The op exists to trigger grant rules and can repeat.
- **`react`** appends a small gesture to the room's `reactions` ledger, one per player per target.
  The rule's `max` bounds the ledger. A react has its own per-DID budget inside the player budget:
  `BEACON_REACT_RATE_LIMIT_MAX` (default 60) per minute.

## 10. The live channel

A client opens one socket.io connection to the server for each subscription it keeps. A watched
room gets a socket, and so does the map. Each socket receives ordered deltas:

| Client to server                            | Server to client                                                   |
| ------------------------------------------- | ------------------------------------------------------------------ |
| `subscribe {room}` and `unsubscribe {room}` | `delta`: a live event for that room, ordered by `version`          |
| `setCells {cells}`: the cells in view       | `map`: `room`, `roomGone`, `scout` and `scoutGone` for those cells |

```jsonc
{
  "room": "01J8…@beacon.example",
  "version": 43,
  "change": { "type": "itemAdded", "item": {}, "by": "did:key:…" },
}
```

- The change types are `itemAdded`, `itemRemoved`, `itemClaimed`, `itemGranted`, `phaseChanged`,
  `derivedUpdated`, `reactionAdded` and `closed`. An `itemRemoved` item left custody. An
  `itemClaimed` item stays in the frozen contents.
- Events are ordered by `version`. A client that missed events reads the room again and
  resynchronizes.
- A closed room and a canceled scout send a tombstone, and live viewers drop them at once. A viewer
  without the socket drops them on its next discovery refresh.
- `setCells` replaces the watched set with up to 256 cells. A socket that names a game hears that
  game's rooms and scouts, plus what is open to every game.

**The socket carries server-to-client events only.** Every state-changing op is a REST `POST` with
the signed envelope, and no op travels over the socket. A client subscribes on the socket and acts
over REST.

## 11. Rejections

| Error                     | Status | Meaning                                   | Typical client action                |
| ------------------------- | ------ | ----------------------------------------- | ------------------------------------ |
| `badsig`                  | 401    | the signature is invalid                  | a bug; don't retry blindly           |
| `invalid`                 | 400    | a malformed envelope, params or op name   | fix the request                      |
| `clockSkew`               | 400    | `issuedAt` is outside the replay window   | correct the device clock             |
| `denied`                  | 403    | the actor or the op isn't permitted       | show the refusal; don't retry        |
| `deviceRevoked`           | 403    | the signing device was revoked            | sign in again on this device         |
| `gameNotAdmitted`         | 403    | the server doesn't take the caller's game | stop offering this server for writes |
| `gameNotAccepted`         | 403    | this room doesn't open the op to the game | hide the action for this room        |
| `unknownRoom` / `expired` | 404    | the room is gone or closed                | drop it from view; refresh discovery |
| `phase`                   | 409    | the op isn't allowed in the current phase | show the phase                       |
| `full`                    | 409    | capacity reached                          | show it                              |
| `gone` / `empty`          | 409    | the item was taken, or nothing is left    | refresh the room                     |
| `locked`                  | 409    | the time window isn't open                | show a countdown                     |
| `stale`                   | 409    | `baseVersion` is no longer current        | read again, then recompute and retry |
| `rateLimited`             | 429    | the actor's budget is spent               | back off                             |

`POST /rooms/:id/ops` refuses an op name that isn't a room op at all with `400` `invalid` before
the engine sees it, as every signed route does. `denied` is for an op the room's policy doesn't
permit.

The body is `{ ok: false, error, message? }`. `deviceRevoked`, `clockSkew` and `gameNotAccepted`
arrived after the baseline set. A client that doesn't declare them in its `beacon-understands`
header gets `denied`, `invalid` and `denied` at the same status. A request that fails only on fields
this server doesn't know answers `invalid` with those fields named in `fields`, which tells a client
the server is older than it is.

A rejection reports an outcome, and rejections keep honest concurrent state consistent.

## 12. Flows

**Place and share a bag**

```text
place(bag, location, policy) → "01J8…@host"     # custody moves to the server
… the placer shares "01J8…@host" …
a friend: GET /rooms/01J8…@host → add(item) or take(item)
```

**A timed room**

```text
place(room, location, policy) → "01J9…@host"     # open
A and B contribute(item) → the server appends and recomputes unlockAt each time
server clock → locked → unlocked                  # transitions broadcast
A claim() → A's items; B claim() → B's items      # each client applies unlockTransform
everyone claimed → close
```

**Deploy a scout**

```text
owner: report({ movement, expiresAt }) → every server on the path
viewers: discovery or the map channel → the report → interpolate motion locally
owner: report(new destination) or cancel → a new report or a tombstone
owner refreshes before expiresAt, or the report ages out
```
