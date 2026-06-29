/**
 * Integration test: PUT /settings rejects out-of-range port numbers with 400.
 *
 * electrumPort and xmppPort are constrained to the valid TCP range (1–65535).
 * Values of 0, negative numbers, and values above 65535 must be rejected before
 * the data is written to the database, preventing confusing downstream failures.
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

test("PUT / with electrumPort above 65535 returns 400", async () => {
  const res = await fetch(`${baseUrl}/`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ electrumPort: 99999 }),
  });

  assert.equal(res.status, 400, `Expected 400 but got ${res.status}`);

  const body = await res.json() as { error?: string };
  assert.ok(
    typeof body.error === "string" && body.error.length > 0,
    "400 response should include an error message",
  );
});

test("PUT / with electrumPort of 0 returns 400", async () => {
  const res = await fetch(`${baseUrl}/`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ electrumPort: 0 }),
  });

  assert.equal(res.status, 400, `Expected 400 but got ${res.status}`);

  const body = await res.json() as { error?: string };
  assert.ok(
    typeof body.error === "string" && body.error.length > 0,
    "400 response should include an error message",
  );
});

test("PUT / with xmppPort above 65535 returns 400", async () => {
  const res = await fetch(`${baseUrl}/`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ xmppPort: 70000 }),
  });

  assert.equal(res.status, 400, `Expected 400 but got ${res.status}`);

  const body = await res.json() as { error?: string };
  assert.ok(
    typeof body.error === "string" && body.error.length > 0,
    "400 response should include an error message",
  );
});

test("PUT / with xmppPort below 1 returns 400", async () => {
  const res = await fetch(`${baseUrl}/`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ xmppPort: -1 }),
  });

  assert.equal(res.status, 400, `Expected 400 but got ${res.status}`);

  const body = await res.json() as { error?: string };
  assert.ok(
    typeof body.error === "string" && body.error.length > 0,
    "400 response should include an error message",
  );
});
