# @beaconsgg/server-runtime

**[S] server-only.** The runtime pieces a Beacon server needs whatever its HTTP and WebSocket
framework. The package holds no NestJS, no socket.io and no database. A callback carries the
transport, and `apps/server` wires these pieces to its framework.

## Exports

| Export               | What it does                                                                                                                                                                         |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `LifecycleScheduler` | The lifecycle timer wheel: a min-heap keyed by each room's next transition time, with lazy deletion. Methods: `set`, `delete`, `dueBefore(now)` and `nextDueAt()`.                     |
| `KeyedMutex`         | A per-key mutex. Ops on one room run one at a time in arrival order, and ops on different rooms run concurrently.                                                                    |
| `ScoutRelay`         | Scout reports the server caches and serves again but never takes custody of. Methods: `report`, `cancel`, `sweepExpired(now)` and `scoutsInView(cells, now)`.                         |

The relay follows beacon.core's discovery spec (`doc/spec/discovery.md` §5). The owner's client
reports its scouts, and the server only relays them.

## Design notes

- **The pieces don't know the framework.** The scheduler and the mutex are plain data structures.
  The relay takes a `broadcast: (delta) => void` callback instead of a socket. The server injects
  its gateway as the callback. The server also drives the relay's `sweepExpired` and the scheduler's
  wake timer on intervals.
- **The timer wheel keeps the cost independent of the room count.** A tick that scanned every
  lifecycle room each second would cost one step per room. The wheel schedules each room at its
  `nextTransitionAt` from `@beaconsgg/policy-engine` and wakes only when a room is due. The server's
  room operation spec (`doc/spec/room-operation.md` §8.4) describes the reconcile behind it.
- **The mutex keeps ops on one room from interleaving.** The store is async, so an op's read and
  its commit sit on either side of `await` points. The server holds the room's `KeyedMutex` across
  the whole op, which keeps a custody handoff atomic.

## Runtime safety

The package is server-only and exempt from the React Native safety gate, though it uses no Node
built-ins. The package depends on `@beaconsgg/protocol-types`, `@beaconsgg/geo` and
`@beaconsgg/scout-interp`.

## Scripts

```bash
pnpm --filter @beaconsgg/server-runtime typecheck
pnpm --filter @beaconsgg/server-runtime test
pnpm --filter @beaconsgg/server-runtime build
```
