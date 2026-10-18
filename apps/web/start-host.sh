#!/bin/sh
set -eu

# Docker locally / Application Runtime: serve directly. Sandboxes: the SDK starts
# the same compiled server through the process API with restart supervision.
if [ "${MEDIAPACK_HOST_MODE:-application}" = "sandbox" ]; then
  exec /usr/local/bin/sandbox-api
fi
exec node /app/apps/web/server.js
