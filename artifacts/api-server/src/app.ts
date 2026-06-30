import express, { type Express } from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import pinoHttp from "pino-http";
import path from "path";
import { existsSync } from "fs";
import router from "./routes";
import { logger } from "./lib/logger";
import { PgRateLimitStore } from "./lib/pg-rate-limit-store.js";

const app: Express = express();

// Trust exactly one upstream proxy hop (Umbrel's nginx app_proxy).
//
// This tells Express to derive req.ip from the X-Forwarded-For header set by
// the immediate reverse proxy rather than the raw TCP remote address.  It is
// safe to enable only because Umbrel's nginx is configured (via APP_NGINX_CONF
// in umbrel/docker-compose.yml) to OVERWRITE any client-supplied XFF with
// `proxy_set_header X-Forwarded-For $remote_addr` before forwarding — nginx
// never appends to a header the client already sent.  Without that nginx-side
// stripping, enabling trust proxy here would let an attacker forge an
// X-Forwarded-For address and appear as a different IP to the rate limiter.
app.set("trust proxy", 1);

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
      // Remove helmet's default `upgrade-insecure-requests` directive. Umbrel
      // serves this app over plain HTTP (http://umbrel.local:<port>) with no
      // TLS, so the browser must NOT auto-upgrade sub-resource requests
      // (JS/CSS/favicon) to https — that yields net::ERR_SSL_PROTOCOL_ERROR for
      // every asset and a blank page. helmet keeps this default unless we
      // explicitly disable it by setting the directive to null.
      upgradeInsecureRequests: null,
    },
  },
  // Disable two helmet defaults that are no-ops over plain HTTP and only
  // produce console noise on Umbrel (which serves this app without TLS):
  //  - Cross-Origin-Opener-Policy: browsers IGNORE it on a non-secure origin
  //    ("untrustworthy origin") and log an error.
  //  - Origin-Agent-Cluster: triggers a warning when the same origin is loaded
  //    both with and without the header (site- vs origin-keyed mismatch).
  // Neither adds security for a same-origin, LAN-only HTTP app.
  crossOriginOpenerPolicy: false,
  originAgentCluster: false,
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

// General API rate limit — 120 req/min per IP as a baseline.
// req.ip is derived from the XFF header set by Umbrel's nginx (trust proxy = 1
// above).  nginx overwrites any client-supplied XFF with $remote_addr, so the
// per-IP bucket is always keyed on the real connecting IP — see APP_NGINX_CONF
// in umbrel/docker-compose.yml and xff-rate-limit-spoofing.test.ts.
//
// Store selection:
// - In production (NODE_ENV !== "test" and DATABASE_URL set): PgRateLimitStore
//   so counters survive process restarts (Umbrel's on-failure restart policy
//   would otherwise grant every IP a fresh window on each crash).
// - In tests / environments without Postgres: default MemoryStore so the test
//   suite stays self-contained with no leftover counts across runs.
const rateLimitStore =
  process.env.DATABASE_URL && process.env.NODE_ENV !== "test"
    ? new PgRateLimitStore(process.env.DATABASE_URL)
    : undefined;

const generalApiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests, please slow down." },
  ...(rateLimitStore ? { store: rateLimitStore } : {}),
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

export default app;
