# Beacon server

This repository holds the Beacon server and the server-side packages it is built from. The
repository also holds Atlas. Atlas is the offline toolchain that builds the place datasets a server imports. A release ships three
images: the server and the two Atlas images.

| Path                      | Package                   | What it is                                                                                                        |
| ------------------------- | ------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `apps/server`             | `@beaconsgg/server-app`   | the NestJS and PostgreSQL server ([README](apps/server/README.md))                                                |
| `packages/server/*`       | `@beaconsgg/*` (private)  | the server's packages (listed below)                                                                              |
| `apps/flows`              | `@beaconsgg/flows`        | the five-flow driver, which is the end-to-end suite and the skew matrix's client ([README](apps/flows/README.md)) |
| `apps/atlas`              |                           | the Atlas toolchain around one PostGIS database ([README](apps/atlas/README.md))                                  |
| `apps/atlas/cartographer` | `@beaconsgg/cartographer` | Atlas's builder, with a subcommand per stage ([README](apps/atlas/cartographer/README.md))                        |
| `apps/atlas/osm-import`   |                           | the osm2pgsql import job ([README](apps/atlas/osm-import/README.md))                                              |
| `doc/`                    |                           | the [deploy guide](doc/deploy.md) and the [game couplings](doc/known-couplings.md)                                |

The server's packages are `policy-engine`, `server-runtime`, `atlas-volume`, `place-taxonomy`,
`wikimedia` and `image-encode`.

The design specs are in [`doc/spec/`](doc/spec/README.md), and Atlas's are in
[`apps/atlas/doc/spec/`](apps/atlas/doc/spec/README.md). The code cites them by section.

The server is **game-agnostic**. The server understands rooms, identity verification, JSONLogic
rules and scout relays. The server decides nothing about gameplay. No code here names a
game, and the lint enforces that (see [The quality bar](#the-quality-bar)). A game is a client of the
server through the published `@beaconsgg/*` client packages. The operator console (beacon.admin)
reaches the server over the signed admin routes.

## What the server takes from Beacon

The server installs these packages from the public npm registry, with no token.

- The core packages: `@beaconsgg/protocol-types`, `@beaconsgg/identity`, `@beaconsgg/geo`,
  `@beaconsgg/jsonlogic-profile` and `@beaconsgg/scout-interp`. Beacon versions them together with
  two client packages. The five-flow driver is a client and installs `@beaconsgg/client-sdk`.
  Server code may not import the SDK, and the lint enforces that.
- The presets Beacon's repositories build with: `@beaconsgg/tsconfig`, `@beaconsgg/vitest-config`,
  `@beaconsgg/eslint-config` and `@beaconsgg/prettier-config`.

The server takes all of them at `^1.0.0`, the range of core's first stable release. The lockfile
pins the version the server is tested on.

## Work in this repository

You need Node 22, pnpm 10.33 and Docker. Run `nvm use` to pick up the Node version from `.nvmrc`.
Run `corepack enable` to pick up pnpm from `packageManager`. Docker runs the Postgres database the
server suite needs and the deployable shape. Run `pnpm install`, and then:

```sh
pnpm test:db                 # a throwaway Postgres database for the suites; prints the BEACON_TEST_DATABASE_URL to export
pnpm run gate                # everything CI runs
pnpm run build               # the packages' dist/, then the server and Cartographer
pnpm --filter @beaconsgg/server-app dev   # build and run the server locally
docker compose up --build    # the deployable shape: the server, Postgres and MinIO for media
```

Set `BEACON_TEST_DB_PORT` to move the test database off port `55432` when another process holds
the port. The deployable shape is described in [`doc/deploy.md`](doc/deploy.md).

## The quality bar

The gate is the `gate` script in `package.json`. `.github/workflows/ci.yml` runs the gate with a
Postgres service on every pull request marked ready. A draft runs nothing. The gate runs these checks in order:

1. **Coverage floors.** Every suite reports coverage and holds a floor
   (`beacon-check-coverage-tasks`, from `@beaconsgg/vitest-config`). The repository floor is 81% of
   lines. Three workspaces set their own floor a little under what they measure. Their
   coverage can't slide while it climbs: `@beaconsgg/atlas-volume` (40), `@beaconsgg/cartographer` (60) and
   `@beaconsgg/place-taxonomy` (60).
2. **The tier gate.** `beacon-check-tier-gate` and the lint step, from `@beaconsgg/eslint-config`,
   keep games, the client SDK and the console out of server code. The client SDK is installed here
   for the driver. The root manifest names the SDK under `beacon.foreign.client`, and the gate
   refuses it in server code by name. A game or the console isn't installed, so an import of one
   fails to resolve. A test fixture module (`@beaconsgg/policy-engine/testing` or
   `@beaconsgg/identity/conformance`) is imported only from a test.
3. **The writing check.** `pnpm run check:copy` runs `beacon-check-copy` over every README and every
   page under `doc/`, warnings included.
4. **The reference check.** `pnpm run check:refs` runs `beacon-check-internal-refs` from
   `@beaconsgg/eslint-config` with `--strict`. The check fails on anything in the repository that a
   public reader can't open: an issue number, a private planning doc or a person's name. A link into
   the public GitHub organization passes. The root manifest names that organization in
   `beacon.internalRefs.publicOrg`. The check still lists the organization's current names without
   failing on them (`--allow org-names`). Those names change on the day the repository moves to
   the public organization.
5. **The rest.** The build and the typecheck run first. The suites run with coverage, and then the
   lint and the format check run.

Two more jobs run beside the gate on every pull request. The `docker` job builds the server and
Cartographer images. The `s3-integration` job runs the media store's S3 path against MinIO.

## The skew matrix

`.github/workflows/skew.yml` runs the five flows across versions, as beacon.core's
`doc/core-compatibility.md` §6 describes. The matrix runs the driver over the published SDK at each
edge of the core window against the head's server. The matrix also runs the head's driver against
the server at this repository's latest release tag. The `apps/flows` suite covers both sides at the
head in every gate. The cells run on a pull request that changes the server, the driver or the
lockfile. The `Skew matrix` job runs on every ready pull request and is a required check. The job
passes when each cell passed or had no reason to run, and fails when a cell failed. So a red cell
blocks the merge. Section 4 of beacon.core's `doc/release-runbook.md` says how to read one.

## Release

Merging to `main` validates a change and ships nothing. To release, run the Release workflow by
hand on `main` with `gh workflow run release.yml`. In GitHub the same workflow is under Actions >
Release > Run workflow. The workflow:

1. picks the tag, which is the next patch version (`v1.2.4` after `v1.2.3`) unless you name one
   with `-f tag=v1.3.0`;
2. runs the gate on that commit;
3. pushes the three images to GitHub Container Registry with the release tag and `latest`;
4. publishes the five-flow driver (`@beaconsgg/flows`) to npm when its
   version is new;
5. creates the git tag and the GitHub Release.

The three images are `beacon-server`, `beacon-atlas-cartographer` and `beacon-atlas-import`.

A run that fails leaves no tag behind. The images go up with the workflow's
own token. The driver goes to npm with the `NPM_TOKEN` repository
secret. To deploy a release, pull its tag as [`doc/deploy.md`](doc/deploy.md) describes.

A change across repositories goes out in order. Core releases first. This server follows, and then
the game. beacon.core's
[`doc/release-runbook.md`](https://github.com/beacons-gg/beacon.core/blob/main/doc/release-runbook.md)
covers the order and how to back a change out.

## Contributing and license

The project isn't accepting pull requests from outside contributors right now. Issues are welcome,
and [`CONTRIBUTING.md`](CONTRIBUTING.md) describes how to open one and how the project is built.
Report a security issue in private, as [`SECURITY.md`](SECURITY.md) describes.

The server, Atlas and the server's internal packages are licensed under the GNU Affero General Public
License version 3 only ([`LICENSE`](LICENSE)). A server that runs a modified build must offer its
users that build's source, and `BEACON_SOURCE_URL` links the source from the home page ([`doc/deploy.md`](doc/deploy.md)). The five-flow
driver `@beaconsgg/flows` is licensed under the Apache License 2.0
([`apps/flows/LICENSE`](apps/flows/LICENSE)). The copyright holder is NorthCtrl LLC, as
[`COPYRIGHT`](COPYRIGHT) and [`apps/flows/NOTICE`](apps/flows/NOTICE) state.

## History

The code was developed inside an earlier Beacon repository until October 2026 and moved here with
its history. A commit message that names an issue or pull request in another repository refers to
that repository. Beacon's published packages continue in beacon.core.
