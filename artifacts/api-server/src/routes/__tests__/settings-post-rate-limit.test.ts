/**
 * Integration test: the settings write rate limiter blocks excessive POST /settings/test-alert requests.
 *
 * The settingsWriteLimiter (10 req/min per IP) must be applied to POST /settings/test-alert
 * before the route handler runs. This test sends 11 requests in quick succession and asserts:
 *   - Requests 1–10 are not rejected by the rate limiter (they return 200 with
 *     {success: false} because XMPP is unconfigured in the test environment).
 *   - Request 11 returns HTTP 429.
 *
 * No mocking is required: when the monitor service is never initialized (initMonitor() is
 * not called), getXmpp().isConfigured() returns false and the handler short-circuits with
 * a 200 response — no XMPP connection or database access occurs.
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

test("POST /test-alert is rate-limited: requests 1–10 pass the limiter, request 11 returns 429", async () => {
  for (let i = 1; i <= 10; i++) {
    const res = await fetch(`${baseUrl}/test-alert`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    });
    assert.notEqual(
      res.status,
      429,
      `Request ${i}/10 should not be rate-limited (got ${res.status})`,
    );
  }

  const eleventh = await fetch(`${baseUrl}/test-alert`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
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
