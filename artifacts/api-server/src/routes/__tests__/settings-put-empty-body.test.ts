/**
 * Integration test: PUT /settings with an empty (or unknown-keys-only) body returns 400,
 * not a 500 from the drizzle-orm "No values to set" error.
 *
 * When all fields in UpdateSettingsBody are optional, Zod accepts {} as valid.
 * Without the guard, drizzle immediately throws because the `updates` map is empty.
 * The fix returns 400 with a descriptive message before touching the DB.
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

test("PUT / with empty body returns 400 with a helpful message", async () => {
  const res = await fetch(`${baseUrl}/`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });

  assert.equal(res.status, 400, `Expected 400 but got ${res.status}`);

  const body = await res.json() as { error?: string };
  assert.ok(
    typeof body.error === "string" && body.error.length > 0,
    "400 response should include an error message",
  );
  assert.ok(
    body.error!.toLowerCase().includes("no fields"),
    `Error message should mention missing fields, got: "${body.error}"`,
  );
});

test("PUT / with only unknown keys returns 400 with a helpful message", async () => {
  const res = await fetch(`${baseUrl}/`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ unknownKey: "value", anotherBadKey: 42 }),
  });

  assert.equal(res.status, 400, `Expected 400 but got ${res.status}`);

  const body = await res.json() as { error?: string };
  assert.ok(
    typeof body.error === "string" && body.error.length > 0,
    "400 response should include an error message",
  );
});
