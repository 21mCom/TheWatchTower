/**
 * Integration test: mempool→confirmed upgrade does not fire a duplicate alert
 * when two concurrent processScripthashHistory calls race on the same transaction
 * after a reconnect.
 *
 * Race scenario:
 *  1. Start a mock Electrum TCP server that initially reports no history (null status).
 *  2. Seed the DB with a watched address, settings pointing to the mock server, and an
 *     existing "mempool" alert_events row for a transaction — simulating a prior
 *     unconfirmed alert that was stored before the node went offline.
 *  3. Call initMonitor(). Subscription returns null → subscribeAllAddresses skips
 *     processScripthashHistory. The mempool row stays untouched.
 *  4. Inject a confirmed history entry into the mock server (same txid, height > 0).
 *  5. Simulate outage — destroy the active client socket.
 *  6. ElectrumClient auto-reconnects (150 ms delay):
 *       a. Re-subscribes: server now returns non-null status → notification handler fires
 *          processScripthashHistory (path A) for the upgrade.
 *       b. Emits "reconnected" → catchUpAllAddresses → processScripthashHistory (path B).
 *  7. On the FIRST get_history request the mock server delays its response by 120 ms
 *     so path B's SELECT also runs before either UPDATE fires — creating a true race.
 *  8. Assertions:
 *       - At least two get_history calls happened (race was actually exercised).
 *       - The alert_events row ends up in "confirmed" state, count = 1.
 *       - The patched XMPP sendAlert is called exactly once for the confirmed transaction.
 *
 * The fix in processScripthashHistory (conditional WHERE status='mempool' + .returning())
 * ensures only the UPDATE that actually transitions the row wins; all concurrent attempts
 * that lose the race get 0 rows back and skip the alert.
 */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import net from "net";
import crypto from "crypto";
import { db, watchedAddresses, alertEvents, appSettings } from "@workspace/db";
import { eq, and, count } from "drizzle-orm";
import { initMonitor, destroyMonitor, getXmpp } from "../monitor.js";

// ── Scripthash helpers ────────────────────────────────────────────────────────

function scriptToScripthash(scriptHex: string): string {
  const script = Buffer.from(scriptHex, "hex");
  const hash = crypto.createHash("sha256").update(script).digest();
  return Buffer.from(hash).reverse().toString("hex");
}

// Unique 20-byte witness program — must not collide with other test files.
const WITNESS_PROGRAM_HEX = "0000000000000000000000000000000000000004";
const OUTPUT_SCRIPT_HEX = "0014" + WITNESS_PROGRAM_HEX;
const TEST_SCRIPTHASH = scriptToScripthash(OUTPUT_SCRIPT_HEX);

const TEST_ADDR_ID = `upgrade-test-${crypto.randomUUID()}`;
const TEST_ADDRESS_LABEL = "Test Upgrade Address";
const TEST_TXID = "ee".repeat(32); // unique 64-char hex

// Pre-seeded mempool row values — the upgrade path reuses these from the existing
// row, so no raw-transaction decode is needed on the reconnect path.
const SEEDED_AMOUNT_SATS = 45_000;
const SEEDED_DIRECTION = "incoming" as const;

// Confirmed block height the mock server will report for this tx.
// With chain tip 800_001 → confs = 800_001 − 800_000 + 1 = 2 ≥ threshold 1.
const TX_BLOCK_HEIGHT = 800_000;
const CHAIN_TIP_HEIGHT = 800_001;

// ── Mock Electrum TCP server ──────────────────────────────────────────────────

/**
 * History injected into the mock server after initial connect.
 * Empty initially → subscribe returns null → no upgrade during initial connect.
 * Populated before the outage → reconnect catch-up sees the confirmed tx.
 */
let mockHistory: Array<{ tx_hash: string; height: number }> = [];

let mockServer!: net.Server;
let serverPort!: number;
const activeClientSockets = new Set<net.Socket>();

/**
 * Counts get_history calls received across both concurrent paths.
 * Used to verify the race was actually exercised (both paths issued getHistory).
 */
let getHistoryCallCount = 0;

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
      respond(socket, id, { height: CHAIN_TIP_HEIGHT });
      break;

    case "blockchain.scripthash.subscribe":
      // Return null while mockHistory is empty (initial connect) so
      // subscribeAllAddresses skips processScripthashHistory.
      // After history is injected (reconnect), return non-null so the
      // notification handler fires the first concurrent upgrade path.
      respond(socket, id, mockHistory.length > 0 ? "status-upgrade-v1" : null);
      break;

    case "blockchain.scripthash.get_history": {
      getHistoryCallCount++;
      const callIndex = getHistoryCallCount;

      if (callIndex === 1) {
        // Delay the first response so the second concurrent path can issue its
        // own getHistory before either SELECT runs — creating a true race on the
        // mempool→confirmed UPDATE.
        setTimeout(() => {
          if (!socket.destroyed) respond(socket, id, mockHistory);
        }, 120);
      } else {
        respond(socket, id, mockHistory);
      }
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
            // ignore malformed JSON
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
      address: `test-placeholder-upgrade-${TEST_ADDR_ID}`,
      scripthash: TEST_SCRIPTHASH,
      watchMode: "all",
    })
    .onConflictDoNothing();

  // Pre-seed a "mempool" alert row — simulating a transaction that was seen
  // unconfirmed before the node went offline.
  // On reconnect, two concurrent processScripthashHistory calls must race to
  // upgrade this row to "confirmed". The fix ensures only one wins.
  await db
    .insert(alertEvents)
    .values({
      id: crypto.randomUUID(),
      addressId: TEST_ADDR_ID,
      txid: TEST_TXID,
      direction: SEEDED_DIRECTION,
      amountSats: SEEDED_AMOUNT_SATS,
      status: "mempool",
      blockHeight: null,
      mempoolAlertedAt: new Date(),
      confirmedAlertedAt: null,
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

// ── Helpers ───────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitForConfirmed(
  addressId: string,
  txid: string,
  timeoutMs = 8_000,
): Promise<typeof alertEvents.$inferSelect | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const [row] = await db
      .select()
      .from(alertEvents)
      .where(and(eq(alertEvents.addressId, addressId), eq(alertEvents.txid, txid)))
      .limit(1);
    if (row?.status === "confirmed") return row;
    await sleep(150);
  }
  return null;
}

// ── Lifecycle hooks ───────────────────────────────────────────────────────────

before(async () => {
  process.env.ELECTRUM_RECONNECT_DELAY_MS = "150";
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

test(
  "concurrent mempool→confirmed upgrades after reconnect produce exactly one confirmed row and one XMPP send",
  async () => {
    // Patch the module-level XMPP singleton before initMonitor() so
    // sendTransactionAlert reaches sendAlert instead of bailing out at the
    // isConfigured/isConnected guards.
    // Connection-status alerts ("Node connection restored." etc.) are sent via
    // sendConnectionAlert — a separate method — so they never reach this mock
    // and no txid filtering is needed here.
    const xmppSvc = getXmpp();
    let xmppSendCount = 0;
    const origIsConfigured = xmppSvc.isConfigured.bind(xmppSvc);
    const origIsConnected = xmppSvc.isConnected.bind(xmppSvc);
    const origSendAlert = xmppSvc.sendAlert.bind(xmppSvc);
    (xmppSvc as unknown as Record<string, unknown>).isConfigured = () => true;
    (xmppSvc as unknown as Record<string, unknown>).isConnected = () => true;
    (xmppSvc as unknown as Record<string, unknown>).sendAlert = async (_msg: string) => {
      xmppSendCount++;
    };

    try {
      // ── Step 1: initial connect (null status → no upgrade yet) ────────────
      await initMonitor();

      // Allow subscribeAllAddresses to complete. With null status, nothing
      // is inserted and the pre-seeded mempool row stays untouched.
      await sleep(400);

      const [before] = await db
        .select()
        .from(alertEvents)
        .where(eq(alertEvents.addressId, TEST_ADDR_ID))
        .limit(1);
      assert.equal(
        before?.status,
        "mempool",
        "Pre-seeded mempool row should still be 'mempool' before the outage",
      );

      // ── Step 2: inject confirmed history and simulate outage ──────────────
      // Set history before the outage so the reconnect catch-up finds the tx
      // as already confirmed (height > 0, meets threshold).
      mockHistory = [{ tx_hash: TEST_TXID, height: TX_BLOCK_HEIGHT }];
      getHistoryCallCount = 0; // reset before the reconnect race
      simulateOutage();

      // ── Step 3: wait for the upgrade to propagate ─────────────────────────
      // On reconnect the ElectrumClient:
      //   a) Re-subscribes → mock returns non-null → notification handler fires
      //      processScripthashHistory (path A)
      //   b) Emits "reconnected" → catchUpAllAddresses → processScripthashHistory
      //      (path B)
      //
      // The mock server delays the first get_history response by 120 ms so path
      // B's SELECT also runs before either UPDATE fires, creating a true concurrent
      // race on the mempool→confirmed upgrade.
      const confirmedRow = await waitForConfirmed(TEST_ADDR_ID, TEST_TXID);

      // Allow all in-flight concurrent paths to fully settle.
      await sleep(600);

      // ── Step 4: verify the race was actually exercised ────────────────────
      assert.ok(
        getHistoryCallCount >= 2,
        `Expected at least 2 get_history calls to confirm both concurrent ` +
          `processScripthashHistory paths ran, but only got ${getHistoryCallCount}. ` +
          `The race condition may not have been exercised.`,
      );

      // ── Step 5: assert exactly one confirmed row ──────────────────────────
      assert.ok(
        confirmedRow !== null,
        "Expected the mempool row to be upgraded to 'confirmed' within the timeout",
      );
      assert.equal(
        confirmedRow!.status,
        "confirmed",
        "Row status must be 'confirmed' after the upgrade",
      );
      assert.equal(
        confirmedRow!.txid,
        TEST_TXID,
        "txid must match the seeded transaction",
      );

      const [{ n: rowCount }] = await db
        .select({ n: count() })
        .from(alertEvents)
        .where(and(eq(alertEvents.addressId, TEST_ADDR_ID), eq(alertEvents.txid, TEST_TXID)));

      assert.equal(
        rowCount,
        1,
        `Expected exactly 1 alert_events row after the concurrent upgrade race, ` +
          `but found ${rowCount}. The unique index should prevent duplicate rows.`,
      );

      // ── Step 6: assert exactly one XMPP confirmed alert was sent ──────────
      assert.equal(
        xmppSendCount,
        1,
        `Expected exactly 1 XMPP confirmed alert to be sent, but sendAlert was ` +
          `called ${xmppSendCount} time(s) for txid ${TEST_TXID}. The conditional ` +
          `UPDATE + .returning() guard must ensure only the winning UPDATE triggers ` +
          `the alert.`,
      );
    } finally {
      // Restore original XMPP methods so other tests aren't affected.
      (xmppSvc as unknown as Record<string, unknown>).isConfigured = origIsConfigured;
      (xmppSvc as unknown as Record<string, unknown>).isConnected = origIsConnected;
      (xmppSvc as unknown as Record<string, unknown>).sendAlert = origSendAlert;
    }
  },
);
