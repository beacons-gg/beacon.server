# Beacon Server

The Beacon server implements the server-side infrastructure for the Beacon network. The server provides persistent storage, identity verification, access policies, and consistent state management for games using Beacon.

This repository contains the server application and its internal packages. The repository also contains Atlas, the toolchain used to build geographic datasets imported by Beacon servers.

[beacons.gg](https://beacons.gg) explains how Beacon works. To run a server without operating it yourself, [Beacon Hosting](https://beacons.gg/hosting) runs one for you.

## Architecture

The server is game-agnostic. The server provides shared infrastructure without implementing game-specific mechanics or rules.

The server's primary responsibilities are:

- **Rooms and items:** Store and manage game-specific content within rooms.
- **Identity verification:** Verify device-based cryptographic identities and signed operations.
- **Access policies:** Evaluate JSONLogic rules governing access to rooms and operations.
- **Shared state:** Maintain consistent state when multiple players interact with the same resources.
- **Scout relays:** Relay signed scout reports to the players watching the map.

The server verifies operations and maintains state, but does not interpret game-specific item data or make gameplay decisions. Games define their own mechanics, progression, and data formats.

The server is part of the wider Beacon system:

- **Beacon Core** defines the shared protocol, identity, geographic, policy, and scout packages.
- **Beacon Server** implements persistent storage, policy enforcement, and shared-state operations.
- **Games** interact with servers through the published client SDK.
- **Beacon Admin** manages server configuration through signed administrative routes.

These boundaries are enforced through repository lint rules. Server code may not import a game, the client SDK or the admin console.

## Repository structure

| Path                      | Package                   | Description                                                                       |
| ------------------------- | ------------------------- | --------------------------------------------------------------------------------- |
| `apps/server`             | `@beaconsgg/server-app`   | NestJS application and PostgreSQL-backed server ([README](apps/server/README.md)) |
| `packages/server/*`       | `@beaconsgg/*` (private)  | Internal server packages                                                          |
| `apps/flows`              | `@beaconsgg/flows`        | Integration and compatibility test driver ([README](apps/flows/README.md))        |
| `apps/atlas`              |                           | Geographic dataset toolchain ([README](apps/atlas/README.md))                     |
| `apps/atlas/cartographer` | `@beaconsgg/cartographer` | Dataset builder ([README](apps/atlas/cartographer/README.md))                     |
| `apps/atlas/osm-import`   |                           | OpenStreetMap import job                                                          |
| `doc/`                    |                           | Deployment and server documentation                                               |

Internal server packages:

- `policy-engine`
- `server-runtime`
- `atlas-volume`
- `place-taxonomy`
- `wikimedia`
- `image-encode`

Server specifications are maintained in [`doc/spec/`](doc/spec/README.md), with Atlas specifications in [`apps/atlas/doc/spec/`](apps/atlas/doc/spec/README.md).

## Running a server

Beacon servers can be self-hosted or deployed through [Beacon Hosting](https://beacons.gg/hosting). [Choose how to run a server](https://beacons.gg/docs/run-a-server) compares the two.

- **Self-hosting:** Follow the [self-hosting guide](https://beacons.gg/docs/self-hosting).
- **Deployment:** See [`doc/deploy.md`](doc/deploy.md) for container configuration, environment variables, and production deployment instructions.
- **Managed hosting:** See [Beacon Hosting](https://beacons.gg/hosting) for managed server deployment.
- **Management:** Manage a running server in the [operator console](https://console.beacons.gg).

The Docker Compose configuration included in this repository provides a local deployment consisting of the server, PostgreSQL, and MinIO for media storage.

## Development

### Requirements

- Node.js 22
- pnpm 10.33
- Docker

The repository uses `.nvmrc` for the Node.js version and `packageManager` in `package.json` for pnpm.

### Setup

```sh
nvm use
corepack enable
pnpm install
```

The test suites require PostgreSQL. Start a temporary test database with:

```sh
pnpm test:db
```

The command prints a `BEACON_TEST_DATABASE_URL` to export in your shell.

Set `BEACON_TEST_DB_PORT` to change the default test database port (`55432`) if it is already in use.

### Common commands

| Command                                   | Description                              |
| ----------------------------------------- | ---------------------------------------- |
| `pnpm run build`                          | Build packages, server, and Cartographer |
| `pnpm run gate`                           | Run all CI checks                        |
| `pnpm --filter @beaconsgg/server-app dev` | Build and run the server locally         |
| `docker compose up --build`               | Start the server, PostgreSQL, and MinIO  |

[`doc/development.md`](doc/development.md) covers the packages the server takes from Beacon Core and the checks in the gate. The page also covers CI and the skew matrix. Maintainers release the server as [`doc/release.md`](doc/release.md) describes.

## Contributing and license

External pull requests are not currently accepted, but issues and bug reports are welcome.

See [`CONTRIBUTING.md`](CONTRIBUTING.md) for development guidelines and [`SECURITY.md`](SECURITY.md) for private security vulnerability reporting.

The server, Atlas, and internal server packages are licensed under **GNU AGPL-3.0-only**. See [`LICENSE`](LICENSE).

Operators running modified server builds must make their source available to users. `BEACON_SOURCE_URL` provides the source link displayed on the server home page. See the [deployment guide](doc/deploy.md) for configuration details.

The five-flow driver (`@beaconsgg/flows`) is separately licensed under **Apache-2.0**, documented in [`apps/flows/LICENSE`](apps/flows/LICENSE).

The copyright holder is NorthCtrl LLC, as [`COPYRIGHT`](COPYRIGHT) and [`apps/flows/NOTICE`](apps/flows/NOTICE) state.
