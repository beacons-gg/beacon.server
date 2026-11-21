# Develop the server

This page is for the maintainers. The [README](../README.md) covers the setup and the everyday
commands. This page covers what the server takes from Beacon Core and the checks in the gate. The
page also covers CI and the skew matrix.

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
   `beacon.internalRefs.publicOrg`.
5. **The rest.** The build and the typecheck run first. The suites run with coverage, and then the
   lint and the format check run.

Two more jobs run beside the gate on every pull request. The `docker` job builds the server and
Cartographer images. The `s3-integration` job runs the media store's S3 path against MinIO.

## The skew matrix

`.github/workflows/skew.yml` runs the five flows across versions, as beacon.core's
[`doc/core-compatibility.md`](https://github.com/beacons-gg/beacon.core/blob/main/doc/core-compatibility.md) §6 describes. The matrix runs the driver over the published SDK at each
edge of the core window against the head's server. The matrix also runs the head's driver against
the server at this repository's latest release tag. The `apps/flows` suite covers both sides at the
head in every gate. The cells run on a pull request that changes the server, the driver or the
lockfile. The `Skew matrix` job runs on every ready pull request and is a required check. The job
passes when each cell passed or had no reason to run, and fails when a cell failed. So a red cell
blocks the merge. Section 4 of beacon.core's [`doc/release-runbook.md`](https://github.com/beacons-gg/beacon.core/blob/main/doc/release-runbook.md) says how to read one.
