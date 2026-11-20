# osm2pgsql import job (apps/atlas/doc/spec/cartographer.md §3). Debian bookworm ships
# osm2pgsql 1.8 — flex output with jsonb columns and native multipolygon
# assembly, everything beacon-places.lua needs. No pinned third-party image.
#
# Built from the REPO ROOT, like cartographer, so the image can carry the root LICENSE and
# COPYRIGHT. The root .dockerignore keeps the multi-GB pbf/ extracts out of the build context.
FROM debian:bookworm-slim
RUN apt-get update \
  && apt-get install -y --no-install-recommends osm2pgsql \
  && rm -rf /var/lib/apt/lists/*
# Baked in so a pulled image needs no repo checkout.
# Editing the Lua locally means rebuilding the image first.
COPY apps/atlas/osm-import/beacon-places.lua /lua/beacon-places.lua
# The Lua style is part of the program, and the AGPLv3 asks that a copy of the license go with
# every copy of it. The copyright notice goes with it.
COPY LICENSE COPYRIGHT /lua/
