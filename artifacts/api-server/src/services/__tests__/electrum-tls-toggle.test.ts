/**
 * Unit tests: TLS certificate-verification toggle on ElectrumClient.
 *
 * The `allowSelfSigned` constructor parameter maps directly onto the
 * `rejectUnauthorized` option passed to `tls.connect`:
 *
 *   allowSelfSigned=false  →  rejectUnauthorized=true   (verify certs, default)
 *   allowSelfSigned=true   →  rejectUnauthorized=false  (skip verification, home-lab)
 *
 * These tests intercept `tls.connect` synchronously — before any real network
 * I/O — capture the options object, then immediately reject the connection so
 * the ElectrumClient promise settles and no reconnect timer is left dangling.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import tls from "tls";
import net from "net";
import { ElectrumClient } from "../electrum.js";

type TlsConnectOptions = Parameters<typeof tls.connect>[0];

/**
 * Replaces `tls.connect` with a stub that:
 *  1. Captures the options it is called with.
 *  2. Returns a real (unconnected) net.Socket so ElectrumClient's event-listener
 *     setup works normally.
 *  3. Emits an 'error' event on the next tick, which triggers settle(err) inside
 *     ElectrumClient.connect() and rejects the returned Promise.
 *
 * Returns the captured options accessor and a restore function.
 */
function stubTlsConnect(): {
  capturedOptions: () => TlsConnectOptions | undefined;
  restore: () => void;
} {
  let captured: TlsConnectOptions | undefined;
  const original = tls.connect.bind(tls);

  // @ts-expect-error — intentionally replacing the module export for testing
  tls.connect = (options: TlsConnectOptions): tls.TLSSocket => {
    captured = options;
    const fake = new net.Socket();
    // Emit 'error' on the next tick so ElectrumClient's listener is already
    // attached when the event fires, causing settle(err) to reject connect().
    process.nextTick(() => fake.emit("error", new Error("stub: no real TLS")));
    return fake as unknown as tls.TLSSocket;
  };

  return {
    capturedOptions: () => captured,
    restore: () => {
      // @ts-expect-error — restoring the original
      tls.connect = original;
    },
  };
}

/**
 * Replaces `net.connect` with a stub that also emits 'error' on the next tick
 * so the connect() promise rejects promptly in plain-TCP tests.
 */
function stubNetConnect(): { restore: () => void } {
  const original = net.connect.bind(net);

  // @ts-expect-error — intentionally replacing the module export for testing
  net.connect = (_options: net.NetConnectOpts): net.Socket => {
    const fake = new net.Socket();
    process.nextTick(() => fake.emit("error", new Error("stub: no real TCP")));
    return fake;
  };

  return {
    restore: () => {
      // @ts-expect-error — restoring the original
      net.connect = original;
    },
  };
}

// ── Test 1: cert verification ON by default ───────────────────────────────────

test("ElectrumClient passes rejectUnauthorized=true when allowSelfSigned is false (default)", async () => {
  const { capturedOptions, restore } = stubTlsConnect();

  try {
    // allowSelfSigned defaults to false — verification must be enabled.
    // Use a large reconnectDelayMs so any timer scheduled after rejection
    // doesn't fire during the test; we call destroy() to clean it up anyway.
    const client = new ElectrumClient("127.0.0.1", 50002, /* useTls */ true, 60_000);

    await client.connect().catch(() => {});
    client.destroy();

    const opts = capturedOptions();
    assert.ok(opts !== undefined, "tls.connect should have been called");
    assert.strictEqual(
      (opts as { rejectUnauthorized?: boolean }).rejectUnauthorized,
      true,
      "rejectUnauthorized must be true when allowSelfSigned=false (default) — " +
        "silently disabling cert verification would be a security regression",
    );
  } finally {
    restore();
  }
});

// ── Test 2: cert verification ON (explicit false) ─────────────────────────────

test("ElectrumClient passes rejectUnauthorized=true when allowSelfSigned is explicitly false", async () => {
  const { capturedOptions, restore } = stubTlsConnect();

  try {
    const client = new ElectrumClient(
      "127.0.0.1",
      50002,
      /* useTls */ true,
      /* reconnectDelayMs */ 60_000,
      /* allowSelfSigned */ false,
    );

    await client.connect().catch(() => {});
    client.destroy();

    const opts = capturedOptions();
    assert.ok(opts !== undefined, "tls.connect should have been called");
    assert.strictEqual(
      (opts as { rejectUnauthorized?: boolean }).rejectUnauthorized,
      true,
      "rejectUnauthorized must be true when allowSelfSigned=false (explicit)",
    );
  } finally {
    restore();
  }
});

// ── Test 3: cert verification OFF (home-lab / self-signed) ───────────────────

test("ElectrumClient passes rejectUnauthorized=false when allowSelfSigned is true", async () => {
  const { capturedOptions, restore } = stubTlsConnect();

  try {
    const client = new ElectrumClient(
      "127.0.0.1",
      50002,
      /* useTls */ true,
      /* reconnectDelayMs */ 60_000,
      /* allowSelfSigned */ true,
    );

    await client.connect().catch(() => {});
    client.destroy();

    const opts = capturedOptions();
    assert.ok(opts !== undefined, "tls.connect should have been called");
    assert.strictEqual(
      (opts as { rejectUnauthorized?: boolean }).rejectUnauthorized,
      false,
      "rejectUnauthorized must be false when allowSelfSigned=true — " +
        "home-lab users with self-signed certs need verification bypassed",
    );
  } finally {
    restore();
  }
});

// ── Test 4: no TLS → tls.connect is never called ─────────────────────────────

test("ElectrumClient does not call tls.connect when useTls is false", async () => {
  const { capturedOptions, restore: restoreTls } = stubTlsConnect();
  const { restore: restoreNet } = stubNetConnect();

  try {
    const client = new ElectrumClient(
      "127.0.0.1",
      50001,
      /* useTls */ false,
      /* reconnectDelayMs */ 60_000,
      /* allowSelfSigned */ true,
    );

    await client.connect().catch(() => {});
    client.destroy();

    assert.strictEqual(
      capturedOptions(),
      undefined,
      "tls.connect must not be called when useTls=false — " +
        "plain TCP connections must never go through the TLS code path",
    );
  } finally {
    restoreTls();
    restoreNet();
  }
});
