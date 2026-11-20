# Known couplings between the server and a game

The Beacon server is **game-agnostic**. The server understands rooms, identity verification,
JSONLogic rules and scout relays. A game adds its own nouns, such as the items players collect and
the kinds of room they place.

At runtime the server keeps that boundary. Room contents, reward pools and scout `config` are
**opaque payloads**. The server validates their schema and verifies their provenance, and never
interprets them. No code branches on a game's room type or item class, and no code evaluates a
game's rewards.

The server's tests keep the same boundary. The suites run generic policies from
`@beaconsgg/policy-engine/testing`. Policies that a game has shipped run as frozen JSON in
`shipped-policies.test.ts`, because a placed room keeps the policy it was signed with. Whole rooms
that earlier builds stored run in `stored-rooms.test.ts`. The fixtures carry an example game's name,
`kites`, and the server installs no game package.

This page records where a game's shapes meet the server, and how each meeting point stays generic.

## Room contents are the generic `OpaqueItem`

Everything that enters a room's shared state is an **`OpaqueItem`**. That covers `contents`,
`initialContents` and reward pools. An item has this shape:

```ts
{ unique, birth, mintedBy, state?, owner?, match? }
```

`birth` is opaque and signed, and `state` is opaque and mutable. The engine stays generic in three
places:

- **Provenance.** `verifyItemProvenance({unique, ...birth}, mintedBy)` checks the signature over the
  opaque birth without knowing its shape. The engine runs the check in `handlers.ts` and in
  `assertSeededItems`. `rooms.controller.ts` runs the same check first so that a bad item gets a
  clean `400`.
- **`accept`.** A room's `accept` rule reads the item's generic **`match` projection**
  (`{class, levels, tags}`) and never the payload. So admission by category stays on the server
  without the server understanding the fields. The gate is structural and isn't an anti-cheat
  measure.
- **`derived`.** A derived aggregate reads numbers from `match.levels` through the JSONLogic `sum`,
  `min`, `max` and `count` aggregators. A timed room's lock and unlock times are one example. All
  four aggregators share one `levelValue` path. A conformance vector for `sum` in
  `@beaconsgg/jsonlogic-profile` pins the projection.

A game seeds a room with its own item type. The game puts its birth fields in `birth` and a
projection in `match`, and the server needs no change. A client converts its own item type to an
`OpaqueItem` where it parses and serializes the wire.

### `match.levels` carries values the formula profile can't compute

`match.levels` is built and attested by the client. The record is an **open** map from a key to an
integer. So `match.levels` is the place for a **derived** value that the server's formula profile
can't compute.

The server evaluates a room's formulas through the JSONLogic profile. The profile works on integers
with `+`, `-`, `*`, `min`, `max` and `sum` and nothing else. The profile has no division, table
lookup or exponent. So a non-linear curve can't live in a `derived` formula. Instead the
contributing client applies the curve. The client sends the result under a sibling key, such as
`proceduralShared` next to `procedural`. The room's formula sums the sibling. The server sums an
integer key it never interprets.

The pattern adds no coupling:

- **The wire and the schema don't change.** `levelsSchema` is already `Record<string, int>`.
- **The raw levels stay.** `accept.minLevels` still gates on the real levels. A room placed before a
  game adds a sibling key keeps working, because its frozen formula sums the raw key.
- **The trust surface doesn't grow.** `match` is unsigned and attested by the client already. A
  client that could lie about a derived value could already lie about the level behind the value.
- **`state.levels` stays raw**, so the round trip back to a game object never picks up the curve.

A projected value is computed **when the item is written** and stored in the room. So a change to
the curve affects new writes only and never a room already placed.

## Scout `config` is an opaque signed object

`scoutConfigSchema` accepts any JSON object:

- **Core.** A `report` bounds the config at `MAX_SCOUT_CONFIG_BYTES`: 2 KiB of canonical JSON, the
  form the signature covers. Reads take what a server sends.
- **The server.** `apps/server/src/scouts/` verifies `verifyScoutProvenance({ unique, config }, …)`
  over the config and reads no field of it. The relay posts what owners report and doesn't referee
  it.
- **A game.** A game defines its own config schema in its own package. The game mints and stores its
  scouts against that schema. The game reads a relayed scout through a tolerant reader. A field that
  a newer build adds is then dropped and doesn't fail the scout.
- **Readers.** The server relays the report envelope's signed `game` slug on each report and
  summary, so a client can draw only its own game's scouts. The operator console draws every scout
  and reads only a string `label`, if there is one.

The signature covers `JCS({unique, config, minter})`. Those bytes are the same whether the schema is
a strict object or a record, so a scout signed against a stricter schema still verifies. A scout
birth vector in core pins the bytes.

## A client's two arrival signals agree only by accident

A client can answer "has this scout arrived?" in two ways. Today the two answers agree in number and
differ in structure:

- `hasArrived(movement, nowMs)` from `@beaconsgg/scout-interp` derives the answer from the **wire**
  descriptor: `lastKnownLocation`, `locationTimestamp`, `speed` and `destination`.
- The owner's own client can keep the trip window it stamped at deploy, and compare the clock with
  that window's end.

The two agree only because the client builds the movement descriptor once at deploy and never
updates it afterwards. A server or client may delay or nudge a reported waypoint along the route to
protect where a scout started. Once that fuzzing ships, the two answers diverge.

Anything that pays a player or grants a permission must use the owner's own window. Otherwise a
change to the wire changes what players earn and what they may do. A `settledAt` primitive beside
`hasArrived` in `@beaconsgg/scout-interp` would give every game the safe answer. The primitive would
take the movement, the trip's end and the clock. The primitive can't live there yet, because the
trip's end is local to the app and the tiers depend downward only.

## Related pages

- beacon.core's
  [`packages/README.md`](https://github.com/beacons-gg/beacon.core/blob/main/packages/README.md)
  maps the tiers: core, server, client, admin and a game.
- beacon.core's `doc/game-author.md` is the contract a game builds against.
