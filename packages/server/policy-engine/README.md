# @beaconsgg/policy-engine

**[S] server-only (Node OK).** The generic engine for ops, policies and lifecycles. The engine runs
declarative rooms behind a `Store` interface. The engine enforces **consistency only** and never
judges a gameplay claim. Consistency here covers ordering, capacity, atomic handoff, idempotency
and optimistic concurrency.

## Status

The package is stable. The package isn't bound for a client. The engine serializes and keeps the
authoritative room state, so the engine lives only on the server. A client never imports the
package. A client previews the same accept, capacity and derived math by calling
[`@beaconsgg/jsonlogic-profile`](https://github.com/beacons-gg/beacon.core/tree/main/packages/core/jsonlogic-profile)
directly. The package is a `private` workspace package and isn't published.

> **Note:** the package is server-only, so the React Native safety gate for the `[C]` packages
> doesn't apply.

## What the engine does

The engine is the generic op and policy engine of the server's room operation spec
([`room-operation.md`](../../../doc/spec/room-operation.md) §5). The engine knows no game's room
types. Each room carries a **declarative policy**, and the engine interprets every policy the same
way. For every op the engine:

1. verifies the signature;
2. checks the `issuedAt` freshness;
3. dedupes by `nonce`;
4. consults device revocation;
5. gates by role and by the clock-driven phase;
6. runs the op's handler;
7. recomputes the contended derived state;
8. bumps the version and persists;
9. returns the client's result and the deltas for the live channel.

beacon.core's
[`doc/game-author.md`](https://github.com/beacons-gg/beacon.core/blob/main/doc/game-author.md) §2
documents the op vocabulary for game authors. That section covers each op's params, its effect and
its live change. The section also covers the room state the engine owns and its close rules.

The engine trusts clients with what an item means and checks only that the bookkeeping is sound.
Nobody can take an item twice, exceed a capacity or lose a contribution to a race. Each engine
method is a **unit of work** over an **async `Store`**. The method `await`s its reads first and
computes without side effects. The method then lands every write in one atomic
`Store.commit(mutations)`. So an op's room write and its nonce record land together or not at all,
and a crash can't half-apply a retry.

The method awaits between its reads and its commit. So the server holds a per-room lock across the
whole call to serialize ops on one room, and a per-nonce lock on `place`. The engine holds no locks
and relies on the caller's serialization.

## Exports

| Purpose          | Exports                                                                                                                                         |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| **Engine**       | `PolicyEngine` and `PolicyEngineOptions`                                                                                                        |
| Engine types     | `PlaceRoomInput`, `AppliedOp`, `PlacedRoom`, `PhaseAdvance` and `PlaceConflictError`                                                            |
| **Store**        | the `Store` interface and the `Mutation` type, with `ROOM_GEOHASH_PRECISION`, `roomGeohash()`, `lifecycleDueAt()` and `healedLifecycleDue()`     |
| **Op handlers**  | the `HANDLERS` map and the `READ_ONLY_OPS` set, with the `OpContext` and `HandlerResult` types and `getContents`                                |
| **Markers**      | `acceptedMarkers()`                                                                                                                             |
| **Roles**        | `roleAllows(role, actor, room)`, `contributors(room)` and `currentPhase(room)`                                                                   |
| **Lifecycle**    | `effectivePhase`, `nextTransitionAt`, `recomputeDerived`, `derivedSnapshot`, `lifecycleRoomShouldClose` and the ledger readers                   |
| **Reward grants**| `grantRulesOf(policy)`, `applyGrant(state, rule, actor)`, `getGranted`, `grantedPools` and `RESERVED_STATE_KEYS`                                  |

Some notes on those exports:

- The `Store` methods are async: `getRoom`, `listRooms`, `getNonceResult`, `commit`, `roomsInCells`
  and `lifecycleRoomsDue`. A store that holds a connection leaves the connection for its owner to
  release.
- `lifecycleDueAt()` is the indexed due time a durable store writes. `healedLifecycleDue()` is what
  the store's repair at open rewrites a stale row to.
- `HANDLERS` maps `add`, `take`, `list`, `contribute`, `claim`, `collect` and `react` to their
  handlers.
- `acceptedMarkers()` returns the `op:`, `policy:` and `rule:` markers for what this engine accepts
  beyond the baseline. The server advertises them in its descriptor.
- `nextTransitionAt` is the key the timer wheel schedules a room by.
- The ledger readers are `claimsByContributor`, `getContributors`, `getClaimed`, `roomFullyClaimed`,
  `lastPhase` and `nowSeconds`.
- `grantRulesOf` turns one rule or an array into a list. `grantedPools` reads the ledger per pool
  and tolerates the older flat shape.

### `PolicyEngine`

| Method                                                   | What it does                                                                                                     |
| -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `placeRoom(input)` → `Promise<Room>`                     | Takes custody of a new room at the id the caller supplies. The method stamps `placedAt` and the first phase, and computes the derived block. |
| `place(input, nonce)` → `Promise<PlacedRoom>`            | Places a room idempotently by `nonce`, under the `place:` namespace. A retry after a timeout returns the room minted first. |
| `resolveRoom(id)` → `Promise<Room \| undefined>`         | Reads the room's current state.                                                                                  |
| `recoverResult(nonce)` → `Promise<OpResult \| undefined>` | Answers "what was the result of this nonce?" from the `op:` namespace and then the `place:` namespace.        |
| `applyOp(env)` → `Promise<AppliedOp>`                    | Runs the pipeline below. One `commit` lands the room write and the nonce record together, under the caller's lock. |
| `advancePhase(id, nowMs?)` → `Promise<PhaseAdvance>`     | Advances the stored phase to the phase the clock says and closes the room when the tick condition holds.          |

`placeRoom` throws `PlaceConflictError` on a duplicate id, which is the path to a `409`.
`advancePhase` returns a **monotonic broadcast version** for each change.

`PolicyEngineOptions`:

- `now?: () => number` is the clock for the `issuedAt` window and the expiry of a device's
  authorization (default `Date.now`).
- `replayWindowMs?: number` is the accepted `issuedAt` skew in either direction (default 5
  minutes).
- `isDeviceRevoked?(account, device) => boolean` consults device revocation online, as best effort
  (beacon.core `doc/spec/identity.md` §5.2). Given the verified pair, the function returns `true` to
  deny the op. By default the engine consults nothing and allows everything. The server backs the
  function with its registry of published profiles, which resists rollback.

## The op vocabulary is the contract

`HANDLERS` is the whole set of room ops, and a game can't add one. A new op is a platform release,
and its handler advertises the op as `op:<name>` through `acceptedMarkers()`. A policy may name an op
this build doesn't handle. The room places, and the server refuses that op with `denied`
("unsupported op") until the room's server handles the op. The reasoning is in `markers.ts` in
`@beaconsgg/protocol-types`.

## The `applyOp` pipeline

Each step in order can end the op with a recorded rejection:

1. **Verify** the signature and attribution offline through `@beaconsgg/identity`. The expiry of a
   device's authorization uses the engine's clock. A bad signature answers `badsig`, and a
   `malformed` envelope answers `invalid`.
2. **Freshness.** An `issuedAt` outside `replayWindowMs` answers `clockSkew`. The check runs
   *before* the engine trusts the nonce, so a captured op can't replay forever.
3. **Nonce replay.** A prior result for `op:<nonce>` comes back as recorded. The engine doesn't
   apply or broadcast the op again (`replayed: true`, no `changes`).
4. **Device revocation.** `isDeviceRevoked(actor, device)` runs **after** the replay check, so an op
   already applied still recovers. The verdict is **not** recorded under the nonce, so each attempt
   asks again. A revoked device answers `deviceRevoked`.
5. **Load the room.** A missing room answers `expired` if the room closed recently and left a
   tombstone. Otherwise the answer is `unknownRoom`.
6. **Optimistic concurrency.** An op that asserts `baseVersion` must match the room's version, or
   the answer is `stale`.
7. **Role and phase gate.** `roleAllows` checks the op's role. `effectivePhase` reads the clock and
   must equal the op's required phase. The answers are `denied` and `phase`.
8. **Handler.** The handler runs the structural check and returns the intent. A read-only op
   (`list`) returns state without changing it, recording it or broadcasting.
9. **Derived recompute.** A policy with `derived` gets its block rebuilt, and the engine emits
   `derivedUpdated`.
10. **Commit.** The engine bumps the version and persists the room write **and** the nonce record in
    one atomic `commit`. On close the engine deletes the room instead.

A caller that didn't declare `clockSkew` or `deviceRevoked` gets `invalid` or `denied` instead. The
server's response filter makes that swap, and the engine never knows who is calling.

The engine records stable rejections and successful results under the nonce, so a retry returns the
same outcome. The map from a nonce to its result is bounded first in, first out. So is the map of
tombstones.

## Idempotency, freshness and tombstones

- **Idempotency by `nonce`.** Every `place` and `applyOp` records its result under a key with a
  namespace: `place:<nonce>` or `op:<nonce>`. The two share one nonce store and never read each
  other's keys. So an op that reuses a place's nonce still **runs** and doesn't return the place's
  result.
- **Freshness.** `issuedAt` must be within `replayWindowMs`. A stale envelope is refused before the
  dedupe could bring the envelope back.
- **Tombstones.** The engine remembers a closed room's id, up to a bound. A racing op against that
  id answers `expired` and not `unknownRoom`.

## Lifecycle, phases and contended derived state

The clock decides the phase. `effectivePhase(room, nowSec)` derives the phase a room *should* be in
from its `lifecycle` and its derived times, in epoch **seconds**. So the op gate is right whether or
not the broadcast tick has run. A contribution can't slip in after `lockAt` even when no tick has
run.

- **`advancePhase`** runs on the server's lifecycle tick. The method advances the room's *stored*
  phase to the effective phase and emits a `phaseChanged` for each phase it enters. The method
  closes the room when the close condition holds. The condition holds when the room is fully claimed
  or owes no grant. The condition also holds when the room is empty or when `claimTtl` has passed
  since **settlement**. `lifecycleRoomShouldClose` holds the
  condition. Entering the last phase stamps `settledAt`, and the TTL counts from that stamp.
- **Broadcast versions.** Each change gets a **monotonic broadcast version** in `broadcasts[]`, one
  step per transition. A jump across several phases in one tick emits a version for each, so a
  client that orders by version drops nothing. A close broadcasts at the room's last version, because
  a delete doesn't bump the version.
- **The transition horizon** is core's `TRANSITION_HORIZON_SEC` (10 years). Formulas can't see the
  clock. So a policy says "never" by scheduling a transition decades out, and the engine reads any
  time past the horizon as "never". The engine refuses to place a room that schedules such a
  transition, with a `DerivedRangeError` that the server turns into a `400`. The engine also refuses
  an op that would push a transition later and past the horizon, with `invalid`. Levels may be
  negative, so without that check one hostile contribution could strand a live timed room. An op
  that brings a distant transition nearer still goes through.
- **Stranded rooms.** An older build could leave a room waiting on a transition past the horizon,
  in a phase whose ops can only read or react. Nothing in that phase can pay anyone or bring the
  transition back, so the room is **stranded**. A stranded room closes `claimTtl` after its phase
  was scheduled to begin. Without a `claimTtl` the room closes at that time. A lost early challenge
  is the case in point: the challenge parks in `ended` and waits on a `won` about 30 years out.
  `nextTransitionAt` schedules the close. A durable store's repair at open revisits rows due past the
  horizon, which is what a stranded room's row held before the rule.
- **`recomputeDerived`** rebuilds the **whole** derived block from the **full** contents on every
  `contribute`. The recompute is never incremental. So racing contributions don't depend on their
  order and can't lose an update. Formulas run in the order they are declared, so a later formula
  (`unlockAt`) can read an earlier one (`lockAt`).
- **The timeline can't invert.** A timed room's formulas clamp the derived times so that `lockAt`
  never comes before `placedAt` and `unlockAt` never comes before `lockAt`. A large shift can close
  a window to zero width. The shift can't move the unlock before the lock, which would skip the
  sealed phase. The `max` clamp also *drops* an operand that isn't a safe integer. So an absurd
  contributed stat closes the window and doesn't crash the engine.
- **Overflow answers `invalid` and not a `500`.** A client sets `levels`, so a raw derived `sum`
  can overflow `MAX_SAFE_INTEGER` and make the formula evaluator throw. The engine turns that into a
  clean `invalid` rejection and doesn't apply the op. The engine records the rejection under the
  nonce, so a retry returns the same rejection.

## Policies

A room's behavior is its `Policy`: plain data the engine interprets and never builds. Each game
builds its own in its own package. This package imports no game package, not even in its tests. The policies a
game has shipped are frozen in `src/__tests__/shipped/`, because a placed room keeps the policy it
was signed with. Whole rooms from earlier builds are in `src/__tests__/stored/`. Three shapes cover
what games place today. `@beaconsgg/policy-engine/testing` has a generic example of each, as
[Testing](#testing) describes.

- **A bag.** `add`, `take` and `list` are `public`. The `accept` predicate gates `add` by class,
  tags, level floors and `capacity`. `take` names its item and transfers ownership atomically.
  `onEmpty: "close"` closes the bag when the bag is empty.
- **A timed room.** Contributors `contribute` in the first phase and `claim` in the last. Phases
  change at derived times (`lockAt` and `unlockAt`). The engine recomputes those times from the whole
  contents on every contribution, so a window can move with what players contribute. A `max` floor
  in the formula keeps the window from closing completely. `claimTtl` is the window after the room
  **settles**, counted from `settledAt`. The next tick after that drops what nobody claimed.
  `unlockTransform` is a rule list that the server validates and stores and never runs. A client
  applies it at claim.
- **A ladder**, such as a challenge in steps. Players attest their own progress with items that
  `accept` gates to their class, and `maxContributors` caps the members. The ladder settles on a
  **shrinking settle time**: `unlockAt = min(deadline, placedAt + totalDeficit × BIG)`. Formulas
  can't see the clock, so time enters only through the transition. The ladder broadcasts the derived
  deficit of each step for client progress bars. The ladder pays one `when`-gated grant rule per
  rung on the repeatable `collect` op, as [Reward grants](#reward-grants-policygrant) describes.

## Reward grants (`policy.grant`)

A **grant rule** is a declarative reward handoff (the server's room operation spec,
[`room-operation.md`](../../../doc/spec/room-operation.md) §9.6). The rule's trigger op hands the
acting player `count` items from the pool in room state named by `from`. The handoff is a **generic
custody transfer** of opaque signed items, the same primitive as a bag's `take`. So the engine never
interprets what a reward *is*. `policy.grant` takes **one rule or an ordered array**, and readers
call `grantRulesOf` to see a list either way. A timed room usually carries one rule. A challenge in
steps carries one per rung.

`reward-grant.test.ts` and `grant-rules.test.ts` pin these rules:

- **A grant is a bonus and never a gate.** The trigger op succeeds whether the grant pays or not. An
  unmet condition grants nothing, and so do an empty pool and a turn already used. None of them fail
  the op. Granted items come back in the op result (`result.granted`) and as `itemGranted` deltas.
- **A grant pays once per player per pool.** `state.granted` records the draws per pool. An older
  flat array entry reads as used for the policy's single pool, and `grantedPools` reads both shapes.
  A short pool pays what it has left, and the draw still uses that player's turn for the pool.
- **`when` gates a rule on room state.** `when` is a JSONLogic formula, validated against the
  whitelist with the other policy rules. The engine evaluates `when` over the state after the op,
  with the derived block freshly recomputed. A rule without `when` always passes. A result of 1 or
  more passes, and so does a comparison that is true. A formula that throws doesn't pass. Hostile
  numbers that overflow the profile's guard make a formula throw. A condition can be a comparison
  (`>=` the target) or clamped arithmetic: `max(0, 1 - deficit)` is 1 exactly when the deficit is
  zero. A **cumulative** ladder of such conditions pays a challenge's
  rungs strictly in step order on the server, whatever a client reports.
- **Pools are seeded at placement and gated on provenance.** Every item in a pool that a grant rule
  draws from must carry a `mintedBy` that verifies. A rule's `from` may not name a state key the
  engine owns (`RESERVED_STATE_KEYS`). A pool named `contributors` would forge the member ledger. The
  engine enforces both in `assertValidPolicyRules` and `placeRoom`. The server checks both first so
  that a bad placement gets a clean `400`. On the wire, `initialRewards` seeds the FIRST rule's pool
  and `initialPools` seeds named pools. A pool key that no rule draws from is refused and not
  dropped.
- **`collect` is the repeatable trigger that changes nothing else.** `handleCollect` touches neither
  `contents` nor `claimed`. The op exists to run the grant machinery. So a policy that stages pools
  behind `when` conditions can pay each rung **as the rung lands**. A fresh collect pays the rung in
  the middle of the lifecycle. `claim` is different: a player claims once, and claims feed the close when all
  have claimed.

`collect` never writes `claimed`, so the close for a fully claimed room never fires for a challenge.
So the sweep asks the **grant bookkeeping** instead (`grantsOutstanding`). A settled room closes as
soon as no contributor could still draw from a pool whose rule passes. A rung the team never reached
is owed to nobody and can't hold the room open. `claimTtl` remains the backstop for a player who
never comes to collect. The TTL counts from `settledAt` and not from `unlockAt`, because a challenge
that is won moves `unlockAt` into the past.

## Op handlers

`HANDLERS` maps an op name to its handler. A handler runs the structural check and returns the
intent without persisting: the new state, the client's result and the `RoomChange[]`. The engine
commits. The atomic handoff lives in `handleTake`. In one synchronous step the handler removes the
item and sets its `owner` to the player. The handler then returns the item, or `gone` when the item
is already taken. The server holds the room's lock across the engine's read and commit, so nothing
can spend an item twice. `handleCollect` changes nothing on purpose. The op runs the engine's policy
machinery only: the derived recompute and the grant rules the op triggers.

## Design notes

- **The engine stays on the server.** The engine holds the authoritative state and produces the
  broadcast deltas. Off the client there is a single writer. A client renders previews from the same
  shared math in `@beaconsgg/jsonlogic-profile` and never holds custody.
- **`Store` is where durability lives.** `InMemoryStore` (in [`/testing`](#testing)) models custody
  at risk, because a restart loses everything. The store bounds its nonce map at 50,000 entries by
  default and backs the unit tests. No server runs on it. The server supplies a **Postgres** store
  behind the same async interface. That store's `commit` runs one transaction, so state survives a
  restart.
- **Indexed queries.** The store also answers `roomsInCells` for spatial discovery and
  `lifecycleRoomsDue` for seeding the timer wheel. So a store on the network never scans every row.
  The async interface makes the caller's per-room lock necessary. A synchronous engine would have
  hidden that need.
- **Consistency and not anti-cheat.** Roles follow the verified identity. The `accept` predicate
  matches on the `levels` a client attests and can change. Both are structural gates and judge
  nothing.

The engine builds on the published
[`@beaconsgg/protocol-types`](https://github.com/beacons-gg/beacon.core/tree/main/packages/core/protocol-types)
and [`@beaconsgg/identity`](https://github.com/beacons-gg/beacon.core/tree/main/packages/core/identity)
for op verification. The accept, capacity and derived math comes from
[`@beaconsgg/jsonlogic-profile`](https://github.com/beacons-gg/beacon.core/tree/main/packages/core/jsonlogic-profile).

## Scripts

```bash
pnpm --filter @beaconsgg/policy-engine build       # tsc -> dist
pnpm --filter @beaconsgg/policy-engine typecheck   # tsc --noEmit
pnpm --filter @beaconsgg/policy-engine test        # vitest
```

## Testing

`@beaconsgg/policy-engine/testing` is a subpath export, like `@beaconsgg/identity/conformance`. The
export holds generic policies and signed items with no game nouns. This package's suites and the
server's suites share them.

| Export                                                    | What it is                                                                                    |
| --------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `bagPolicy({ capacity?, accept? })`                       | a public `add`, `take` and `list` that closes when emptied                                    |
| `timedPotPolicy({ lockDelaySec, unlockDelaySec, ... })`   | a timed room that goes from `filling` to `locked` to `open`                                   |
| `ladderPolicy({ deadlineSec, rungs?, ... })`              | rungs of targets that each pay from their own pool and settle early when every target is met |
| `token(unique, levels?, { cls?, minter? })`               | a signed contribution whose `match.levels` the formulas sum                                   |
| `reward(unique, { minter? })`                             | a signed pool item, minted in advance                                                         |
| `nonce()` and `roomMintedBy(...)`                         | the envelope and provenance plumbing every suite needs                                        |
| `InMemoryStore({ maxNonces? })`                           | the reference `Store` the engine's suites run on                                              |

The timed pot's windows can be fixed or can move with a sum over the contents, with an optional
floor (`lockShift` and `unlockShift`). The pot can also carry a grant, a contributor cap and `react`.
Each ladder rung pays under a cumulative `when`.

The policies a game has shipped run separately, as frozen JSON in `src/__tests__/shipped/`
(`shipped-policies.test.ts`). A placed room keeps the policy it was signed with, so these policies
are what live databases hold. Add a file when a new shape ships. Keep an old file while rooms placed
with its policy can exist.

Whole rooms that earlier builds stored run too, in `src/__tests__/stored/` (`stored-rooms.test.ts`).
Each room was saved from the builders and the engine of an older commit, in the middle of its life.
Examples are a half-claimed timed room and a challenge that is running, settled or won. The suite
plays each room forward on this engine. A store hands a room back as it wrote it and doesn't
validate it. So these rooms catch a change that would break a room already in custody: a lowered
ceiling, a dropped JSONLogic operator or a removed reader for an older shape. `stored/README.md` says
how the rooms were made and how to add one.
