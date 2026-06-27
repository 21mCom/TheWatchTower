#!/bin/sh
set -e

# Run DB migrations
echo "Running DB migrations..."
node /app/server/dist/migrate.mjs || true

# Start API server in background on port 8080
echo "Starting API server..."
PORT=8080 node --enable-source-maps /app/server/dist/index.mjs &

# Start static file server + proxy on port 3000
# Serve frontend at / and proxy /api to localhost:8080
echo "Starting web server..."
exec serve /app/public -l 3000 --no-clipboard
