import app, { rateLimitStore } from "./app";
import { logger } from "./lib/logger";
import { initMonitor } from "./services/monitor";

// Periodically purge expired rate-limit windows so dead rows can't accumulate
// and bloat the table (see PgRateLimitStore.cleanupExpired). Configurable via
// RATE_LIMIT_CLEANUP_INTERVAL_MS; defaults to 5 minutes. Only runs when the
// Postgres-backed store is active (production); the in-memory store used in
// tests needs no cleanup.
const DEFAULT_CLEANUP_INTERVAL_MS = 5 * 60 * 1000;

function resolveCleanupIntervalMs(): number {
  const raw = process.env["RATE_LIMIT_CLEANUP_INTERVAL_MS"];
  if (!raw) {
    return DEFAULT_CLEANUP_INTERVAL_MS;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    logger.warn(
      { raw },
      "Invalid RATE_LIMIT_CLEANUP_INTERVAL_MS; using default",
    );
    return DEFAULT_CLEANUP_INTERVAL_MS;
  }
  return parsed;
}

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

const server = app.listen(port, () => {
  logger.info({ port }, "Server listening");

  // Start the monitoring engine only after the HTTP server is accepting
  // connections. This guarantees the port is bound before any background work
  // begins, so a misbehaving monitor can never delay or block startup.
  initMonitor().catch((err) => {
    logger.error({ err }, "Monitor init failed");
  });

  // Kick off periodic cleanup of expired rate-limit windows. The store is only
  // defined when the Postgres-backed store is active (see app.ts).
  if (rateLimitStore) {
    const intervalMs = resolveCleanupIntervalMs();
    rateLimitStore.startCleanup(intervalMs);
    logger.info({ intervalMs }, "Rate-limit window cleanup scheduled");
  }
});

// A bind failure (e.g. EADDRINUSE) is emitted as an 'error' event, not passed
// to the listen callback. Without this handler it would surface as an uncaught
// exception; handle it explicitly so the container exits and restarts cleanly.
server.on("error", (err) => {
  logger.error({ err }, "HTTP server failed to start");
  process.exit(1);
});
