#!/usr/bin/env bash
# Runs the end-to-end acceptance test against the local installation (uses a throw-away Node container).
#   ADMIN_EMAIL=admin@example.com ADMIN_PASSWORD=... tests/run-acceptance.sh [http-port]
set -Eeuo pipefail
PORT="${1:-80}"
: "${ADMIN_EMAIL:?set ADMIN_EMAIL}"; : "${ADMIN_PASSWORD:?set ADMIN_PASSWORD}"
DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
exec docker run --rm --network host -e BASE_URL="http://127.0.0.1:${PORT}" -e ADMIN_EMAIL -e ADMIN_PASSWORD \
  -v "$DIR:/t:ro" node:22.11.0-alpine3.20 node /t/acceptance.js
