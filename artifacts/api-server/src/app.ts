import express, { type Express } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import path from "path";
import { existsSync } from "fs";
import router from "./routes";
import { logger } from "./lib/logger";
import { initMonitor } from "./services/monitor";

const app: Express = express();

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use("/api", router);

// Serve the built React frontend when STATIC_DIR is set (e.g. in the Umbrel Docker image).
// This makes the single Express process serve both /api and the SPA — no separate static
// server or reverse proxy needed inside the container, so /api requests from the frontend
// always reach the right place regardless of which port is exposed.
const staticDir = process.env.STATIC_DIR;
if (staticDir && existsSync(staticDir)) {
  app.use(express.static(staticDir));
  // SPA fallback: any non-API route returns index.html so client-side routing works
  app.use((_req, res) => {
    res.sendFile(path.join(staticDir, "index.html"));
  });
  logger.info({ staticDir }, "Serving frontend static files");
}

// Start the monitoring engine (non-blocking)
initMonitor().catch((err) => {
  logger.error({ err }, "Monitor init failed");
});

export default app;
