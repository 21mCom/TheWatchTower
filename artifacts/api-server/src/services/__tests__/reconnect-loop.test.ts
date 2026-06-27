/**
 * Integration test: subscriptions and alert_events survive rapid disconnect-reconnect loops.
 *
 * Flow:
 *  1. Start a mock Electrum TCP server with a transaction already in history (non-null status).
 *  2. Seed the DB with one watched address and settings pointing to the mock server.
 *  3. Call initMonitor() → client connects, subscribes, sees non-null status → inserts 1 alert row.
 *  4. Loop 3 times:
 *     a. Destroy all active client sockets (simulate a rapid node flap).
 *     b. Wait for the ElectrumClient to auto-reconnect (configured to 50 ms in this test).
 *     c. Allow catch-up processing to settle.
 *  5. Assertions after all cycles:
 *     - Exactly one alert_events row exists for TEST_TXID (no duplicates from repeated processing).
 *     - The subscriptions Set inside ElectrumClient has exactly 1 entry (did not grow on each cycle).
 */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import net from "net";
import crypto from "crypto";
import { db, watchedAddresses, alertEvents, appSettings } from "@workspace/db";
import { eq, and, count } from "drizzle-orm";
import { initMonitor, destroyMonitor, getElectrumClient, processScripthashHistory, _getAlertSendAttempts, _resetAlertSendAttempts } from "../monitor.js";

// ── Scripthash helpers ────────────────────────────────────────────────────────

function scriptToScripthash(scriptHex: string): string {
  const script = Buffer.from(scriptHex, "hex");
  const hash = crypto.createHash("sha256").update(script).digest();
  return Buffer.from(hash).reverse().toString("hex");
}

// P2WPKH output script with a unique 20-byte program so this test's scripthash
// does not collide with the monitor-reconnect test's scripthash.
const WITNESS_PROGRAM_HEX = "0000000000000000000000000000000000000002";
const OUTPUT_SCRIPT_HEX = "0014" + WITNESS_PROGRAM_HEX;
const TEST_SCRIPTHASH = scriptToScripthash(OUTPUT_SCRIPT_HEX);

const TEST_ADDR_ID = `loop-test-${crypto.randomUUID()}`;
const TEST_ADDRESS_LABEL = "Test Loop Address";

// A unique fake txid for this test
const TEST_TXID = "cc".repeat(32);

// Minimal raw transaction paying 50 000 sats to OUTPUT_SCRIPT_HEX (same layout as
// the monitor-reconnect test — only the witness program byte at the end differs).
const RAW_TX_HEX =
  "01000000" +
  "01" +
  "0".repeat(64) +
  "ffffffff" +
  "01" + "00" +
  "ffffffff" +
  "01" +
  "50c3000000000000" +
  "16" +
  OUTPUT_SCRIPT_HEX +
  "00000000";

// ── Mock Electrum TCP server ──────────────────────────────────────────────────

// History is pre-seeded so the subscribe response is immediately non-null.
const mockHistory: Array<{ tx_hash: string; height: number }> = [
  { tx_hash: TEST_TXID, height: 800_000 },
];

let mockServer!: net.Server;
let serverPort!: number;
const activeClientSockets = new Set<net.Socket>();

function respond(socket: net.Socket, id: number, result: unknown): void {
  socket.write(JSON.stringify({ id, result }) + "\n");
}

function handleRequest(
  socket: net.Socket,
  msg: { id: number; method: string; params: unknown[] },
): void {
  const { id, method } = msg;
  switch (method) {
    case "server.ping":
      respond(socket, id, null);
      break;
    case "blockchain.headers.subscribe":
      respond(socket, id, { height: 800_001 });
      break;
    case "blockchain.scripthash.subscribe":
      // Always return non-null (history exists from the start)
      respond(socket, id, "status-hash-loop-v1");
      break;
    case "blockchain.scripthash.get_history":
      respond(socket, id, mockHistory);
      break;
    case "blockchain.transaction.get":
      respond(socket, id, RAW_TX_HEX);
      break;
    default:
      respond(socket, id, null);
  }
}

function startMockServer(): Promise<void> {
  return new Promise((resolve) => {
    mockServer = net.createServer((socket) => {
      activeClientSockets.add(socket);
      socket.on("close", () => activeClientSockets.delete(socket));
      socket.on("error", () => {});

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
            handleRequest(socket, msg);
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

  await db
    .insert(watchedAddresses)
    .values({
      id: TEST_ADDR_ID,
      label: TEST_ADDRESS_LABEL,
      address: `test-placeholder-${TEST_ADDR_ID}`,
      scripthash: TEST_SCRIPTHASH,
    })
    .onConflictDoNothing();
}

async function cleanupTestData(): Promise<void> {
  await db.delete(alertEvents).where(eq(alertEvents.addressId, TEST_ADDR_ID));
  await db.delete(watchedAddresses).where(eq(watchedAddresses.id, TEST_ADDR_ID));

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

async function waitUntilConnected(timeoutMs = 4_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const client = getElectrumClient();
    if (client?.connected) return true;
    await sleep(30);
  }
  return false;
}

// ── Lifecycle hooks ───────────────────────────────────────────────────────────

before(async () => {
  // 50 ms reconnect delay keeps the test fast while allowing distinct cycles
  process.env.ELECTRUM_RECONNECT_DELAY_MS = "50";
  await startMockServer();
  await seedTestData();
});

after(async () => {
  destroyMonitor();
  await new Promise<void>((resolve) => mockServer.close(() => resolve()));
  await cleanupTestData();
  delete process.env.ELECTRUM_RECONNECT_DELAY_MS;
});

// ── The test ──────────────────────────────────────────────────────────────────

test("subscriptions Set stays bounded and alert_events has no duplicates after 3 rapid reconnect cycles", async () => {
  // ── Step 1: initial connect ──────────────────────────────────────────────────
  await initMonitor();

  // Wait for the initial connection and history processing to settle
  const connected = await waitUntilConnected();
  assert.ok(connected, "Monitor should connect to mock server within 4 s");

  // Give subscribeAllAddresses time to process history and insert the alert row
  await sleep(500);

  // Verify the initial alert was created exactly once
  const [initialCount] = await db
    .select({ n: count() })
    .from(alertEvents)
    .where(and(eq(alertEvents.addressId, TEST_ADDR_ID), eq(alertEvents.txid, TEST_TXID)));
  assert.equal(
    initialCount?.n,
    1,
    "Exactly one alert_events row should exist after initial connection",
  );

  // ── Step 2: 3 rapid disconnect-reconnect cycles ──────────────────────────────
  const CYCLES = 3;
  for (let cycle = 1; cycle <= CYCLES; cycle++) {
    // Destroy all active sockets — triggers 'close' on the ElectrumClient
    simulateOutage();

    // Wait for the ElectrumClient to reconnect (50 ms delay + connection time)
    // and for catch-up processing to settle
    const reconnected = await waitUntilConnected(4_000);
    assert.ok(reconnected, `Should reconnect after cycle ${cycle}`);

    // Allow processScripthashHistory / catchUpAllAddresses to finish
    await sleep(300);
  }

  // ── Step 3: assert no duplicate alert_events rows ────────────────────────────
  const [finalCount] = await db
    .select({ n: count() })
    .from(alertEvents)
    .where(and(eq(alertEvents.addressId, TEST_ADDR_ID), eq(alertEvents.txid, TEST_TXID)));

  assert.equal(
    finalCount?.n,
    1,
    `Expected exactly 1 alert_events row for TEST_TXID after ${CYCLES} reconnect cycles, ` +
      `but found ${finalCount?.n}. Deduplication in processScripthashHistory may be broken.`,
  );

  // ── Step 4: assert subscriptions Set did not grow ────────────────────────────
  const client = getElectrumClient();
  assert.ok(client !== null, "ElectrumClient should still exist after reconnect cycles");

  // The Set should have exactly as many entries as there are watched addresses in the DB —
  // repeated reconnects must not add duplicates for the same scripthash.
  const [{ n: addressCount }] = await db.select({ n: count() }).from(watchedAddresses);
  assert.equal(
    client!.subscriptionCount,
    addressCount,
    `Expected subscriptions Set size to equal the number of watched addresses (${addressCount}) ` +
      `after ${CYCLES} reconnect cycles, but got ${client!.subscriptionCount}. ` +
      `The Set is growing unboundedly across cycles.`,
  );
});

test("concurrent processScripthashHistory calls produce exactly one alert_events row", async () => {
  const client = getElectrumClient();
  assert.ok(client !== null, "ElectrumClient must be active for this test");

  // Remove the row that the previous test inserted so we start from a clean state.
  await db
    .delete(alertEvents)
    .where(and(eq(alertEvents.addressId, TEST_ADDR_ID), eq(alertEvents.txid, TEST_TXID)));

  // Fire two history-processing calls for the same scripthash at the same instant.
  // Both will reach the SELECT-then-INSERT path concurrently and both will attempt to insert.
  // The unique constraint on (address_id, txid) plus onConflictDoNothing() must guarantee
  // that only one row lands in the table.
  await Promise.all([
    processScripthashHistory(TEST_SCRIPTHASH, client!),
    processScripthashHistory(TEST_SCRIPTHASH, client!),
  ]);

  const [{ n }] = await db
    .select({ n: count() })
    .from(alertEvents)
    .where(and(eq(alertEvents.addressId, TEST_ADDR_ID), eq(alertEvents.txid, TEST_TXID)));

  assert.equal(
    n,
    1,
    `Expected exactly 1 alert_events row after two concurrent processScripthashHistory calls, ` +
      `but found ${n}. The unique constraint or onConflictDoNothing() may not be active.`,
  );
});

test("concurrent processScripthashHistory calls on a mempool tx produce exactly one confirmed-alert send", async () => {
  const client = getElectrumClient();
  assert.ok(client !== null, "ElectrumClient must be active for this test");

  // Seed the alert_events row in "mempool" status so both concurrent calls hit the
  // mempool→confirmed upgrade branch (not the new-tx insert path).
  // Delete any leftover row from a prior test first, then do a clean insert.
  await db
    .delete(alertEvents)
    .where(and(eq(alertEvents.addressId, TEST_ADDR_ID), eq(alertEvents.txid, TEST_TXID)));

  await db.insert(alertEvents).values({
    id: crypto.randomUUID(),
    addressId: TEST_ADDR_ID,
    txid: TEST_TXID,
    direction: "incoming",
    amountSats: 50_000,
    status: "mempool",
    blockHeight: null,
    mempoolAlertedAt: new Date(),
    confirmedAlertedAt: null,
  });

  // Sanity-check: the row must be in mempool state before the concurrent calls.
  // If it's already confirmed a background reconnect-triggered catch-up upgraded it
  // before we installed the spy — the sleep below gives it time to settle first.
  let [preCheck] = await db
    .select({ status: alertEvents.status })
    .from(alertEvents)
    .where(and(eq(alertEvents.addressId, TEST_ADDR_ID), eq(alertEvents.txid, TEST_TXID)))
    .limit(1);

  if (preCheck?.status === "confirmed") {
    // A background processScripthashHistory (from the previous reconnect cycle) beat us.
    // Reset to mempool so the spy-guarded concurrent calls can do the upgrade.
    await db
      .update(alertEvents)
      .set({ status: "mempool", blockHeight: null, confirmedAlertedAt: null })
      .where(and(eq(alertEvents.addressId, TEST_ADDR_ID), eq(alertEvents.txid, TEST_TXID)));

    [preCheck] = await db
      .select({ status: alertEvents.status })
      .from(alertEvents)
      .where(and(eq(alertEvents.addressId, TEST_ADDR_ID), eq(alertEvents.txid, TEST_TXID)))
      .limit(1);
  }

  assert.equal(
    preCheck?.status,
    "mempool",
    "alert_events row must be in mempool state before the concurrent upgrade test",
  );

  // Reset the module-level counter before the concurrent calls so only the
  // upgrade attempts below are counted.  The counter increments at the top of
  // sendTransactionAlert regardless of XMPP connectivity, making it reliable
  // even in test environments where the XMPP service is not configured.
  _resetAlertSendAttempts();

  // Fire two concurrent upgrade attempts for the same mempool tx.
  // The mock server returns height 800_000 (confirmed, 1 conf ≥ threshold 1),
  // so both calls will enter the mempool→confirmed branch.
  // Only one should win the guarded UPDATE; the other sees 0 rows returned and
  // skips sendTransactionAlert entirely.
  await Promise.all([
    processScripthashHistory(TEST_SCRIPTHASH, client!),
    processScripthashHistory(TEST_SCRIPTHASH, client!),
  ]);

  const alertSendCount = _getAlertSendAttempts();

  // The row must be confirmed after the race settles.
  const [row] = await db
    .select({ status: alertEvents.status, confirmedAlertedAt: alertEvents.confirmedAlertedAt })
    .from(alertEvents)
    .where(and(eq(alertEvents.addressId, TEST_ADDR_ID), eq(alertEvents.txid, TEST_TXID)))
    .limit(1);

  assert.equal(row?.status, "confirmed", "alert_events row should be in confirmed status after the concurrent upgrade");
  assert.ok(row?.confirmedAlertedAt != null, "confirmedAlertedAt should be set after the upgrade");

  assert.equal(
    alertSendCount,
    1,
    `Expected exactly 1 confirmed-alert send after two concurrent processScripthashHistory calls ` +
      `on a mempool tx, but sendTransactionAlert was called ${alertSendCount} time(s). ` +
      `The guarded UPDATE WHERE status='mempool' in the upgrade branch may not be working.`,
  );
});
