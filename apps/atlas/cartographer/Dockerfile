# syntax=docker/dockerfile:1

# ─────────────────────────────────────────────────────────────────────────────
# cartographer — Atlas's builder (apps/atlas/doc/spec/cartographer.md).
#
# Built from the REPO ROOT, not from apps/atlas/, because it is a pnpm workspace
# member: `pnpm deploy` emits a self-contained bundle of its dist + production
# deps. The root .dockerignore keeps the multi-GB osm-import/pbf
# extracts out of the build context — they arrive as a read-only mount instead,
# which is what stage 0 hashes.
#
# Same shape as the server image (the root Dockerfile), for the same reasons.
# ─────────────────────────────────────────────────────────────────────────────

FROM node:22-bookworm-slim AS build

RUN corepack enable && corepack prepare pnpm@10.33.0 --activate
WORKDIR /repo

# Manifests + lockfile first so the dependency layer caches across source edits.
COPY pnpm-workspace.yaml pnpm-lock.yaml .npmrc package.json ./
# It depends on the server-side packages (@beaconsgg/place-taxonomy, the shared classifier, and
# four more), so the packages tree comes along and `--filter …...` builds them first. The Beacon
# core packages come from the registry .npmrc maps the scope to: your npm user config (with the
# registry token, when the registry needs one) is a BuildKit secret on the fetching RUNs, as in
# the server image.
COPY packages/ ./packages/
COPY apps/atlas/cartographer/ ./apps/atlas/cartographer/
COPY turbo.json ./

RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
  --mount=type=secret,id=npmrc,target=/root/.npmrc,required=true \
  pnpm install --frozen-lockfile --filter @beaconsgg/cartographer...

# The trailing `...` builds the workspace dependencies too — without it
# @beaconsgg/place-taxonomy has no dist/ and cartographer's own tsc can't resolve
# it. (Turbo does this for you at the repo root, which is why the normal gates
# don't catch a missing `...`.)
RUN pnpm --filter @beaconsgg/cartographer... run build
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
  --mount=type=secret,id=npmrc,target=/root/.npmrc,required=true \
  pnpm --filter @beaconsgg/cartographer --legacy deploy --prod /out

FROM node:22-bookworm-slim AS runtime

ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /out /app
# The license and copyright notice go with every copy of the program, as in the server image.
COPY --chown=node:node LICENSE COPYRIGHT /app/
USER node

# The stage + its flags are appended by the compose `command:`.
ENTRYPOINT ["node", "dist/main.js"]
