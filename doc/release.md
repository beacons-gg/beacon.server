# Release the server

This page is for the maintainers. Running a server needs none of it: pull a released image as
[`deploy.md`](deploy.md) describes.

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
secret. To deploy a release, pull its tag as [`deploy.md`](deploy.md) describes.

A change across repositories goes out in order. Core releases first. This server follows, and then
the game. beacon.core's
[`doc/release-runbook.md`](https://github.com/beacons-gg/beacon.core/blob/main/doc/release-runbook.md)
covers the order and how to back a change out.
