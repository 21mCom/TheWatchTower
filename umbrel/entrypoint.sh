#!/bin/sh
set -e

# Initialize DB schema — includes its own readiness retry loop (up to 60s).
# Exits non-zero on failure so the container restarts instead of starting
# with missing tables.
echo "Initializing database schema..."
node /app/server/dist/migrate.mjs

# Start the Express server (serves both /api and static files on a single port)
echo "Starting Watchtower server on port ${PORT:-3000}..."
exec PORT="${PORT:-3000}" STATIC_DIR="/app/public" node --enable-source-maps /app/server/dist/index.mjs
