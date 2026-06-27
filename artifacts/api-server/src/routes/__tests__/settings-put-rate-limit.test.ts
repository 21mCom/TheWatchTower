/**
 * Integration test: the settings write rate limiter blocks excessive PUT /settings requests.
 *
 * The settingsWriteLimiter (10 req/min per IP) must be applied to PUT /settings before
 * the route handler runs. This test sends 11 requests in quick succession and asserts:
 *   - Requests 1–10 are not rejected by the rate limiter (they may return 500 because
 *     an empty-but-valid body produces an empty drizzle update, but they are NOT 429).
 *   - Request 11 returns HTTP 429.
 *
 * We deliberately send {} so the route handler throws before ever reaching reloadMonitor(),
 * which avoids starting the Electrum reconnect loop and keeps the test process clean.
 * The rate limiter still increments its counter before the handler runs.
 */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";

let server: http.Server;
let baseUrl: string;

before(async () => {
  const { default: settingsRouter } = await import("../settings.js");

  const app = express();
  app.use(express.json());
  app.use("/", settingsRouter);

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

test("PUT / is rate-limited: requests 1–10 pass the limiter, request 11 returns 429", async () => {
  for (let i = 1; i <= 10; i++) {
    const res = await fetch(`${baseUrl}/`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.notEqual(
      res.status,
      429,
      `Request ${i}/10 should not be rate-limited (got ${res.status})`,
    );
  }

  const eleventh = await fetch(`${baseUrl}/`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  assert.equal(
    eleventh.status,
    429,
    `Request 11 should be rate-limited (got ${eleventh.status})`,
  );

  const body = await eleventh.json() as { error?: string };
  assert.ok(
    typeof body.error === "string" && body.error.length > 0,
    "429 response should include an error message",
  );
});
