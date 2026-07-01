/**
 * Unit tests for XmppService connection-failure reporting.
 *
 * Task #105 added connection-error classification (auth / host-not-found / tls /
 * timeout / other) and routed the specific reason into the test-alert response.
 * These tests lock that behavior in so a future change cannot silently regress
 * it back to a generic "not connected" message or make connect() hang forever.
 *
 * Covered here:
 *   - isConfigured() in SRV mode: a blank server host is valid (auto-discovery),
 *     but a missing JID / password / recipient is not.
 *   - classify() maps each representative raw error onto the right kind.
 *   - connect() times out and classifies as "timeout" (instead of hanging) when
 *     the underlying client's start() never resolves.
 *   - A permanent auth failure is NOT auto-retried, while a transient failure IS
 *     scheduled for reconnect.
 *
 * No external network or database access: classification is exercised directly,
 * the timeout uses a fake client (via the overridable createClient seam) whose
 * start() never resolves, and reconnect scheduling stubs doConnect() on the
 * instance so the branch is tested deterministically.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { client } from "@xmpp/client";

// Keep the connect timeout short and the reconnect delay long so the timeout
// test fires promptly and no scheduled retry actually runs during the suite.
// These are read once per XmppService construction, so set them before importing.
process.env.XMPP_CONNECT_TIMEOUT_MS = "300";
process.env.XMPP_RECONNECT_DELAY_MS = "600000";

const { XmppService, XmppConnectError } = await import("../xmpp.js");
import type { XmppConfig, XmppErrorKind } from "../xmpp.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyRecord = Record<string, any>;

const baseConfig: XmppConfig = {
  server: "",
  port: 5222,
  jid: "watchtower@example.com",
  password: "hunter2",
  tls: false,
  recipientJid: "owner@example.com",
};

// ── isConfigured() ────────────────────────────────────────────────────────────

test("isConfigured: a blank server host is valid (SRV auto-discovery)", () => {
  const svc = new XmppService();
  svc.configure({ ...baseConfig, server: "" });
  assert.equal(
    svc.isConfigured(),
    true,
    "A blank server host must be treated as configured (endpoint discovered via SRV records).",
  );
  svc.disconnect();
});

test("isConfigured: missing JID, password, or recipient is not configured", () => {
  const svc = new XmppService();

  // No configuration at all.
  assert.equal(svc.isConfigured(), false, "Unconfigured service must report false.");

  svc.configure({ ...baseConfig, jid: "" });
  assert.equal(svc.isConfigured(), false, "Missing JID must report false.");

  svc.configure({ ...baseConfig, password: "" });
  assert.equal(svc.isConfigured(), false, "Missing password must report false.");

  svc.configure({ ...baseConfig, recipientJid: "" });
  assert.equal(svc.isConfigured(), false, "Missing recipient must report false.");

  svc.disconnect();
});

// ── classify() — one representative error per kind ────────────────────────────

test("classify: SASL / not-authorized errors map to 'auth'", () => {
  const svc = new XmppService() as unknown as AnyRecord;
  const kind = (err: unknown): XmppErrorKind => svc.classify(err).kind;

  assert.equal(kind({ name: "SASLError", message: "not-authorized" }), "auth");
  assert.equal(kind(new Error("not-authorized")), "auth");
  assert.equal(kind(new Error("invalid credentials")), "auth");
  (svc as unknown as InstanceType<typeof XmppService>).disconnect();
});

test("classify: DNS / connection-refused errors map to 'host-not-found'", () => {
  const svc = new XmppService() as unknown as AnyRecord;
  const kind = (err: unknown): XmppErrorKind => svc.classify(err).kind;

  assert.equal(kind({ code: "ENOTFOUND", message: "getaddrinfo ENOTFOUND xmpp.invalid" }), "host-not-found");
  assert.equal(kind(new Error("connect ECONNREFUSED 127.0.0.1:5222")), "host-not-found");
  (svc as unknown as InstanceType<typeof XmppService>).disconnect();
});

test("classify: certificate / TLS errors map to 'tls'", () => {
  const svc = new XmppService() as unknown as AnyRecord;
  const kind = (err: unknown): XmppErrorKind => svc.classify(err).kind;

  assert.equal(kind(new Error("self-signed certificate in certificate chain")), "tls");
  assert.equal(kind(new Error("ERR_TLS_CERT_ALTNAME_INVALID")), "tls");
  (svc as unknown as InstanceType<typeof XmppService>).disconnect();
});

test("classify: timed-out errors map to 'timeout'", () => {
  const svc = new XmppService() as unknown as AnyRecord;
  const kind = (err: unknown): XmppErrorKind => svc.classify(err).kind;

  assert.equal(kind(new Error("connect ETIMEDOUT")), "timeout");
  assert.equal(kind(new Error("the request timed out")), "timeout");
  (svc as unknown as InstanceType<typeof XmppService>).disconnect();
});

test("classify: an unrecognized error maps to 'other' and preserves the message", () => {
  const svc = new XmppService() as unknown as AnyRecord;
  const info = svc.classify(new Error("something unexpected happened"));
  assert.equal(info.kind, "other");
  assert.match(info.message, /something unexpected happened/);
  (svc as unknown as InstanceType<typeof XmppService>).disconnect();
});

// ── connect() timeout ─────────────────────────────────────────────────────────

test("connect() times out (does not hang) and classifies as 'timeout' when start() never resolves", async () => {
  // A fake client whose start() never resolves models a server that accepts the
  // socket but never completes the XMPP handshake. The connect timeout (300ms)
  // must be the thing that fires — deterministically and without a real network.
  let stopCalled = false;
  class HangingXmpp extends XmppService {
    protected override createClient(): ReturnType<typeof client> {
      const fake: AnyRecord = {
        on() {},
        start() {
          return new Promise<void>(() => {
            /* never resolves */
          });
        },
        async stop() {
          stopCalled = true;
        },
        async send() {},
        reconnect: { stop() {} },
      };
      return fake as unknown as ReturnType<typeof client>;
    }
  }

  const svc = new HangingXmpp();
  svc.configure({ ...baseConfig, server: "127.0.0.1", port: 5222 });

  const started = Date.now();
  await assert.rejects(
    () => svc.connect(),
    (err: unknown) =>
      err instanceof XmppConnectError &&
      err.kind === "timeout" &&
      /timed out/i.test(err.message),
    "connect() must reject with a classified 'timeout' error, not hang or throw a generic error.",
  );
  const elapsed = Date.now() - started;
  assert.ok(
    elapsed >= 250 && elapsed < 3000,
    `connect() should time out around the configured 300ms, but took ${elapsed}ms.`,
  );

  assert.ok(stopCalled, "The timed-out client must be torn down (stop() called).");
  assert.equal(
    svc.getLastError()?.kind,
    "timeout",
    "The classified reason must be recorded on the service after a failed connect.",
  );

  svc.disconnect();
});

// ── auto-retry policy: auth is permanent, transient failures retry ───────────

test("a permanent auth failure is NOT auto-retried, but a transient failure IS scheduled", async () => {
  const svc = new XmppService();
  svc.configure({ ...baseConfig });
  const internal = svc as unknown as AnyRecord;

  // Auth failure → permanent → no reconnect timer.
  internal.doConnect = async () => {
    throw new XmppConnectError({ kind: "auth", message: "Authentication failed — check the JID and password." });
  };
  await assert.rejects(
    () => svc.connect(),
    (err: unknown) => err instanceof XmppConnectError && err.kind === "auth",
  );
  assert.equal(
    internal.reconnectTimer,
    null,
    "A permanent auth failure must not schedule an auto-retry (it cannot recover without a settings change).",
  );
  assert.equal(svc.getLastError()?.kind, "auth");

  // Transient failure → recoverable → a reconnect must be scheduled.
  internal.doConnect = async () => {
    throw new XmppConnectError({ kind: "host-not-found", message: "Could not reach the XMPP server." });
  };
  await assert.rejects(
    () => svc.connect(),
    (err: unknown) => err instanceof XmppConnectError && err.kind === "host-not-found",
  );
  assert.notEqual(
    internal.reconnectTimer,
    null,
    "A transient failure must schedule an automatic reconnect.",
  );
  assert.equal(svc.getLastError()?.kind, "host-not-found");

  svc.disconnect();
  assert.equal(internal.reconnectTimer, null, "disconnect() must clear any pending reconnect timer.");
});
