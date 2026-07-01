/**
 * Unit test: destroy() must clear outstanding RPC timeout timers.
 *
 * Each rpc() call arms a setTimeout for the RPC timeout. If destroy() is called
 * while those timers are still running, the timers hold a reference that can
 * delay Node.js process exit and can fire a "reject on settled promise" warning
 * if the client is re-created. destroy() must clear every outstanding handle.
 *
 * Flow:
 *  1. Start a mock TCP server that accepts connections but never responds.
 *  2. Connect an ElectrumClient with a long RPC timeout so the timers stay armed.
 *  3. Fire a batch of concurrent ping() calls — all stay in-flight.
 *  4. Assert timers are armed (rpcTimeoutCount > 0), then call destroy() mid-flight.
 *  5. Assert rpcTimeoutCount === 0 and every ping() promise rejected.
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

test("destroy() clears all outstanding RPC timeout timers mid-flight", async () => {
  // Long timeout so the timers stay armed until we call destroy().
  process.env.ELECTRUM_RPC_TIMEOUT_MS = "60000";

  const client = new ElectrumClient("127.0.0.1", serverPort, false);
  try {
    await client.connect();

    const CALLS = 5;
    const inFlight = Array.from({ length: CALLS }, () => client.ping());

    // Give the microtask queue a tick so each rpc() has armed its timer.
    await new Promise((r) => setImmediate(r));

    assert.equal(
      client.rpcTimeoutCount,
      CALLS,
      `Expected ${CALLS} armed RPC timeout timers before destroy(), got ${client.rpcTimeoutCount}`,
    );

    // Attach rejection handlers before destroy() so the rejections are observed.
    const settled = Promise.allSettled(inFlight);

    client.destroy();

    assert.equal(
      client.rpcTimeoutCount,
      0,
      `destroy() must clear every outstanding RPC timeout timer, but rpcTimeoutCount === ${client.rpcTimeoutCount}`,
    );

    const results = await settled;
    const rejectedCount = results.filter((r) => r.status === "rejected").length;
    assert.equal(
      rejectedCount,
      CALLS,
      `Expected all ${CALLS} in-flight ping() calls to reject after destroy(), but ${CALLS - rejectedCount} did not`,
    );
  } finally {
    delete process.env.ELECTRUM_RPC_TIMEOUT_MS;
  }
});
