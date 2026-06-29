#!/bin/sh
set -e

# Initialize DB schema — includes its own readiness retry loop (up to 60s).
# Exits non-zero on failure so the container restarts instead of starting
# with missing tables.
echo "Initializing database schema..."
node /app/artifacts/api-server/dist/migrate.mjs

# Start the Express server (serves both /api and static files on a single port).
# Note: `exec` does not accept inline VAR=value assignments, so export first.
echo "Starting Watchtower server on port ${PORT:-3000}..."
export PORT="${PORT:-3000}"
export STATIC_DIR="${STATIC_DIR:-/app/public}"
exec node --enable-source-maps /app/artifacts/api-server/dist/index.mjs
