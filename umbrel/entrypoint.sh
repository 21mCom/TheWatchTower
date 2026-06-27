#!/bin/sh
set -e

# Run DB schema push / migrations before starting
echo "Running DB push..."
node /app/server/dist/migrate.mjs 2>/dev/null || true

# Start the Express server (serves both /api and static files)
echo "Starting Watchtower server on port ${PORT:-3000}..."
exec PORT="${PORT:-3000}" STATIC_DIR="/app/public" node --enable-source-maps /app/server/dist/index.mjs
