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

// A second distinct txid used in the multi-tx-same-block test
const TEST_TXID_2 = "dd".repeat(32);

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

// ── Second address — cross-address alert test ─────────────────────────────────
// Uses witness program byte 0x03 so its scripthash doesn't collide with the
// primary address (0x02) or the monitor-reconnect test (0x01).
const WITNESS_PROGRAM_HEX_2 = "0000000000000000000000000000000000000003";
const OUTPUT_SCRIPT_HEX_2 = "0014" + WITNESS_PROGRAM_HEX_2;
const TEST_SCRIPTHASH_2 = scriptToScripthash(OUTPUT_SCRIPT_HEX_2);

const TEST_ADDR_ID_2 = `loop-test-addr2-${crypto.randomUUID()}`;
const TEST_ADDRESS_LABEL_2 = "Test Loop Address 2";

// Unique txid for the second address — must never collide with TEST_TXID or TEST_TXID_2
const TEST_TXID_ADDR2 = "ee".repeat(32);

// Minimal raw transaction paying 30 000 sats to OUTPUT_SCRIPT_HEX_2
const RAW_TX_HEX_2 =
  "01000000" +
  "01" +
  "0".repeat(64) +
  "ffffffff" +
  "01" + "00" +
  "ffffffff" +
  "01" +
  "30750000000000" + "00" +
  "16" +
  OUTPUT_SCRIPT_HEX_2 +
  "00000000";

// ── Mock Electrum TCP server ──────────────────────────────────────────────────

// History is pre-seeded so the subscribe response is immediately non-null.
const mockHistory: Array<{ tx_hash: string; height: number }> = [
  { tx_hash: TEST_TXID, height: 800_000 },
];

// Per-scripthash history overrides — populated by individual tests that need
// a different history for a specific scripthash. Falls back to mockHistory when
// the scripthash is not found in the map, preserving backward compat.
const mockHistoryByScripthash = new Map<string, Array<{ tx_hash: string; height: number }>>();

// Per-txid raw transaction overrides — populated by tests that need a specific
// raw tx for a given txid. Falls back to RAW_TX_HEX for unrecognised txids.
const mockRawTxByTxid = new Map<string, string>();

// When true, the mock server pushes a blockchain.scripthash.subscribe notification
// for TEST_SCRIPTHASH the instant it answers the subscribe RPC. This reproduces the
// subscribe-response vs. push-notification race inside subscribeAllAddresses, where
// both paths call processScripthashHistory concurrently for the same initial tx.
let pushNotifyAfterSubscribe = false;

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
  const { id, method, params } = msg;
  switch (method) {
    case "server.ping":
      respond(socket, id, null);
      break;
    case "blockchain.headers.subscribe":
      respond(socket, id, { height: 800_001 });
      break;
    case "blockchain.scripthash.subscribe":
      // Return non-null only for our test scripthash; other addresses have no history.
      respond(socket, id, params[0] === TEST_SCRIPTHASH ? "status-hash-loop-v1" : null);
      // Race reproduction: push a notification for the same scripthash immediately
      // after the subscribe response so the notification handler fires while the
      // subscribe-response path is still in flight — both then call
      // processScripthashHistory concurrently for the same initial tx.
      if (pushNotifyAfterSubscribe && params[0] === TEST_SCRIPTHASH) {
        socket.write(
          JSON.stringify({
            method: "blockchain.scripthash.subscribe",
            params: [TEST_SCRIPTHASH, "status-hash-loop-v1"],
          }) + "\n",
        );
      }
      break;
    case "blockchain.scripthash.get_history": {
      const scripthash = (params as string[])[0];
      // Per-scripthash override wins; unknown scripthashes get [] to prevent
      // spurious alerts from unrelated watched addresses in the DB.
      const history = mockHistoryByScripthash.get(scripthash) ?? (scripthash === TEST_SCRIPTHASH ? mockHistory : []);
      respond(socket, id, history);
      break;
    }
    case "blockchain.transaction.get": {
      const txid = (params as string[])[0];
      const rawTx = mockRawTxByTxid.get(txid) ?? RAW_TX_HEX;
      respond(socket, id, rawTx);
      break;
    }
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
      watchMode: "all",
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

test("concurrent processScripthashHistory calls produce exactly one alert_events row and one alert send", async () => {
  const client = getElectrumClient();
  assert.ok(client !== null, "ElectrumClient must be active for this test");

  // Start from a clean slate — no existing row for this txid.
  // This simulates the race window where both concurrent calls execute the
  // SELECT and find nothing, then both attempt the INSERT concurrently.
  await db
    .delete(alertEvents)
    .where(and(eq(alertEvents.addressId, TEST_ADDR_ID), eq(alertEvents.txid, TEST_TXID)));

  // Reset the module-level counter so only the two calls below are counted.
  // sendTransactionAlert increments _alertSendAttempts at its very first line,
  // before any XMPP connectivity check, so the count is reliable in test environments
  // where XMPP is not configured.
  _resetAlertSendAttempts();

  // Fire two history-processing calls for the same scripthash at the same instant.
  // Both will reach the SELECT → find-nothing → INSERT path concurrently.
  // Deduplication is guaranteed by two cooperating mechanisms:
  //   1. The unique index  alert_events_address_id_txid_idx  on (address_id, txid)
  //      in lib/db/src/schema/activity.ts — the DB itself enforces uniqueness.
  //   2. .onConflictDoNothing().returning()  in processNewTx — the INSERT that
  //      loses the race returns an empty array, and processNewTx returns early
  //      without calling sendTransactionAlert.
  // Together they ensure exactly one row is persisted and exactly one alert fires.
  await Promise.all([
    processScripthashHistory(TEST_SCRIPTHASH, client!),
    processScripthashHistory(TEST_SCRIPTHASH, client!),
  ]);

  // ── Assert: exactly one DB row ───────────────────────────────────────────────
  const [{ n }] = await db
    .select({ n: count() })
    .from(alertEvents)
    .where(and(eq(alertEvents.addressId, TEST_ADDR_ID), eq(alertEvents.txid, TEST_TXID)));

  assert.equal(
    n,
    1,
    `Expected exactly 1 alert_events row after two concurrent processScripthashHistory calls, ` +
      `but found ${n}. The unique index (alert_events_address_id_txid_idx) or ` +
      `onConflictDoNothing() in processNewTx may not be active.`,
  );

  // ── Assert: exactly one alert send attempt ───────────────────────────────────
  const alertSendCount = _getAlertSendAttempts();

  assert.equal(
    alertSendCount,
    1,
    `Expected exactly 1 alert send attempt after two concurrent processScripthashHistory calls ` +
      `on a brand-new txid, but sendTransactionAlert was called ${alertSendCount} time(s). ` +
      `The onConflictDoNothing().returning() guard in processNewTx may not be stopping the ` +
      `losing INSERT from sending a duplicate alert.`,
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

test("notification handler fires twice with same status — exactly one alert row and one send attempt", async () => {
  const client = getElectrumClient();
  assert.ok(client !== null, "ElectrumClient must be active for this test");

  // Remove any alert row from prior tests so this test starts clean.
  await db
    .delete(alertEvents)
    .where(and(eq(alertEvents.addressId, TEST_ADDR_ID), eq(alertEvents.txid, TEST_TXID)));

  // Reset the send-attempt counter so only the two notification-triggered calls below
  // are counted.  sendTransactionAlert increments _alertSendAttempts at its very first
  // line, before any XMPP check, so the count is reliable in test environments where
  // XMPP is not configured.
  _resetAlertSendAttempts();

  // Push two identical blockchain.scripthash.subscribe push notifications from the
  // server side in rapid succession.  This simulates the real-world scenario where a
  // quirky Electrum server (or a reconnect notification that overlaps a live push)
  // delivers the same (scripthash, status) pair twice.
  //
  // Each notification flows:
  //   TCP → ElectrumClient.handleMessage → notificationHandler → processScripthashHistory
  //
  // Deduplication is guaranteed by two cooperating mechanisms inside processNewTx:
  //   1. The unique index  alert_events_address_id_txid_idx  on (address_id, txid).
  //   2. .onConflictDoNothing().returning() — the INSERT that loses the race returns [],
  //      so processNewTx returns early without calling sendTransactionAlert.
  const notification =
    JSON.stringify({
      method: "blockchain.scripthash.subscribe",
      params: [TEST_SCRIPTHASH, "status-hash-loop-v1"],
    }) + "\n";

  // Write both notifications through a single server-side socket so they arrive
  // back-to-back (same event-loop tick on the client), maximising the race window.
  let pushed = false;
  for (const socket of activeClientSockets) {
    socket.write(notification);
    socket.write(notification);
    pushed = true;
    break;
  }
  assert.ok(pushed, "Expected at least one active server socket to push notifications through");

  // Allow both concurrent processScripthashHistory calls to complete.
  await sleep(500);

  // ── Assert: exactly one DB row ───────────────────────────────────────────────
  const [{ n }] = await db
    .select({ n: count() })
    .from(alertEvents)
    .where(and(eq(alertEvents.addressId, TEST_ADDR_ID), eq(alertEvents.txid, TEST_TXID)));

  assert.equal(
    n,
    1,
    `Expected exactly 1 alert_events row after the notification handler fired twice with ` +
      `the same (scripthash, status), but found ${n}. ` +
      `The unique index or onConflictDoNothing() guard in processNewTx may not be active.`,
  );

  // ── Assert: exactly one send attempt ─────────────────────────────────────────
  const alertSendCount = _getAlertSendAttempts();
  assert.equal(
    alertSendCount,
    1,
    `Expected exactly 1 alert send attempt when the notification handler fires twice with ` +
      `the same status, but sendTransactionAlert was called ${alertSendCount} time(s). ` +
      `The onConflictDoNothing().returning() guard in processNewTx may not be stopping ` +
      `the losing concurrent INSERT from sending a duplicate alert.`,
  );
});

test("processNewTx inserts alert row with amountSats=0 and direction='incoming' when getTransaction fails", async () => {
  const client = getElectrumClient();
  assert.ok(client !== null, "ElectrumClient must be active for this test");

  const DECODE_FAIL_TXID = "ee".repeat(32);

  // Delete any leftover row from a previous interrupted run
  await db
    .delete(alertEvents)
    .where(and(eq(alertEvents.addressId, TEST_ADDR_ID), eq(alertEvents.txid, DECODE_FAIL_TXID)));

  // Temporarily replace the shared mock history with only this one mempool tx so
  // getTransaction is called exactly once during processScripthashHistory.
  const savedHistory = mockHistory.splice(0, mockHistory.length);
  mockHistory.push({ tx_hash: DECODE_FAIL_TXID, height: 0 }); // height=0 → mempool

  // Patch getTransaction to throw on the first invocation only.
  const originalGetTx = (client as unknown as Record<string, unknown>).getTransaction as (txid: string) => Promise<string>;
  let getTransactionCallCount = 0;
  (client as unknown as Record<string, unknown>).getTransaction = async (txid: string): Promise<string> => {
    if (getTransactionCallCount++ === 0) {
      throw new Error("mock getTransaction failure for decode-race test");
    }
    return originalGetTx.call(client, txid);
  };

  _resetAlertSendAttempts();

  try {
    await processScripthashHistory(TEST_SCRIPTHASH, client!);
  } finally {
    // Restore mock history and the original getTransaction implementation
    mockHistory.splice(0, mockHistory.length, ...savedHistory);
    (client as unknown as Record<string, unknown>).getTransaction = originalGetTx;
  }

  // ── Assert: exactly one alert_events row was inserted ─────────────────────
  const [{ n }] = await db
    .select({ n: count() })
    .from(alertEvents)
    .where(and(eq(alertEvents.addressId, TEST_ADDR_ID), eq(alertEvents.txid, DECODE_FAIL_TXID)));

  assert.equal(
    n,
    1,
    `Expected exactly 1 alert_events row even when getTransaction throws, but found ${n}. ` +
      `processNewTx may be silently discarding the insert after a decode failure.`,
  );

  // ── Assert: exactly one alert send attempt ────────────────────────────────
  const sendCount = _getAlertSendAttempts();
  assert.equal(
    sendCount,
    1,
    `Expected _getAlertSendAttempts() === 1 even when getTransaction throws, but got ${sendCount}. ` +
      `The mempool alert is being silently skipped when the decode step fails.`,
  );

  // ── Assert: fallback values are persisted ─────────────────────────────────
  const [row] = await db
    .select({ amountSats: alertEvents.amountSats, direction: alertEvents.direction })
    .from(alertEvents)
    .where(and(eq(alertEvents.addressId, TEST_ADDR_ID), eq(alertEvents.txid, DECODE_FAIL_TXID)))
    .limit(1);

  assert.equal(
    row?.amountSats,
    0,
    `Expected amountSats=0 (fallback) when getTransaction fails, but got ${row?.amountSats}.`,
  );
  assert.equal(
    row?.direction,
    "incoming",
    `Expected direction='incoming' (fallback) when getTransaction fails, but got ${row?.direction}.`,
  );

  // Clean up the test row
  await db
    .delete(alertEvents)
    .where(and(eq(alertEvents.addressId, TEST_ADDR_ID), eq(alertEvents.txid, DECODE_FAIL_TXID)));
});

test("reconnect catch-up fires exactly one confirmed alert per txid when two txids are in the history", async () => {
  const client = getElectrumClient();
  assert.ok(client !== null, "ElectrumClient must be active for this test");

  // Remove all alert rows for this address so the catch-up sees both txids as new.
  await db
    .delete(alertEvents)
    .where(eq(alertEvents.addressId, TEST_ADDR_ID));

  // Extend the mock history with a second confirmed txid — both in the same block.
  // The mock server will return this two-entry history for every get_history call,
  // including the one triggered by catchUpAllAddresses after the reconnect.
  mockHistory.push({ tx_hash: TEST_TXID_2, height: 800_000 });

  // Reset the send-attempt counter so only catch-up calls are counted.
  _resetAlertSendAttempts();

  try {
    // Simulate a node outage — destroys all active sockets.
    // The ElectrumClient will auto-reconnect (50 ms delay) and emit "reconnected",
    // which triggers catchUpAllAddresses → processScripthashHistory for each watched address.
    simulateOutage();

    // Wait for the client to reconnect and the catch-up to settle.
    const reconnected = await waitUntilConnected(4_000);
    assert.ok(reconnected, "Monitor should reconnect after the simulated outage");

    // Give catchUpAllAddresses enough time to finish processing both history entries.
    await sleep(500);
  } finally {
    // Always restore the original single-entry history so later tests or reconnects
    // see only TEST_TXID.
    mockHistory.pop();
  }

  // ── Assert: exactly two rows, one per txid ───────────────────────────────
  const [{ n: totalRows }] = await db
    .select({ n: count() })
    .from(alertEvents)
    .where(eq(alertEvents.addressId, TEST_ADDR_ID));

  assert.equal(
    totalRows,
    2,
    `Expected exactly 2 alert_events rows after reconnect catch-up with a two-entry history, ` +
      `but found ${totalRows}. catchUpAllAddresses may be skipping or merging entries.`,
  );

  for (const txid of [TEST_TXID, TEST_TXID_2]) {
    const [{ n }] = await db
      .select({ n: count() })
      .from(alertEvents)
      .where(and(eq(alertEvents.addressId, TEST_ADDR_ID), eq(alertEvents.txid, txid)));
    assert.equal(
      n,
      1,
      `Expected exactly 1 alert_events row for txid ${txid.slice(0, 8)}… after reconnect catch-up, but found ${n}.`,
    );
  }

  // ── Assert: exactly two send attempts, one per txid ─────────────────────
  const sendCount = _getAlertSendAttempts();
  assert.equal(
    sendCount,
    2,
    `Expected _getAlertSendAttempts() === 2 after reconnect catch-up with two new confirmed txids, ` +
      `but got ${sendCount}. One or more per-txid alert sends were skipped or doubled in catchUpAllAddresses.`,
  );
});

test("two distinct txids in the same history response each produce exactly one alert row and one send attempt", async () => {
  const client = getElectrumClient();
  assert.ok(client !== null, "ElectrumClient must be active for this test");

  // Clean up any alert rows left from previous tests so we start fresh.
  await db
    .delete(alertEvents)
    .where(eq(alertEvents.addressId, TEST_ADDR_ID));

  // Extend the shared mock history with a second confirmed transaction.
  // Both entries share the same height (same block) — this exercises the
  // outer for-loop in processScripthashHistory across multiple entries.
  mockHistory.push({ tx_hash: TEST_TXID_2, height: 800_000 });

  // Reset the send-attempt counter so only the calls below are counted.
  _resetAlertSendAttempts();

  try {
    // A single processScripthashHistory call must process both entries and
    // insert two distinct alert_events rows — one per txid.
    await processScripthashHistory(TEST_SCRIPTHASH, client!);
  } finally {
    // Always restore the original single-entry history so subsequent tests
    // (or reconnect-triggered catch-ups) are not affected.
    mockHistory.pop();
  }

  // ── Assert: exactly two rows, one per txid ───────────────────────────────
  const [{ n: totalRows }] = await db
    .select({ n: count() })
    .from(alertEvents)
    .where(eq(alertEvents.addressId, TEST_ADDR_ID));

  assert.equal(
    totalRows,
    2,
    `Expected exactly 2 alert_events rows (one per txid) after processing a ` +
      `two-entry history response, but found ${totalRows}. ` +
      `The per-entry deduplication loop may be skipping or merging entries.`,
  );

  // Verify each txid has its own distinct row.
  for (const txid of [TEST_TXID, TEST_TXID_2]) {
    const [{ n }] = await db
      .select({ n: count() })
      .from(alertEvents)
      .where(and(eq(alertEvents.addressId, TEST_ADDR_ID), eq(alertEvents.txid, txid)));
    assert.equal(
      n,
      1,
      `Expected exactly 1 alert_events row for txid ${txid.slice(0, 8)}… but found ${n}.`,
    );
  }

  // ── Assert: exactly two send attempts, one per txid ─────────────────────
  const sendCount = _getAlertSendAttempts();
  assert.equal(
    sendCount,
    2,
    `Expected _getAlertSendAttempts() === 2 after processing two new confirmed txids, ` +
      `but got ${sendCount}. One or more per-entry alert sends were skipped or doubled.`,
  );
});

test("two different watched addresses each receiving a transaction in the same block each produce exactly one alert row and one send attempt", async () => {
  const client = getElectrumClient();
  assert.ok(client !== null, "ElectrumClient must be active for this test");

  // ── Seed the second watched address ──────────────────────────────────────
  await db
    .insert(watchedAddresses)
    .values({
      id: TEST_ADDR_ID_2,
      label: TEST_ADDRESS_LABEL_2,
      address: `test-placeholder-${TEST_ADDR_ID_2}`,
      scripthash: TEST_SCRIPTHASH_2,
      watchMode: "all",
    })
    .onConflictDoNothing();

  // Clean up any leftover alert rows for both addresses from previous tests.
  await db.delete(alertEvents).where(eq(alertEvents.addressId, TEST_ADDR_ID));
  await db.delete(alertEvents).where(eq(alertEvents.addressId, TEST_ADDR_ID_2));

  // ── Configure per-scripthash histories ───────────────────────────────────
  // Each address has exactly one confirmed transaction in the same block (800_000).
  // The mock server will return the correct history for each scripthash query.
  mockHistoryByScripthash.set(TEST_SCRIPTHASH, [
    { tx_hash: TEST_TXID, height: 800_000 },
  ]);
  mockHistoryByScripthash.set(TEST_SCRIPTHASH_2, [
    { tx_hash: TEST_TXID_ADDR2, height: 800_000 },
  ]);

  // ── Configure per-txid raw transactions ──────────────────────────────────
  // Each txid maps to a raw tx whose output pays to the matching scripthash so
  // decodeRawTx classifies the transaction as "incoming" for the correct address.
  mockRawTxByTxid.set(TEST_TXID, RAW_TX_HEX);
  mockRawTxByTxid.set(TEST_TXID_ADDR2, RAW_TX_HEX_2);

  // Reset the alert-send counter so only the two calls below are counted.
  _resetAlertSendAttempts();

  // Captured inside the try block before cleanup, then asserted below.
  let rowCountAddr1 = 0;
  let rowCountAddr2 = 0;
  let sendCount = 0;

  try {
    // Process history for each address independently — one call per scripthash,
    // mirroring exactly what catchUpAllAddresses does when it iterates over the
    // address list after a reconnect.
    await processScripthashHistory(TEST_SCRIPTHASH, client!);
    await processScripthashHistory(TEST_SCRIPTHASH_2, client!);

    // Capture results before the finally block removes the rows.
    const [r1] = await db
      .select({ n: count() })
      .from(alertEvents)
      .where(and(eq(alertEvents.addressId, TEST_ADDR_ID), eq(alertEvents.txid, TEST_TXID)));
    rowCountAddr1 = r1?.n ?? 0;

    const [r2] = await db
      .select({ n: count() })
      .from(alertEvents)
      .where(and(eq(alertEvents.addressId, TEST_ADDR_ID_2), eq(alertEvents.txid, TEST_TXID_ADDR2)));
    rowCountAddr2 = r2?.n ?? 0;

    sendCount = _getAlertSendAttempts();
  } finally {
    // Always restore the mock-server maps so subsequent tests (or reconnect-triggered
    // catch-up calls) are not affected by this test's overrides.
    mockHistoryByScripthash.delete(TEST_SCRIPTHASH);
    mockHistoryByScripthash.delete(TEST_SCRIPTHASH_2);
    mockRawTxByTxid.delete(TEST_TXID);
    mockRawTxByTxid.delete(TEST_TXID_ADDR2);

    // Clean up the second address's DB rows regardless of test outcome.
    await db.delete(alertEvents).where(eq(alertEvents.addressId, TEST_ADDR_ID_2));
    await db.delete(watchedAddresses).where(eq(watchedAddresses.id, TEST_ADDR_ID_2));
  }

  // ── Assert: exactly one alert_events row for each address ─────────────────
  assert.equal(
    rowCountAddr1,
    1,
    `Expected exactly 1 alert_events row for address 1 (txid ${TEST_TXID.slice(0, 8)}…) ` +
      `but found ${rowCountAddr1}. The cross-address deduplication loop may be skipping or ` +
      `merging entries across different scripthash contexts.`,
  );

  assert.equal(
    rowCountAddr2,
    1,
    `Expected exactly 1 alert_events row for address 2 (txid ${TEST_TXID_ADDR2.slice(0, 8)}…) ` +
      `but found ${rowCountAddr2}. The cross-address deduplication loop may be skipping or ` +
      `merging entries across different scripthash contexts.`,
  );

  // ── Assert: exactly two send attempts, one per address ───────────────────
  assert.equal(
    sendCount,
    2,
    `Expected _getAlertSendAttempts() === 2 after processing one confirmed tx per address ` +
      `(two addresses total), but got ${sendCount}. An alert for one of the addresses ` +
      `may have been silently skipped or incorrectly duplicated.`,
  );
});

test("push notification racing the subscribe response for the same scripthash produces exactly one alert row and one send", async () => {
  // Start from a clean slate so both racing paths see the txid as new — this is
  // the window where each concurrent call runs SELECT → find-nothing → INSERT.
  await db
    .delete(alertEvents)
    .where(and(eq(alertEvents.addressId, TEST_ADDR_ID), eq(alertEvents.txid, TEST_TXID)));

  // Reset the counter so only the two racing processScripthashHistory calls below
  // are counted. sendTransactionAlert increments _alertSendAttempts at its very
  // first line, before any XMPP check, so the count is reliable even when XMPP is
  // not configured in the test environment.
  _resetAlertSendAttempts();

  // Arm the mock server to push a scripthash notification for TEST_SCRIPTHASH the
  // instant it answers the subscribe RPC. This recreates the real timing window in
  // subscribeAllAddresses: the subscribe-response path calls processScripthashHistory
  // while the notification handler (fired by the pushed notification) calls it too —
  // two concurrent calls for the same initial tx.
  //
  // Deduplication is guaranteed by two cooperating mechanisms inside processNewTx:
  //   1. The unique index  alert_events_address_id_txid_idx  on (address_id, txid).
  //   2. .onConflictDoNothing().returning() — the INSERT that loses the race returns [],
  //      so processNewTx returns early without calling sendTransactionAlert.
  pushNotifyAfterSubscribe = true;
  try {
    // A genuine fresh connect is required: the "connected" handler runs
    // subscribeAllAddresses (the subscribe-response path), whereas a reconnect only
    // runs catchUpAllAddresses. Destroy then re-init to get a clean "connected" event.
    destroyMonitor();
    await initMonitor();

    const connected = await waitUntilConnected();
    assert.ok(connected, "Monitor should connect to the mock server within 4 s");

    // Let both the subscribe-response and notification-triggered
    // processScripthashHistory calls fully settle.
    await sleep(500);
  } finally {
    pushNotifyAfterSubscribe = false;
  }

  // ── Assert: exactly one alert_events row ─────────────────────────────────────
  const [{ n }] = await db
    .select({ n: count() })
    .from(alertEvents)
    .where(and(eq(alertEvents.addressId, TEST_ADDR_ID), eq(alertEvents.txid, TEST_TXID)));

  assert.equal(
    n,
    1,
    `Expected exactly 1 alert_events row when a push notification races the subscribe ` +
      `response for the same scripthash, but found ${n}. The unique index ` +
      `(alert_events_address_id_txid_idx) or onConflictDoNothing() guard in processNewTx ` +
      `may not be active.`,
  );

  // ── Assert: exactly one alert send attempt ───────────────────────────────────
  const alertSendCount = _getAlertSendAttempts();
  assert.equal(
    alertSendCount,
    1,
    `Expected exactly 1 alert send attempt when the subscribe response and a push ` +
      `notification race for the same initial tx, but sendTransactionAlert was called ` +
      `${alertSendCount} time(s). The onConflictDoNothing().returning() guard in ` +
      `processNewTx may not be stopping the losing concurrent INSERT from sending a ` +
      `duplicate alert.`,
  );
});
