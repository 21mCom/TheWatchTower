/**
 * Integration test: POST /settings/test-alert reports the real, classified reason
 * a connection failed — not a generic "not connected" message — and never hangs.
 *
 * Task #105 routed the specific XMPP failure kind (auth / host-not-found / tls /
 * timeout / other) into the test-alert response. This test locks that in: it
 * stubs the shared XmppService singleton so ensureConnected() throws a classified
 * XmppConnectError, then asserts the route returns { success: false } with that
 * reason surfaced in the message.
 *
 * The route is mounted on its own express app (no monitor/DB initialization is
 * required) because the stub short-circuits before any network or DB access.
 */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { getXmpp } from "../../services/monitor.js";
import { XmppConnectError } from "../../services/xmpp.js";

let server: http.Server;
let baseUrl: string;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyRecord = Record<string, any>;

/**
 * Stub the singleton XmppService so it reports configured but fails to connect
 * with the given classified error. Returns a restore function.
 */
function stubXmppFailure(err: XmppConnectError): () => void {
  const xmpp = getXmpp() as unknown as AnyRecord;
  const originals = {
    isConfigured: xmpp.isConfigured,
    ensureConnected: xmpp.ensureConnected,
    sendAlert: xmpp.sendAlert,
  };
  xmpp.isConfigured = () => true;
  xmpp.ensureConnected = async () => {
    throw err;
  };
  xmpp.sendAlert = async () => {
    throw new Error("sendAlert must not be reached when the connection fails");
  };
  return () => {
    xmpp.isConfigured = originals.isConfigured;
    xmpp.ensureConnected = originals.ensureConnected;
    xmpp.sendAlert = originals.sendAlert;
  };
}

/** POST /test-alert, aborting after `timeoutMs` so a hung route fails the test. */
async function postTestAlert(timeoutMs = 5000): Promise<{ status: number; body: { success?: boolean; message?: string } }> {
  const res = await fetch(`${baseUrl}/test-alert`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal: AbortSignal.timeout(timeoutMs),
  });
  const body = (await res.json()) as { success?: boolean; message?: string };
  return { status: res.status, body };
}

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

test("test-alert surfaces the classified auth reason (not a generic message) and does not hang", async () => {
  const restore = stubXmppFailure(
    new XmppConnectError({ kind: "auth", message: "Authentication failed — check the JID and password." }),
  );
  try {
    const { status, body } = await postTestAlert();

    assert.equal(status, 200, "test-alert responds 200 with a JSON success flag even on failure");
    assert.equal(body.success, false, "A failed connection must report success: false");
    assert.ok(typeof body.message === "string", "A message must be present");
    assert.match(
      body.message!,
      /Authentication failed/i,
      `The classified auth reason must be surfaced, got: "${body.message}"`,
    );
    assert.doesNotMatch(
      body.message!,
      /not connected|not configured/i,
      `A generic message must NOT replace the classified reason, got: "${body.message}"`,
    );
  } finally {
    restore();
  }
});

test("test-alert surfaces the classified timeout reason for a different failure kind", async () => {
  const restore = stubXmppFailure(
    new XmppConnectError({ kind: "timeout", message: "Connection timed out after 15000ms — check the server host and port." }),
  );
  try {
    const { status, body } = await postTestAlert();

    assert.equal(status, 200);
    assert.equal(body.success, false);
    assert.match(
      body.message!,
      /timed out/i,
      `The classified timeout reason must be surfaced, got: "${body.message}"`,
    );
  } finally {
    restore();
  }
});
