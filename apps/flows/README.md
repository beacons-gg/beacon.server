# @beaconsgg/flows

The five-flow driver runs five flows through the published client SDK against a running server,
the way a game client does:

1. place a room;
2. contribute to it;
3. claim from it;
4. publish a profile;
5. receive a live update over the map channel.

The skew matrix runs the driver with the SDK at one core version against a server at another, as
beacon.core's
[`doc/core-compatibility.md`](https://github.com/beacons-gg/beacon.core/blob/main/doc/core-compatibility.md)
§6 describes. The driver's own suite is the matrix's diagonal. The suite boots `apps/server` on
Postgres and runs the flows at one version in every gate.

```sh
BEACON_FLOWS_SERVER=http://localhost:3001 pnpm --filter @beaconsgg/flows start
```

The driver prints one line per flow with `ok` or `FAIL` and what happened. A server that refuses
or faults fails that flow, and so does one that answers in a shape the SDK misreads. The run then
goes on to the other flows, so the lines say which flow broke.

| Exit code | Meaning                                                                               |
| --------- | ------------------------------------------------------------------------------------- |
| `0`       | every flow passed                                                                     |
| `1`       | at least one flow failed                                                              |
| `2`       | the environment is wrong                                                              |
| `3`       | the run couldn't start: the server was unreachable or its descriptor failed to verify |

| Setting                   | Default    | What it sets                   |
| ------------------------- | ---------- | ------------------------------ |
| `BEACON_FLOWS_LOCK_SEC`   | 4 seconds  | the pot's lock window          |
| `BEACON_FLOWS_UNLOCK_SEC` | 1 second   | the pot's unlock window        |
| `BEACON_FLOWS_WAIT_MS`    | 15 seconds | the deadline per awaited event |

With the defaults the claim comes a few seconds after the place. The contribute must land inside the
lock window, and a loaded machine can take seconds between the two.

The driver is game-neutral. The room is a timed pot whose policy lives in `src/driver.ts`. The
contributed item is a signed opaque item with a made-up birth. The server evaluates both without
knowing a game. So the driver depends on the seven core packages and nothing else in this
repository, and installs from the registry alone.

The suite needs `BEACON_TEST_DATABASE_URL` like the server suite does (`pnpm test:db` starts a
database). The suite gives the server a database of its own on that Postgres server, `beacon_flows`.
The server suite truncates the tables of the database it is pointed at and runs beside this suite
under turbo.

## The skew matrix

`.github/workflows/skew.yml` runs this driver across versions:

- `src/edges.ts` (`beacon-skew-edges [<tag>=<core range> ...]`) reads the registry's version list
  and names the edges of the core window. Each edge is a cell with this driver as the old client.
  Each server release tag it is given becomes a cell too: the head's driver against the server as
  released, when the core range that release was built on is inside the window. An empty window is
  an error.
- `src/oldClient.ts` (`beacon-old-client <version>`) prints the manifest of the old client. The
  manifest holds this driver's dependencies with the core packages at a published version. Each
  catalogued range is set to the version the workspace installed.
- `scripts/skew-cell.sh <server main.js> <driver main.js>` boots a built server on a fresh port and
  runs a built driver against the server. The two sides come from different installs. A side can
  be the head's workspace or a release tag's tree. A side can also be a directory that holds `dist`
  over registry copies of core.

One cell runs the compiled driver over the oldest SDK in the window. So the driver may only call
what that SDK has.

The matrix lives with the server. This repository has the server at its head and at its releases,
and takes core from the registry. The matrix can't see a core change that isn't published yet.
Core's repository tests such a change against this server's released image.

## Publishing

The driver is published beside the core packages as `@beaconsgg/flows`, on its own version. Raise
`version` in `package.json` in a pull request, and the next server release publishes it. The
`driver` job of `.github/workflows/release.yml` does that and skips a version the registry already
has.

Core's install check is the one consumer. That check installs the driver with its core
dependencies overridden to a throwaway build. The check then runs the five flows against the server
as released. This repository's own suite and matrix use the workspace copy.

## License

The driver is licensed under the Apache License 2.0 ([`LICENSE`](LICENSE)). The server it drives is
licensed under the GNU Affero General Public License version 3.
