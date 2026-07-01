/**
 * Integration test: catchUpAllAddresses recovers cleanly when the socket dies
 * mid-iteration (after processing address #1 of 3).
 *
 * Flow:
 *  1. Start a mock Electrum TCP server (initially returns null subscribe status — no history).
 *  2. Seed 3 watched addresses + settings pointing to the mock server.
 *  3. Call initMonitor() → initial connection → subscribeAllAddresses → null status → no rows.
 *  4. Simulate an outage (destroy the socket).
 *  5. Inject history for all 3 addresses into the mock server.
 *  6. First reconnect (conn #2): "reconnected" fires → catchUpAllAddresses begins.
 *     The server responds to address #1's get_history normally, then destroys the socket.
 *     Addresses #2 and #3 receive errors (socket dead); their per-address catch blocks fire
 *     and the loop moves on. catchUpAllAddresses completes without throwing.
 *  7. The ElectrumClient auto-reconnects (conn #3). "reconnected" fires again →
 *     catchUpAllAddresses retries all 3 addresses. This time the server behaves normally.
 *  8. Assert: all 3 addresses eventually have alert_events rows.
 *     No address is permanently lost due to the mid-iteration failure.
 */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import net from "net";
import crypto from "crypto";
import { db, watchedAddresses, alertEvents, appSettings } from "@workspace/db";
import { eq, inArray } from "drizzle-orm";
import { initMonitor, destroyMonitor } from "../monitor.js";

// ── Scripthash helpers ────────────────────────────────────────────────────────

function scriptToScripthash(scriptHex: string): string {
  const script = Buffer.from(scriptHex, "hex");
  const hash = crypto.createHash("sha256").update(script).digest();
  return Buffer.from(hash).reverse().toString("hex");
}

// 3 distinct P2WPKH scripts — witness programs differ in the last byte (0xD0–0xD2).
// Chosen to be far from all other tests' addresses to avoid DB collisions.
const NUM_ADDRESSES = 3;

interface AddressFixture {
  id: string;
  label: string;
  address: string;
  scripthash: string;
  txid: string;
  rawTxHex: string;
}

function makeFixture(index: number): AddressFixture {
  const lastByte = (0xd0 + index).toString(16).padStart(2, "0");
  const witnessProgram = "00000000000000000000000000000000000000" + lastByte;
  const scriptHex = "0014" + witnessProgram;
  const scripthash = scriptToScripthash(scriptHex);
  const id = `catchup-mid-${index}-${crypto.randomUUID()}`;
  const label = `Catchup Mid-Interrupt Address ${index}`;
  const address = `catchup-mid-placeholder-${id}`;

  // Unique txid per address: repeat (0xE0 + index) byte 32 times → 64 hex chars
  const txByte = (0xe0 + index).toString(16).padStart(2, "00");
  const txid = txByte.repeat(32);

  // Minimal legacy raw transaction paying 20_000 sats to this script.
  // value: 20_000 = 0x4E20 → LE uint64: 20 4e 00 00 00 00 00 00
  const rawTxHex =
    "01000000" +         // version: 1 (LE)
    "01" +               // 1 input
    "00".repeat(32) +    // prevhash: 32 zero bytes
    "ffffffff" +         // previndex
    "00" +               // input script length = 0
    "ffffffff" +         // sequence
    "01" +               // 1 output
    "204e000000000000" + // value: 20 000 sats (LE uint64)
    "16" +               // output script length: 22 bytes
    scriptHex +          // P2WPKH output script (22 bytes)
    "00000000";          // locktime

  return { id, label, address, scripthash, txid, rawTxHex };
}

const FIXTURES: AddressFixture[] = Array.from({ length: NUM_ADDRESSES }, (_, i) => makeFixture(i));

// ── Mock Electrum TCP server ──────────────────────────────────────────────────

let mockServer!: net.Server;
let serverPort!: number;
const activeClientSockets = new Set<net.Socket>();

/**
 * History served by the mock server. Empty at start; populated after the first
 * outage to simulate transactions that arrived while offline.
 */
let mockHistory: Map<string, Array<{ tx_hash: string; height: number }>> = new Map();

/**
 * Number of TCP connections the server has accepted.
 * Connection #1 = initial connect (no history).
 * Connection #2 = first reconnect (history present; server kills socket after 1st get_history).
 * Connection #3+ = subsequent reconnects (normal behaviour).
 */
let connectionCount = 0;

function respond(socket: net.Socket, id: number, result: unknown): void {
  socket.write(JSON.stringify({ id, result }) + "\n");
}

function startMockServer(): Promise<void> {
  return new Promise((resolve) => {
    mockServer = net.createServer((socket) => {
      connectionCount++;
      const thisConn = connectionCount;

      activeClientSockets.add(socket);
      socket.on("close", () => activeClientSockets.delete(socket));
      socket.on("error", () => {});

      // Count get_history calls on this connection (used for mid-iteration sabotage).
      let getHistoryCount = 0;

      let buf = "";
      socket.on("data", (chunk: Buffer) => {
        buf += chunk.toString();
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const msg = JSON.parse(line) as {
              id: number;
              method: string;
              params: unknown[];
            };
            handleRequest(socket, msg, thisConn, () => ++getHistoryCount);
          } catch {
            // Ignore malformed JSON
          }
        }
      });
    });

    mockServer.listen(0, "127.0.0.1", () => {
      const addr = mockServer.address() as net.AddressInfo;
      serverPort = addr.port;
      resolve();
    });
  });
}

function handleRequest(
  socket: net.Socket,
  msg: { id: number; method: string; params: unknown[] },
  connectionNumber: number,
  incrementGetHistoryCount: () => number,
): void {
  const { id, method, params } = msg;

  switch (method) {
    case "server.ping":
      respond(socket, id, null);
      break;

    case "blockchain.headers.subscribe":
      // Chain tip 800_001: a tx at height 800_000 has 2 confirmations ≥ threshold 1.
      respond(socket, id, { height: 800_001 });
      break;

    case "blockchain.scripthash.subscribe":
      // Return non-null status only when history has been injected (after the outage).
      respond(socket, id, mockHistory.size > 0 ? "status-mid-interrupt-v1" : null);
      break;

    case "blockchain.scripthash.get_history": {
      const scripthash = (params as string[])[0];
      const history = mockHistory.get(scripthash!) ?? [];

      // Always respond first so the client receives the data.
      respond(socket, id, history);

      // On connection #2 (first reconnect), destroy the socket after serving
      // the FIRST get_history response. This simulates the socket dying mid-iteration
      // while catchUpAllAddresses is processing address #1 of 3.
      if (connectionNumber === 2) {
        const callIndex = incrementGetHistoryCount();
        if (callIndex === 1) {
          // Flush the response before killing the connection.
          setImmediate(() => {
            if (!socket.destroyed) {
              socket.destroy();
            }
          });
        }
      }
      break;
    }

    case "blockchain.transaction.get": {
      const txid = (params as string[])[0];
      const fixture = FIXTURES.find((f) => f.txid === txid);
      respond(socket, id, fixture ? fixture.rawTxHex : null);
      break;
    }

    default:
      respond(socket, id, null);
  }
}

/** Forcibly close every active client socket to simulate a node outage. */
function simulateOutage(): void {
  for (const socket of activeClientSockets) {
    socket.destroy();
  }
}

// ── Database helpers ──────────────────────────────────────────────────────────

let savedSettings: typeof appSettings.$inferSelect | null = null;

async function seedTestData(): Promise<void> {
  const [existing] = await db.select().from(appSettings).limit(1);
  savedSettings = existing ?? null;

  await db
    .insert(appSettings)
    .values({
      id: 1,
      electrumHost: "127.0.0.1",
      electrumPort: serverPort,
      electrumTls: false,
      confirmationThreshold: 1,
    })
    .onConflictDoUpdate({
      target: appSettings.id,
      set: {
        electrumHost: "127.0.0.1",
        electrumPort: serverPort,
        electrumTls: false,
        confirmationThreshold: 1,
      },
    });

  for (const f of FIXTURES) {
    await db
      .insert(watchedAddresses)
      .values({
        id: f.id,
        label: f.label,
        address: f.address,
        scripthash: f.scripthash,
        watchMode: "all",
      })
      .onConflictDoNothing();
  }
}

async function cleanupTestData(): Promise<void> {
  const ids = FIXTURES.map((f) => f.id);
  await db.delete(alertEvents).where(inArray(alertEvents.addressId, ids));
  await db.delete(watchedAddresses).where(inArray(watchedAddresses.id, ids));

  if (savedSettings) {
    await db
      .update(appSettings)
      .set({
        electrumHost: savedSettings.electrumHost,
        electrumPort: savedSettings.electrumPort,
        electrumTls: savedSettings.electrumTls,
        confirmationThreshold: savedSettings.confirmationThreshold,
      })
      .where(eq(appSettings.id, 1));
  } else {
    await db.delete(appSettings).where(eq(appSettings.id, 1));
  }
}

// ── Polling helpers ───────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitForAllAlerts(timeoutMs = 10_000): Promise<Map<string, number>> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const counts = new Map<string, number>();
    let allFound = true;
    for (const f of FIXTURES) {
      const rows = await db
        .select()
        .from(alertEvents)
        .where(eq(alertEvents.addressId, f.id));
      counts.set(f.id, rows.length);
      if (rows.length === 0) allFound = false;
    }
    if (allFound) return counts;
    await sleep(150);
  }
  // Return whatever we have so the caller can include it in assertion messages.
  const counts = new Map<string, number>();
  for (const f of FIXTURES) {
    const rows = await db
      .select()
      .from(alertEvents)
      .where(eq(alertEvents.addressId, f.id));
    counts.set(f.id, rows.length);
  }
  return counts;
}

// ── Lifecycle hooks ───────────────────────────────────────────────────────────

before(async () => {
  // Short reconnect delay keeps the test fast while still allowing distinct connection cycles.
  process.env.ELECTRUM_RECONNECT_DELAY_MS = "100";
  await startMockServer();
  await seedTestData();
});

after(async () => {
  destroyMonitor();
  await new Promise<void>((r) => mockServer.close(() => r()));
  await cleanupTestData();
  delete process.env.ELECTRUM_RECONNECT_DELAY_MS;
});

// ── The test ──────────────────────────────────────────────────────────────────

test(
  "all 3 addresses get alert rows even when the socket dies after address #1 during catchUpAllAddresses",
  async () => {
    // ── Step 1: initial connect — no history, all subscribes return null ─────────
    await initMonitor();

    // Allow subscribeAllAddresses to finish (all null → no rows created).
    await sleep(400);

    // Confirm no alert rows exist before the outage.
    for (const f of FIXTURES) {
      const rows = await db
        .select()
        .from(alertEvents)
        .where(eq(alertEvents.addressId, f.id));
      assert.equal(
        rows.length,
        0,
        `No alert_events row should exist for "${f.label}" before the outage`,
      );
    }

    // ── Step 2: simulate outage and inject history for all 3 addresses ───────────
    // After this, the mock server will:
    //   - Return non-null subscribe status (history exists)
    //   - Serve history for each scripthash via get_history
    simulateOutage();

    // Inject history for all 3 addresses (confirmed tx, height 800_000)
    for (const f of FIXTURES) {
      mockHistory.set(f.scripthash, [{ tx_hash: f.txid, height: 800_000 }]);
    }

    // ── Step 3: first reconnect (conn #2) — socket dies after address #1's get_history
    // The "reconnected" event fires → catchUpAllAddresses iterates all 3 addresses:
    //   - addr[0]: get_history succeeds, alert row inserted → then socket.destroy() fires
    //   - addr[1]: get_history throws (socket dead) → per-address catch in catchUpAllAddresses
    //   - addr[2]: get_history throws (socket dead) → per-address catch
    // catchUpAllAddresses completes the loop without propagating the error.
    // The ElectrumClient then reconnects automatically (second reconnect, conn #3).

    // ── Step 4: second reconnect (conn #3) — all 3 addresses retried ────────────
    // "reconnected" fires → catchUpAllAddresses runs again for all 3 addresses.
    // addr[0]: already in DB → deduplication (onConflictDoNothing) → no duplicate.
    // addr[1], addr[2]: first time successfully processed → alert rows inserted.

    // Wait for all 3 alert rows to appear (generous timeout to cover 2 reconnect cycles).
    const alertCounts = await waitForAllAlerts(10_000);

    // ── Step 5: assertions ───────────────────────────────────────────────────────
    for (const f of FIXTURES) {
      const count = alertCounts.get(f.id) ?? 0;
      assert.ok(
        count >= 1,
        `Expected at least 1 alert_events row for "${f.label}" (addressId: ${f.id}) ` +
          `after mid-iteration socket failure and subsequent reconnect, but found ${count}. ` +
          `This address was permanently lost when catchUpAllAddresses was interrupted mid-iteration.`,
      );
    }
  },
);
