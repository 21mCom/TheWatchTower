/**
 * Integration test: the general API rate limiter (120 req/min) applies to all /api/* routes.
 *
 * app.ts mounts: app.use("/api", generalApiLimiter, router)
 * If middleware order changes or a new sub-router is mounted outside that chain,
 * the 120 req/min baseline protection could silently disappear.
 *
 * This test imports the REAL app from app.ts (the production Express instance with
 * its actual middleware chain) and fires 121 requests to GET /api/healthz, asserting:
 *   - Requests 1–120 pass the rate limiter (not 429).
 *   - Request 121 is blocked by the rate limiter (429 with an error body).
 *
 * initMonitor() has been moved to index.ts so importing app.ts here starts no
 * background services — the test remains fully self-contained.
 */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

let server: http.Server;
let baseUrl: string;

before(async () => {
  const { default: app } = await import("../../app.js");

  server = http.createServer(app);
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const addr = server.address() as { port: number };
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

after(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
});

test("GET /api/healthz: requests 1–120 pass the general limiter, request 121 returns 429", async () => {
  for (let i = 1; i <= 120; i++) {
    const res = await fetch(`${baseUrl}/api/healthz`);
    assert.notEqual(
      res.status,
      429,
      `Request ${i}/120 should not be rate-limited (got ${res.status})`,
    );
  }

  const overLimit = await fetch(`${baseUrl}/api/healthz`);
  assert.equal(
    overLimit.status,
    429,
    `Request 121 should be rate-limited by the general /api limiter (got ${overLimit.status})`,
  );

  const body = (await overLimit.json()) as { error?: string };
  assert.ok(
    typeof body.error === "string" && body.error.length > 0,
    "429 response should include an error message",
  );
});
