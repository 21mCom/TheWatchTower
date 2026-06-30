/**
 * Regression test: a permanently-unreachable Electrum server must NOT trigger a
 * reconnect "storm".
 *
 * The bug this guards against: ElectrumClient scheduled a reconnect timer from
 * three independent places on every failed attempt (the 'error' path via
 * settle(), the 'close' handler, and reconnect()'s catch). Because those timers
 * did not reliably cancel one another, each failed connection left more than one
 * timer pending — so the number of reconnect attempts DOUBLED every cycle and
 * grew exponentially. Within a minute it was thousands of attempts per second,
 * which saturated Node's event loop and prevented app.listen() from ever binding
 * the HTTP port (the server never logged "Server listening" and the port was
 * refused even though the container was "Up").
 *
 * The fix funnels all scheduling through one idempotent scheduleReconnect(): if
 * a reconnect is already pending it is a no-op, so at most ONE timer exists at a
 * time and attempts grow LINEARLY (one per reconnectDelayMs).
 *
 * This test points the client at a closed port (guaranteed ECONNREFUSED), lets
 * the reconnect loop run for a fixed window, and asserts the number of attempts
 * stayed within a linear bound. With the old bug the count would be in the
 * hundreds/thousands within the same window, failing the assertion.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import net from "net";
import { ElectrumClient } from "../electrum.js";

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// Bind a server on an ephemeral port, then immediately close it so the port is
// free. Connecting to it afterwards is guaranteed to be refused.
function getClosedPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address() as net.AddressInfo;
      srv.close(() => resolve(port));
    });
  });
}

test("permanently-unreachable Electrum server schedules at most one reconnect per cycle (no timer storm)", async () => {
  const deadPort = await getClosedPort();

  const RECONNECT_DELAY_MS = 25;
  const client = new ElectrumClient("127.0.0.1", deadPort, false, RECONNECT_DELAY_MS);

  // Each failed connection emits exactly one "error" event (the client only
  // emits when there is a listener), so counting these counts connect attempts.
  let attempts = 0;
  client.on("error", () => {
    attempts++;
  });

  // First attempt — fails and kicks off the reconnect loop.
  await client.connect().catch(() => {});

  // Run the loop for ~12 cycles' worth of wall-clock time.
  const CYCLES = 12;
  const WINDOW_MS = RECONNECT_DELAY_MS * CYCLES; // 300 ms
  await sleep(WINDOW_MS);

  client.destroy();
  // Let any socket error from the connection that was in flight at destroy()
  // time drain before we read the counter.
  await sleep(50);

  // Linear growth: ~ WINDOW/DELAY attempts plus the initial one, with head-room
  // for timing jitter. The old exponential bug would blow far past this.
  const linearUpperBound = CYCLES + 6; // ≈ 18
  assert.ok(
    attempts <= linearUpperBound,
    `Expected reconnect attempts to grow linearly (<= ${linearUpperBound}) over ${WINDOW_MS} ms, ` +
      `but observed ${attempts}. scheduleReconnect is stacking multiple timers per failure — ` +
      `the exponential reconnect storm that starved the event loop and stopped the HTTP ` +
      `server from binding its port has regressed.`,
  );

  // Sanity: the loop must actually be retrying (not silently dead).
  assert.ok(attempts >= 2, `Expected the reconnect loop to retry at least twice, got ${attempts}`);
});
