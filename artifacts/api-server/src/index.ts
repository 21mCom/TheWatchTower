import app from "./app";
import { logger } from "./lib/logger";
import { initMonitor } from "./services/monitor";

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
});

// A bind failure (e.g. EADDRINUSE) is emitted as an 'error' event, not passed
// to the listen callback. Without this handler it would surface as an uncaught
// exception; handle it explicitly so the container exits and restarts cleanly.
server.on("error", (err) => {
  logger.error({ err }, "HTTP server failed to start");
  process.exit(1);
});
