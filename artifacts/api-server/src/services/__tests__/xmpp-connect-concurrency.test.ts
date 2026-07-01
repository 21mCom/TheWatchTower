/**
 * Unit tests for XmppService's concurrent-connect guard.
 *
 * XmppService.connect() protects against two overlapping connection attempts
 * with a `connecting` flag: if a second connect() starts while the first is
 * still mid-flight (its underlying start() has not settled), the second throws
 * "An XMPP connection attempt is already in progress." The flag is reset in the
 * `finally` block so it is cleared whether the attempt succeeds OR fails, which
 * means a later connect() can always proceed once the in-flight one settles.
 *
 * These tests lock that behavior in so a regression can neither (a) allow two
 * overlapping start() calls, nor (b) leave `connecting` stuck true and
 * permanently block every future connect.
 *
 * Covered here:
 *   - A second connect() while the first is in flight rejects with the guard
 *     message and does not create a second underlying client.
 *   - After the in-flight attempt succeeds, the flag is cleared so a later
 *     connect() proceeds.
 *   - After the in-flight attempt fails, the flag is still cleared (finally) so
 *     a later connect() proceeds.
 *
 * No external network or database access: a fake client injected through the
 * overridable createClient seam exposes a controllable start() (a pending
 * promise the test resolves/rejects by hand) so the "mid-flight" window is
 * fully deterministic.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { client } from "@xmpp/client";

// A large connect timeout guarantees the held start() promise never times out
// while the test keeps the first attempt in flight; a large reconnect delay
// keeps any scheduled retry from firing mid-suite. Read once per XmppService
// construction, so set them before importing.
process.env.XMPP_CONNECT_TIMEOUT_MS = "300000";
process.env.XMPP_RECONNECT_DELAY_MS = "600000";

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
 * A fake @xmpp/client whose start() resolves immediately (modeling a successful
 * connect) by emitting `online`. Used for the "later connect proceeds" clients.
 */
class FakeXmppClient {
  handlers: Record<string, Array<(...args: unknown[]) => void>> = {};
  on(event: string, cb: (...args: unknown[]) => void) {
    (this.handlers[event] ??= []).push(cb);
  }
  emit(event: string, ...args: unknown[]) {
    for (const cb of this.handlers[event] ?? []) cb(...args);
  }
  async start() {
    this.emit("online");
  }
  async stop() {}
  async send() {}
  reconnect = { stop() {} };
}

/**
 * A fake whose start() returns a pending promise the test controls. This keeps
 * a connect() attempt "in flight" for as long as the test wants, so a second
 * concurrent connect() can be observed hitting the guard.
 */
class ControllableXmppClient extends FakeXmppClient {
  startCalled = false;
  private resolveStart!: () => void;
  private rejectStart!: (err: Error) => void;
  override start(): Promise<void> {
    this.startCalled = true;
    return new Promise<void>((resolve, reject) => {
      this.resolveStart = resolve;
      this.rejectStart = reject;
    });
  }
  /** Complete the in-flight start() as a successful connect. */
  succeed() {
    this.emit("online");
    this.resolveStart();
  }
  /** Complete the in-flight start() as a failed connect. */
  fail(err: Error) {
    this.rejectStart(err);
  }
}

/**
 * Build an XmppService whose createClient seam pulls fakes from the supplied
 * queue (falling back to an auto-resolving FakeXmppClient) and records every
 * fake it hands out.
 */
function makeService(queue: FakeXmppClient[]) {
  class TestXmpp extends XmppService {
    created: FakeXmppClient[] = [];
    protected override createClient(): ReturnType<typeof client> {
      const c = queue.shift() ?? new FakeXmppClient();
      this.created.push(c);
      return c as unknown as ReturnType<typeof client>;
    }
  }
  return new TestXmpp();
}

// ── concurrent-connect guard ──────────────────────────────────────────────────

test("a second connect() while the first is in flight rejects and creates no second client", async () => {
  const held = new ControllableXmppClient();
  const svc = makeService([held]);
  svc.configure({ ...baseConfig });
  const internal = svc as unknown as AnyRecord;

  // Kick off the first connect but do NOT let start() settle yet.
  const first = svc.connect();
  assert.equal(held.startCalled, true, "the first connect() must have invoked start()");
  assert.equal(
    internal.connecting,
    true,
    "the connecting flag must be set while a connect attempt is in flight",
  );
  assert.equal(internal.created.length, 1, "the first connect() creates exactly one client");

  // A second connect() while the first is mid-flight must reject with the guard
  // message — two overlapping start() calls are never allowed.
  await assert.rejects(
    () => svc.connect(),
    /An XMPP connection attempt is already in progress\./,
    "a concurrent connect() must reject with the in-progress guard message",
  );
  assert.equal(
    internal.created.length,
    1,
    "the rejected concurrent connect() must not create a second underlying client",
  );

  // Let the first attempt complete successfully, then clean up.
  held.succeed();
  await first;
  assert.equal(svc.isConnected(), true, "the first attempt must bring the session online");
  svc.disconnect();
});

test("after the in-flight attempt succeeds, the flag is cleared so a later connect() proceeds", async () => {
  const held = new ControllableXmppClient();
  const svc = makeService([held]);
  svc.configure({ ...baseConfig });
  const internal = svc as unknown as AnyRecord;

  const first = svc.connect();
  held.succeed();
  await first;
  assert.equal(
    internal.connecting,
    false,
    "the connecting flag must be cleared once the in-flight attempt settles",
  );

  // A later connect() must proceed (the guard was reset), creating a new client.
  await svc.connect();
  assert.equal(
    internal.created.length,
    2,
    "a later connect() must proceed and create a new client after the flag clears",
  );

  svc.disconnect();
});

test("the flag is cleared in finally even when the in-flight attempt fails, so a later connect() proceeds", async () => {
  const held = new ControllableXmppClient();
  const svc = makeService([held]);
  svc.configure({ ...baseConfig });
  const internal = svc as unknown as AnyRecord;

  // First attempt fails mid-flight (a generic transient error).
  const first = svc.connect();
  held.fail(new Error("connection reset"));
  await assert.rejects(() => first, "a failed start() must reject connect()");
  assert.equal(
    internal.connecting,
    false,
    "the connecting flag must be reset in the finally block even on failure",
  );

  // A later connect() must still be able to proceed — the guard is not stuck true.
  await svc.connect();
  assert.equal(
    internal.created.length,
    2,
    "a later connect() must proceed after a failed attempt cleared the flag",
  );

  svc.disconnect();
});
