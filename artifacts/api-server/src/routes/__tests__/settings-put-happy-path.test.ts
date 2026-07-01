/**
 * Integration test: PUT /settings happy path — a fully valid payload is
 * accepted, persisted, and round-trips unchanged.
 *
 * The other settings tests all cover rejection paths (out-of-range ports,
 * non-integer ports, empty body, rate limits). None of them confirm that a
 * well-formed payload is actually saved. This test guards against a regression
 * that breaks saving valid settings (e.g. a dropped schema field or a
 * serialization bug) which would otherwise slip through while every negative
 * test still passes.
 *
 * A successful PUT triggers reloadMonitor(), which spins up an ElectrumClient
 * (and, since XMPP is fully configured here, an XmppService connect attempt).
 * We therefore:
 *   - point both at a closed local port so the connects fail immediately
 *     instead of doing slow DNS/network I/O,
 *   - use a short XMPP connect timeout and long reconnect delays so no retry
 *     timer fires mid-test,
 *   - call destroyMonitor() in after() to clear the reconnect timers and let
 *     the test process exit cleanly.
 */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";

let server: http.Server;
let baseUrl: string;

const savedEnv: Record<string, string | undefined> = {};
function setEnv(key: string, value: string) {
  savedEnv[key] = process.env[key];
  process.env[key] = value;
}
function restoreEnv() {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

let destroyMonitor: () => void;

before(async () => {
  // Keep any post-connect retry timers from firing during the test; connects
  // fail fast against a closed local port and destroyMonitor() clears the rest.
  setEnv("ELECTRUM_RECONNECT_DELAY_MS", "3600000");
  setEnv("XMPP_RECONNECT_DELAY_MS", "3600000");
  setEnv("XMPP_CONNECT_TIMEOUT_MS", "500");

  ({ destroyMonitor } = await import("../../services/monitor.js"));

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
  // Tear down the ElectrumClient / XmppService started by reloadMonitor() so
  // their timers don't keep the event loop (and the test runner) alive.
  destroyMonitor();
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
  restoreEnv();
});

// A fully valid payload. electrumHost/xmppServer point at a closed local port
// (127.0.0.1:1) so the monitor's connect attempts fail immediately.
const validPayload = {
  electrumHost: "127.0.0.1",
  electrumPort: 1,
  electrumTls: true,
  electrumAllowSelfSigned: true,
  confirmationThreshold: 3,
  xmppServer: "127.0.0.1",
  xmppPort: 1,
  xmppJid: "tower@example.com",
  xmppPassword: "s3cr3t-pass",
  xmppTls: false,
  recipientJid: "owner@example.com",
  alertTemplate: "[{direction}] {label} — {amount_btc}",
};

// Fields that are echoed back in the response. xmppPassword is intentionally
// never returned, so it is excluded from the response comparison.
const echoedFields = {
  electrumHost: validPayload.electrumHost,
  electrumPort: validPayload.electrumPort,
  electrumTls: validPayload.electrumTls,
  electrumAllowSelfSigned: validPayload.electrumAllowSelfSigned,
  confirmationThreshold: validPayload.confirmationThreshold,
  xmppServer: validPayload.xmppServer,
  xmppPort: validPayload.xmppPort,
  xmppJid: validPayload.xmppJid,
  xmppTls: validPayload.xmppTls,
  recipientJid: validPayload.recipientJid,
  alertTemplate: validPayload.alertTemplate,
};

test("PUT / with a fully valid payload returns 2xx and echoes the submitted values", async () => {
  const res = await fetch(`${baseUrl}/`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(validPayload),
  });

  assert.ok(
    res.status >= 200 && res.status < 300,
    `Expected a 2xx response but got ${res.status}`,
  );

  const body = await res.json() as Record<string, unknown>;

  for (const [key, expected] of Object.entries(echoedFields)) {
    assert.deepEqual(
      body[key],
      expected,
      `Response field "${key}" should reflect the submitted value`,
    );
  }

  // Derived flag: all three of jid, password, recipient were provided.
  assert.equal(body.xmppConfigured, true, "xmppConfigured should be true");

  // The password must never be echoed back to the client.
  assert.ok(!("xmppPassword" in body), "Response must not include xmppPassword");
});

test("GET / after the update returns the persisted values", async () => {
  const res = await fetch(`${baseUrl}/`, { method: "GET" });

  assert.equal(res.status, 200, `Expected 200 but got ${res.status}`);

  const body = await res.json() as Record<string, unknown>;

  for (const [key, expected] of Object.entries(echoedFields)) {
    assert.deepEqual(
      body[key],
      expected,
      `Persisted field "${key}" should match the value written via PUT`,
    );
  }

  assert.equal(body.xmppConfigured, true, "xmppConfigured should be true");
});
