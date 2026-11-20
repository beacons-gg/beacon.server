# syntax=docker/dockerfile:1

# ─────────────────────────────────────────────────────────────────────────────
# Beacon server: multi-stage image (doc/deploy.md).
#
# The repo is a pnpm workspace: apps/server and the server-side packages it is built from
# (packages/server/*). The Beacon core packages (@beaconsgg/geo, identity, protocol-types, ...) come
# from the registry .npmrc maps the scope to, so the fetching RUNs mount your npm user config (with
# the registry token, when the registry needs one) as a BuildKit secret at /root/.npmrc
# (`--secret id=npmrc,src=...`; the compose files and the workflows pass it); it never lands in a
# layer. We build the workspace, then use `pnpm deploy` to emit a self-contained bundle of ONLY
# apps/server's dist + its production dependencies (the built
# server packages, the core packages, pg, NestJS, socket.io ...). The runtime image carries that
# bundle and nothing else: no source, no dev deps, no pnpm, no token.
#
# Runtime is `node dist/main.js` as a non-root user. Migrations run on boot
# (createStores → migrate → runMigrations), so the container is self-provisioning against
# a fresh Postgres. One process per database: see docker-compose.yml.
# ─────────────────────────────────────────────────────────────────────────────

# ── Stage 1: build the workspace and emit a deployable server bundle ─────────
FROM node:22-bookworm-slim AS build

# No C++ toolchain here on purpose: every native dep the server pulls in (esbuild) resolves
# to a prebuilt binary. The one that once needed python3/make/g++ was
# better-sqlite3, removed with SQLite.

# Pin pnpm to the version the repo declares (package.json > packageManager).
RUN corepack enable && corepack prepare pnpm@10.33.0 --activate

WORKDIR /repo

# Copy manifests + lockfile first so the dependency layer caches across source edits.
COPY pnpm-workspace.yaml pnpm-lock.yaml .npmrc package.json ./
COPY packages/ ./packages/
COPY apps/server/ ./apps/server/
COPY turbo.json ./

# Install the whole workspace against the frozen lockfile (reproducible), allowing
# the postinstall builds the repo allowlists (esbuild, nest), see
# pnpm-workspace.yaml > onlyBuiltDependencies. The npm user config is the secret mount, required so
# a missing file fails here. When the registry needs a token and the config holds none, the first
# @beaconsgg/* fetch fails with a 401 at this line, not somewhere later.
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
  --mount=type=secret,id=npmrc,target=/root/.npmrc,required=true \
  pnpm install --frozen-lockfile

# Build every workspace package + apps/server (turbo). Emits each package's dist/
# and apps/server/dist (incl. the copied migration SQL).
RUN pnpm --filter @beaconsgg/server-app... run build

# Emit a self-contained production bundle for apps/server into /out:
#   /out/dist, /out/package.json, /out/node_modules (built @beaconsgg/* + prod deps).
# `--legacy` deploys without requiring inject-workspace-packages in the repo config;
# `--prod` drops devDependencies. It may fetch what the install left out of the store (a prod
# dependency's metadata), so it has the token too.
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
  --mount=type=secret,id=npmrc,target=/root/.npmrc,required=true \
  pnpm --filter @beaconsgg/server-app --legacy deploy --prod /out

# ── Stage 2: lean runtime ────────────────────────────────────────────────────
FROM node:22-bookworm-slim AS runtime

ENV NODE_ENV=production
# Default listen port; docker-compose maps it. Overridable at run time.
ENV PORT=3001

WORKDIR /app

# The self-contained server bundle (dist + node_modules + package.json). `node`'s
# own user (uid 1000) ships in the base image — run non-root, owning the app dir.
COPY --from=build --chown=node:node /out /app
# The AGPLv3 asks that a copy of the license go with every copy of the program, and the image is
# one. The copyright notice goes with it.
COPY --chown=node:node LICENSE COPYRIGHT /app/

# Server version, injected at **build time** and advertised in the signed descriptor
# (config.ts reads BEACON_VERSION at boot). Release images bake the GitHub release tag (minus the
# `v`) via `.github/workflows/release.yml`; a local build can override with
# `--build-arg BEACON_VERSION=x.y.z` (or compose `build.args`). Baking it keeps the version a
# property of the image, not a deploy-time knob — though an explicit runtime env still wins.
# Deliberately BELOW the COPY: a new version value then invalidates only this zero-cost metadata
# layer, not the bundle-sized COPY (which would otherwise re-materialize every release).
ARG BEACON_VERSION=0.0.1
ENV BEACON_VERSION=${BEACON_VERSION}

USER node

EXPOSE 3001

# Migrations run inside main.js on boot; the process is the single DB writer.
CMD ["node", "dist/main.js"]
