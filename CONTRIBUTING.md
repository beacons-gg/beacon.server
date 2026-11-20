# Contributing

This repository holds the Beacon server, the server-side packages it is built from and the Atlas
toolchain. The [README](README.md) lists what lives where. Beacon's published core packages and the
client SDK are in the beacon.core repository, and the operator console is in beacon.admin. A change
to the wire or to a core package starts in beacon.core.

The project isn't accepting pull requests from outside contributors right now. Issues are welcome:
open one to report a bug or to propose a change. Report a security issue in private, as
[`SECURITY.md`](SECURITY.md) describes. Never open a public issue or pull request for one.

## Issues

Describe the problem, the release or commit you saw it on and the steps that reproduce it. For a
proposed change, describe the problem the change solves and the change you have in mind.

The server is game-agnostic. A change that teaches the server about one game's rules belongs in that
game, and the gate refuses an import of a game in server code.

## How a change is built

The maintainers build and change the project in these steps.

1. A change starts on a branch off `main`.
2. The workspace is set up as [Work in this repository](README.md#work-in-this-repository)
   describes: Node 22 from `.nvmrc`, pnpm from `packageManager` and Docker for the test database.
3. The change comes with tests. Every workspace holds a coverage floor, and the gate fails under the
   floor.
4. The gate passes locally before the change goes up for review:

   ```sh
   pnpm test:db
   export BEACON_TEST_DATABASE_URL=postgres://beacon:beacon@127.0.0.1:55432/beacon_test
   pnpm run gate
   ```

   `pnpm test:db` starts a throwaway Postgres database and prints the URL to export. The gate is the
   same script CI runs, and [The quality bar](README.md#the-quality-bar) lists its checks.

## Pull requests

A pull request opens as a **draft**. A draft runs no CI. The pull request is marked ready for review
once the gate passes locally. CI then runs the gate on that commit and on each later push.
Converting the pull request back to a draft stops the runs while work is in progress.

The pull request has a short title that a reader of the release notes understands. The body says
what changed and why, and names the issue the change closes.

A pull request merges once CI passes and a maintainer approves the change. The commits are squashed
into one.

## Writing

`pnpm run check:copy` checks the writing in these files:

- every README;
- every page under `doc/` and Atlas's specs;
- this guide and `SECURITY.md`.

The check is `beacon-check-copy` from `@beaconsgg/eslint-config`. The gate fails on any finding,
warnings included.

Every tracked file points only at what a public reader can open, and that includes code comments.
Name no issue or pull request numbers, private planning docs or people. Give the reasoning in place
of the reference. `pnpm run check:refs` finds these references, and the gate fails on any finding.

## Licenses

The server, Atlas and the server's internal packages are licensed under the GNU Affero General Public
License version 3 only ([`LICENSE`](LICENSE)). The five-flow driver (`apps/flows`, published as
`@beaconsgg/flows`) is licensed under the Apache License 2.0 (`apps/flows/LICENSE`). NorthCtrl LLC
holds the copyright in both, as [`COPYRIGHT`](COPYRIGHT) and `apps/flows/NOTICE` state.
