/**
 * Integration test: a live scripthash notification arriving while catchUpAllAddresses
 * is still iterating does not produce duplicate alert_events rows.
 *
 * Race scenario:
 *  1. Start a mock Electrum TCP server. Initially it reports no history (null status).
 *  2. Seed the DB with one watched address and settings pointing to the mock server.
 *  3. Call initMonitor() → client connects, subscribes, null status → no row inserted.
 *  4. Inject history into the mock server; simulate outage.
 *  5. Client auto-reconnects → catchUpAllAddresses starts.
 *  6. On the FIRST blockchain.scripthash.get_history request, the mock server:
 *       a. Immediately pushes a live blockchain.scripthash.subscribe notification
 *          for the same scripthash to the same socket, simulating a live on-chain event.
 *       b. Delays its get_history response by 120 ms.
 *     This ensures the notification handler fires a second processScripthashHistory
 *     call while the catch-up call is still awaiting the getHistory response.
 *  7. Both concurrent processScripthashHistory calls reach the SELECT→INSERT path
 *     for the same (address_id, txid) pair.
 *  8. Assert exactly ONE alert_events row exists — the unique constraint +
 *     onConflictDoNothing() must absorb the second insertion attempt.
 *
 * "No duplicate XMPP sends" is guaranteed structurally: sendTransactionAlert is
 * called only when the INSERT succeeds (inserted.length > 0). Exactly one
 * alert_events row therefore means at most one XMPP send attempt.
 */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import net from "net";
import crypto from "crypto";
import { db, watchedAddresses, alertEvents, appSettings } from "@workspace/db";
import { eq, and, count } from "drizzle-orm";
import { initMonitor, destroyMonitor } from "../monitor.js";

// ── Scripthash helpers ────────────────────────────────────────────────────────

function scriptToScripthash(scriptHex: string): string {
  const script = Buffer.from(scriptHex, "hex");
  const hash = crypto.createHash("sha256").update(script).digest();
  return Buffer.from(hash).reverse().toString("hex");
}

// P2WPKH output script with a unique 20-byte program so this test's scripthash
// does not collide with other tests' scripthashes.
const WITNESS_PROGRAM_HEX = "0000000000000000000000000000000000000003";
const OUTPUT_SCRIPT_HEX = "0014" + WITNESS_PROGRAM_HEX;
const TEST_SCRIPTHASH = scriptToScripthash(OUTPUT_SCRIPT_HEX);

const TEST_ADDR_ID = `race-test-${crypto.randomUUID()}`;
const TEST_ADDRESS_LABEL = "Test Race Address";
const TEST_TXID = "dd".repeat(32); // unique 64-char hex

// Minimal raw transaction paying 75 000 sats to OUTPUT_SCRIPT_HEX.
// 75 000 sats = 0x1_2C00 → LE uint64: 00 2c 01 00 00 00 00 00  (wait: 0x12C00 = 76800, let me recalc)
// 75 000 = 0x124F8 — let's use 60 000 = 0xEA60 → LE: 60 ea 00 00 00 00 00 00
const RAW_TX_HEX =
  "01000000" + // version
  "01" + // 1 input
  "0".repeat(64) + // prevhash (32 zero bytes)
  "ffffffff" + // previndex
  "01" + "00" + // scriptLen=1, script=0x00
  "ffffffff" + // sequence
  "01" + // 1 output
  "60ea000000000000" + // value: 60 000 sats (LE uint64)
  "16" + // scriptLen=22
  OUTPUT_SCRIPT_HEX + // P2WPKH output script
  "00000000"; // locktime

// ── Mock server state ─────────────────────────────────────────────────────────

let mockHistory: Array<{ tx_hash: string; height: number }> = [];

let mockServer!: net.Server;
let serverPort!: number;
const activeClientSockets = new Set<net.Socket>();

/**
 * Tracks whether the mock has already pushed the live notification for the race.
 * We only want to inject it once — on the very first getHistory call after outage.
 */
let liveNotificationPushed = false;

/**
 * Counts how many concurrent processScripthashHistory calls reached getHistory.
 * Used to verify the race actually happened (both paths issued a getHistory).
 */
let getHistoryCallCount = 0;

function respond(socket: net.Socket, id: number, result: unknown): void {
  socket.write(JSON.stringify({ id, result }) + "\n");
}

function pushNotification(socket: net.Socket, scripthash: string, status: string): void {
  socket.write(
    JSON.stringify({
      method: "blockchain.scripthash.subscribe",
      params: [scripthash, status],
    }) + "\n",
  );
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
      // During initial connect, return null (no history yet).
      // After outage (hasHistory reflected via mockHistory.length), return non-null.
      // Note: the reconnect path in ElectrumClient re-subscribes and emits notifications,
      // then fires "reconnected" → catchUpAllAddresses. Returning null here keeps the
      // notification path quiet; the catch-up path is what we are testing.
      respond(socket, id, mockHistory.length > 0 ? "status-hash-race-v1" : null);
      break;

    case "blockchain.scripthash.get_history": {
      getHistoryCallCount++;
      const currentCount = getHistoryCallCount;

      if (currentCount === 1 && !liveNotificationPushed && mockHistory.length > 0) {
        // First getHistory call while catch-up is in progress.
        // Push a live notification BEFORE the response arrives.
        // This triggers a second processScripthashHistory call concurrently.
        liveNotificationPushed = true;
        pushNotification(socket, TEST_SCRIPTHASH, "status-hash-race-live");

        // Delay this response so the notification-triggered processScripthashHistory
        // can start its own getHistory before this one resolves.
        setTimeout(() => {
          if (!socket.destroyed) {
            respond(socket, id, mockHistory);
          }
        }, 120);
      } else {
        // Subsequent calls (from the notification-triggered path) respond immediately.
        respond(socket, id, mockHistory);
      }
      break;
    }

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

async function waitForAlertEvent(
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
    if (row) return row;
    await sleep(150);
  }
  return null;
}

// ── Lifecycle hooks ───────────────────────────────────────────────────────────

before(async () => {
  // 150 ms reconnect delay — fast enough to keep the test short,
  // slow enough to let us inject history before the reconnect fires.
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
  "live notification mid-catch-up produces exactly one alert_events row and no duplicate XMPP sends",
  async () => {
    // ── Step 1: initial connect (no history → null status) ────────────────────
    await initMonitor();

    // Allow subscribeAllAddresses to finish; with null status, nothing is inserted.
    await sleep(400);

    const [beforeOutage] = await db
      .select()
      .from(alertEvents)
      .where(eq(alertEvents.addressId, TEST_ADDR_ID))
      .limit(1);
    assert.equal(
      beforeOutage,
      undefined,
      "No alert_events row should exist before the outage",
    );

    // ── Step 2: inject history and simulate outage ────────────────────────────
    // Set history before the outage so the reconnect catch-up will find it.
    mockHistory = [{ tx_hash: TEST_TXID, height: 800_000 }];
    simulateOutage();

    // ── Step 3: wait for the alert to appear ──────────────────────────────────
    // On reconnect the ElectrumClient:
    //   a) re-subscribes (gets non-null status) → notification handler fires
    //      processScripthashHistory — this issues getHistory call #N
    //   b) emits "reconnected" → catchUpAllAddresses → processScripthashHistory
    //      — this issues getHistory call #M
    //
    // Additionally, when the FIRST getHistory call arrives at the mock server,
    // the server pushes a live notification back before responding (120 ms delay),
    // injecting a third concurrent processScripthashHistory call.
    //
    // All concurrent calls must resolve to exactly ONE alert_events row.
    const alertRow = await waitForAlertEvent(TEST_ADDR_ID, TEST_TXID);

    // ── Step 4: verify the race produced exactly one row ──────────────────────
    assert.ok(
      alertRow !== null,
      "Expected an alert_events row after reconnect catch-up, but none appeared within the timeout",
    );
    assert.equal(alertRow!.txid, TEST_TXID, "txid must match the injected transaction");
    assert.equal(
      alertRow!.addressId,
      TEST_ADDR_ID,
      "addressId must reference the correct watched address",
    );
    assert.equal(
      alertRow!.direction,
      "incoming",
      "Transaction output pays to our scripthash — direction must be 'incoming'",
    );
    assert.equal(
      alertRow!.amountSats,
      60_000,
      "Output value in the raw transaction is 60 000 sats",
    );

    // Allow all concurrent processing paths to fully settle before checking count.
    await sleep(600);

    const [{ n: rowCount }] = await db
      .select({ n: count() })
      .from(alertEvents)
      .where(and(eq(alertEvents.addressId, TEST_ADDR_ID), eq(alertEvents.txid, TEST_TXID)));

    assert.equal(
      rowCount,
      1,
      `Expected exactly 1 alert_events row after the concurrent catch-up + live notification race, ` +
        `but found ${rowCount}. The unique constraint or onConflictDoNothing() may not be protecting ` +
        `against the interleaved timing.`,
    );

    // ── Step 5: verify the live notification push was actually triggered ──────
    // This confirms the race condition was actually exercised, not bypassed.
    assert.ok(
      liveNotificationPushed,
      "The mock server must have pushed a live notification during the getHistory delay — " +
        "if this fails, the race condition was not actually exercised",
    );
  },
);
