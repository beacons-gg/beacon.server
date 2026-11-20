#!/usr/bin/env bash
# One cell of the skew matrix (beacon.core's doc/core-compatibility.md §6): boot a built server on a fresh
# port, run a built five-flow driver against it, and exit with the driver's code.
#
#   BEACON_DATABASE_URL=postgres://… scripts/skew-cell.sh <server main.js> <driver main.js>
#
# The two sides come from different installs: the head's workspace, a release tag's tree, or a
# directory holding the driver over registry copies of the seven. This script does not care which;
# .github/workflows/skew.yml builds them. The database must be the server's alone (one server per
# database), and fresh enough that an older server's migrations are the newest it has seen.
set -euo pipefail

server_main=${1:?usage: skew-cell.sh <server main.js> <driver main.js>}
driver_main=${2:?usage: skew-cell.sh <server main.js> <driver main.js>}
# Exit 3 is "the cell could not run", apart from the driver's 1, "a flow failed".
[ -n "${BEACON_DATABASE_URL:-}" ] || {
  echo "BEACON_DATABASE_URL is not set: the server needs a database of its own" >&2; exit 3; }
[ -f "$server_main" ] || { echo "no server at $server_main (not built?)" >&2; exit 3; }
[ -f "$driver_main" ] || { echo "no driver at $driver_main (not built?)" >&2; exit 3; }

port=$(node -e 'const s=require("net").createServer().listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})')
origin="http://127.0.0.1:$port"
log=$(mktemp)

PORT=$port BEACON_HOST="127.0.0.1:$port" BEACON_PUBLIC_URL=$origin BEACON_CORS_ORIGINS="*" \
  node "$server_main" >"$log" 2>&1 &
server_pid=$!
trap 'kill "$server_pid" 2>/dev/null || true' EXIT

ready=""
for _ in $(seq 1 120); do
  if curl -sf "$origin/health/ready" >/dev/null; then ready=yes; break; fi
  if ! kill -0 "$server_pid" 2>/dev/null; then break; fi
  sleep 0.5
done
if [ -z "$ready" ]; then
  echo "the server at $server_main did not become ready on $origin:" >&2
  tail -n 60 "$log" >&2
  exit 3
fi

set +e
BEACON_FLOWS_SERVER=$origin node "$driver_main"
code=$?
set -e
if [ "$code" -ne 0 ]; then
  echo "--- the server's log (last 60 lines)" >&2
  tail -n 60 "$log" >&2
fi
exit "$code"
