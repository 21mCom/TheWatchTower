/**
 * Unit tests for XmppService auto-reconnect after a dropped session.
 *
 * XmppService auto-reconnects when a *previously online* session drops: the
 * client's `offline` handler calls scheduleReconnect() only when `wasOnline` is
 * true and the service is not stopped. scheduleReconnect() is itself guarded so
 * overlapping failures can never stack multiple retry timers (the same class of
 * bug the Electrum reconnect-storm work fixed).
 *
 * These tests lock that behavior in so a future change cannot either fail to
 * reconnect after a drop or spawn multiple overlapping reconnect timers.
 *
 * Covered here:
 *   - An `offline` after being `online` schedules exactly one reconnect timer.
 *   - A second `offline` (drop) does not create a second overlapping timer.
 *   - An `offline` that was never `online` (failed initial connect) does not
 *     schedule a reconnect via the offline handler.
 *   - disconnect() clears the pending reconnect timer.
 *
 * No external network or database access: a fake client injected through the
 * overridable createClient seam captures the event handlers so the test can
 * drive `online` / `offline` deterministically. The reconnect delay is set very
 * long so no scheduled retry actually runs during the suite.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { client } from "@xmpp/client";

// A long reconnect delay guarantees no scheduled retry fires mid-suite, and a
// short connect timeout keeps any accidental hang bounded. Read once per
// XmppService construction, so set them before importing.
process.env.XMPP_RECONNECT_DELAY_MS = "600000";
process.env.XMPP_CONNECT_TIMEOUT_MS = "300";

const { XmppService } = await import("../xmpp.js");
import type { XmppConfig } from "../xmpp.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyRecord = Record<string, any>;

const baseConfig: XmppConfig = {
  server: "127.0.0.1",
  port: 5222,
  jid: "watchtower@example.com",
  password: "hunter2",
  tls: false,
  recipientJid: "owner@example.com",
};

/**
 * A fake @xmpp/client that captures registered event handlers so a test can
 * drive `online` / `offline` events by hand. start() emits `online` (modeling a
 * successful connect) and then resolves.
 */
class FakeXmppClient {
  handlers: Record<string, Array<(...args: unknown[]) => void>> = {};
  stopCalled = false;
  on(event: string, cb: (...args: unknown[]) => void) {
    (this.handlers[event] ??= []).push(cb);
  }
  emit(event: string, ...args: unknown[]) {
    for (const cb of this.handlers[event] ?? []) cb(...args);
  }
  async start() {
    this.emit("online");
  }
  async stop() {
    this.stopCalled = true;
  }
  async send() {}
  reconnect = { stop() {} };
}

/** A fake whose start() rejects with an auth error — connect never goes online. */
class AuthFailingXmppClient extends FakeXmppClient {
  override async start() {
    throw new Error("not-authorized");
  }
}

/**
 * Build an XmppService whose createClient seam returns the supplied fake and
 * records every fake it hands out (so the test can drive events on it).
 */
function makeService(factory: () => FakeXmppClient) {
  class TestXmpp extends XmppService {
    created: FakeXmppClient[] = [];
    protected override createClient(): ReturnType<typeof client> {
      const c = factory();
      this.created.push(c);
      return c as unknown as ReturnType<typeof client>;
    }
  }
  return new TestXmpp();
}

// ── reconnect after a dropped session ─────────────────────────────────────────

test("an offline after being online schedules exactly one reconnect timer (no stacking)", async () => {
  const svc = makeService(() => new FakeXmppClient());
  svc.configure({ ...baseConfig });
  const internal = svc as unknown as AnyRecord;

  await svc.connect();
  assert.equal(svc.isConnected(), true, "connect() must bring the session online.");
  assert.equal(
    internal.reconnectTimer,
    null,
    "A healthy, connected session must not have a pending reconnect timer.",
  );

  const fake = internal.created[0] as FakeXmppClient;

  // The session drops after having been online → schedule exactly one retry.
  fake.emit("offline");
  assert.notEqual(
    internal.reconnectTimer,
    null,
    "A drop of a previously-online session must schedule an automatic reconnect.",
  );
  const firstTimer = internal.reconnectTimer;

  // A second drop must NOT stack a second overlapping timer. Re-arm wasOnline so
  // the offline handler reaches scheduleReconnect() and its idempotency guard is
  // the thing being exercised (not the wasOnline gate).
  internal.wasOnline = true;
  fake.emit("offline");
  assert.strictEqual(
    internal.reconnectTimer,
    firstTimer,
    "A second drop must reuse the pending timer, never create a second overlapping one.",
  );

  svc.disconnect();
  assert.equal(
    internal.reconnectTimer,
    null,
    "disconnect() must clear the pending reconnect timer.",
  );
});

test("an offline that was never online (failed initial connect) does not schedule a reconnect", async () => {
  const svc = makeService(() => new AuthFailingXmppClient());
  svc.configure({ ...baseConfig });
  const internal = svc as unknown as AnyRecord;

  // Initial connect fails with a permanent auth error → connect() itself does
  // not schedule a retry, and the session was never online.
  await assert.rejects(() => svc.connect());
  assert.equal(svc.isConnected(), false, "A failed connect must not report connected.");
  assert.equal(
    internal.reconnectTimer,
    null,
    "A permanent auth failure must not schedule an auto-retry.",
  );

  // An `offline` event on a session that was never online must be a no-op: the
  // handler's `wasOnline` gate prevents a double/erroneous schedule.
  const fake = internal.created[0] as FakeXmppClient;
  fake.emit("offline");
  assert.equal(
    internal.reconnectTimer,
    null,
    "An offline for a never-online session must not schedule a reconnect.",
  );

  svc.disconnect();
});
