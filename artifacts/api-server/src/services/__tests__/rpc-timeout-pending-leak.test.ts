/**
 * Unit test: timed-out RPCs must not leave stale entries in the pending Map.
 *
 * Flow:
 *  1. Start a mock TCP server that accepts connections but never sends any response.
 *  2. Connect an ElectrumClient directly (bypassing the monitor) with a very short
 *     RPC timeout so the test finishes quickly.
 *  3. Fire a batch of concurrent ping() calls — all will time out.
 *  4. After all promises settle, assert client.pendingCount === 0.
 *  5. Also confirm destroy() does not throw when called with no pending entries.
 */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import net from "net";
import { ElectrumClient } from "../electrum.js";

let silentServer!: net.Server;
let serverPort!: number;

function startSilentServer(): Promise<void> {
  return new Promise((resolve) => {
    silentServer = net.createServer((socket) => {
      socket.on("error", () => {});
    });
    silentServer.listen(0, "127.0.0.1", () => {
      const addr = silentServer.address() as net.AddressInfo;
      serverPort = addr.port;
      resolve();
    });
  });
}

before(() => startSilentServer());

after(
  () =>
    new Promise<void>((resolve) => silentServer.close(() => resolve())),
);

test("pending Map is empty after a batch of timed-out RPC calls", async () => {
  process.env.ELECTRUM_RPC_TIMEOUT_MS = "80";

  const client = new ElectrumClient("127.0.0.1", serverPort, false);
  try {
    await client.connect();

    const CALLS = 10;
    const results = await Promise.allSettled(
      Array.from({ length: CALLS }, () => client.ping()),
    );

    const rejectedCount = results.filter((r) => r.status === "rejected").length;
    assert.equal(
      rejectedCount,
      CALLS,
      `Expected all ${CALLS} ping() calls to be rejected by the timeout, but ${CALLS - rejectedCount} resolved unexpectedly`,
    );

    assert.equal(
      client.pendingCount,
      0,
      `pending Map must be empty after all timeouts fired, but pendingCount === ${client.pendingCount}. ` +
        `Timed-out calls are leaking entries.`,
    );
  } finally {
    client.destroy();
    delete process.env.ELECTRUM_RPC_TIMEOUT_MS;
  }
});

test("destroy() is clean when pending Map is already empty after timeouts", async () => {
  process.env.ELECTRUM_RPC_TIMEOUT_MS = "80";

  const client = new ElectrumClient("127.0.0.1", serverPort, false);
  try {
    await client.connect();

    await Promise.allSettled([client.ping(), client.ping(), client.ping()]);

    assert.equal(client.pendingCount, 0, "pending Map should already be empty before destroy()");

    assert.doesNotThrow(
      () => client.destroy(),
      "destroy() must not throw when called after all timeouts have already cleared the pending Map",
    );
  } finally {
    delete process.env.ELECTRUM_RPC_TIMEOUT_MS;
  }
});
