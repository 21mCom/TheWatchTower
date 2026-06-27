import express, { type Express } from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
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

// Security headers — helmet must be first so every response gets the headers
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", "data:"],
      connectSrc: ["'self'"],
      fontSrc: ["'self'"],
      objectSrc: ["'none'"],
      frameAncestors: ["'self'"],
    },
  },
}));

// CORS — same-origin only in production; allow localhost variants in development
const isDev = process.env.NODE_ENV === "development";
app.use(cors({
  origin: isDev
    ? (origin, callback) => {
        // Allow requests with no origin (same-origin, curl, etc.) and localhost
        if (!origin || /^https?:\/\/localhost(:\d+)?$/.test(origin)) {
          callback(null, true);
        } else {
          callback(new Error("Not allowed by CORS"));
        }
      }
    : false,
  credentials: true,
}));

// Body size cap — prevents large-payload denial-of-service
app.use(express.json({ limit: "64kb" }));
app.use(express.urlencoded({ extended: true, limit: "64kb" }));

// General API rate limit — 120 req/min per IP as a baseline
const generalApiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests, please slow down." },
});

app.use("/api", generalApiLimiter, router);

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
