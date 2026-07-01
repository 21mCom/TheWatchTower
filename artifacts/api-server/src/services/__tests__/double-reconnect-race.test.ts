/**
 * Integration test: two consecutive "reconnected" events racing to run catchUpAllAddresses
 * at the same instant produce exactly one alert_events row per transaction, and the XMPP
 * send count does not exceed one.
 *
 * Race scenario:
 *  1. Start a mock Electrum TCP server with a transaction already in history.
 *  2. Seed the DB: one watched address + settings pointing to the mock server.
 *  3. Call initMonitor() → initial connect → subscribeAllAddresses processes history →
 *     exactly one alert_events row is inserted.
 *  4. Delete the alert row so the race starts from a clean state.
 *  5. Patch the XmppService to count every sendAlert call (simulates a configured+connected XMPP).
 *  6. Set the mock server to delay all get_history responses by 200 ms.
 *  7. Emit "reconnected" on the live ElectrumClient — catchUpAllAddresses #1 starts and
 *     blocks on getHistory (200 ms delay).
 *  8. After a 50 ms gap (well within the 200 ms window), emit "reconnected" again —
 *     catchUpAllAddresses #2 starts and also blocks on getHistory.
 *  9. Both calls concurrently reach processScripthashHistory for the same (address_id, txid)
 *     pair. The first to complete the SELECT→INSERT inserts the row; the second hits
 *     onConflictDoNothing() and is a no-op.
 * 10. Assert alert_events has exactly one row for the transaction.
 * 11. Assert xmppSendCount ≤ 1 (structurally guaranteed: sendAlert is called only when
 *     the INSERT succeeds, i.e. inserted.length > 0).
 */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import net from "net";
import crypto from "crypto";
import { db, watchedAddresses, alertEvents, appSettings } from "@workspace/db";
import { eq, and, count } from "drizzle-orm";
import { initMonitor, destroyMonitor, getElectrumClient, getXmpp } from "../monitor.js";

// ── Scripthash helpers ────────────────────────────────────────────────────────

function scriptToScripthash(scriptHex: string): string {
  const script = Buffer.from(scriptHex, "hex");
  const hash = crypto.createHash("sha256").update(script).digest();
  return Buffer.from(hash).reverse().toString("hex");
}

// P2WPKH output script with a unique 20-byte program — witness program byte 0x04
// ensures this test's scripthash never collides with other tests.
const WITNESS_PROGRAM_HEX = "0000000000000000000000000000000000000004";
const OUTPUT_SCRIPT_HEX = "0014" + WITNESS_PROGRAM_HEX; // 22 bytes
const TEST_SCRIPTHASH = scriptToScripthash(OUTPUT_SCRIPT_HEX);

const TEST_ADDR_ID = `double-reconnect-${crypto.randomUUID()}`;
const TEST_ADDRESS_LABEL = "Test Double-Reconnect Race Address";

// Unique fake txid: "ee" repeated 32 times = 64 hex chars
const TEST_TXID = "ee".repeat(32);

// ── Raw transaction ───────────────────────────────────────────────────────────

// Minimal legacy-format transaction with one dummy input and one P2WPKH output.
// 45 000 sats = 0xAFC8 → LE uint64: c8 af 00 00 00 00 00 00
const RAW_TX_HEX =
  "01000000" + // version
  "01" + // 1 input
  "0".repeat(64) + // prevhash (32 zero bytes)
  "ffffffff" + // previndex
  "01" + "00" + // scriptLen=1, script=0x00 (dummy)
  "ffffffff" + // sequence
  "01" + // 1 output
  "c8af000000000000" + // value: 45 000 sats (LE uint64)
  "16" + // scriptLen=22
  OUTPUT_SCRIPT_HEX + // P2WPKH output script
  "00000000"; // locktime

// ── Mock Electrum TCP server ──────────────────────────────────────────────────

// History is pre-seeded so subscribeScripthash always returns a non-null status.
const mockHistory: Array<{ tx_hash: string; height: number }> = [
  { tx_hash: TEST_TXID, height: 800_000 },
];

/**
 * Milliseconds to delay get_history responses.
 * Set to 0 initially so the first (initial-connect) subscribeAllAddresses completes
 * fast; raised to 200 ms before emitting "reconnected" to force the race overlap.
 */
let getHistoryDelayMs = 0;

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
      // chain tip 800 001 → tx at 800 000 has 2 confirmations → meets threshold=1
      respond(socket, id, { height: 800_001 });
      break;

    case "blockchain.scripthash.subscribe":
      // History exists from the start → always return a non-null status
      respond(socket, id, "status-hash-double-reconnect-v1");
      break;

    case "blockchain.scripthash.get_history": {
      const delay = getHistoryDelayMs;
      if (delay > 0) {
        setTimeout(() => {
          if (!socket.destroyed) {
            respond(socket, id, mockHistory);
          }
        }, delay);
      } else {
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

async function waitForAlertRow(timeoutMs = 6_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const [row] = await db
      .select()
      .from(alertEvents)
      .where(and(eq(alertEvents.addressId, TEST_ADDR_ID), eq(alertEvents.txid, TEST_TXID)))
      .limit(1);
    if (row) return true;
    await sleep(100);
  }
  return false;
}

// ── XMPP patch state (captured in before, restored in after) ─────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyRecord = Record<string, any>;
let xmppOriginals: { isConfigured: unknown; isConnected: unknown; sendAlert: unknown } | null =
  null;

// ── Lifecycle hooks ───────────────────────────────────────────────────────────

before(async () => {
  process.env.ELECTRUM_RECONNECT_DELAY_MS = "100";
  await startMockServer();
  await seedTestData();
});

after(async () => {
  // Restore any patched XMPP methods before tearing down so the singleton is
  // left in a clean state for any tests that run after this suite.
  if (xmppOriginals !== null) {
    const xmpp = getXmpp() as unknown as AnyRecord;
    xmpp["isConfigured"] = xmppOriginals.isConfigured;
    xmpp["isConnected"] = xmppOriginals.isConnected;
    xmpp["sendAlert"] = xmppOriginals.sendAlert;
    xmppOriginals = null;
  }
  destroyMonitor();
  await new Promise<void>((resolve) => mockServer.close(() => resolve()));
  await cleanupTestData();
  delete process.env.ELECTRUM_RECONNECT_DELAY_MS;
});

// ── The test ──────────────────────────────────────────────────────────────────

test(
  "two racing reconnects produce exactly one alert_events row and at most one XMPP send",
  async () => {
    // ── Step 1: initial connect ────────────────────────────────────────────────
    // getHistoryDelayMs = 0: subscribeAllAddresses completes quickly and inserts
    // the alert row on the first connection.
    await initMonitor();

    // Wait for the initial connect and subscribeAllAddresses to process history.
    const appeared = await waitForAlertRow(6_000);
    assert.ok(appeared, "Expected alert_events row to appear after initial connection");

    // ── Step 2: reset the alert row to start the race from a clean slate ───────
    await db
      .delete(alertEvents)
      .where(and(eq(alertEvents.addressId, TEST_ADDR_ID), eq(alertEvents.txid, TEST_TXID)));

    // Confirm the slate is clean.
    const [cleared] = await db
      .select()
      .from(alertEvents)
      .where(and(eq(alertEvents.addressId, TEST_ADDR_ID), eq(alertEvents.txid, TEST_TXID)))
      .limit(1);
    assert.equal(cleared, undefined, "alert_events must be empty before the race");

    // ── Step 3: patch XMPP to count send attempts without a real connection ────
    // Replace isConfigured/isConnected/sendAlert on the singleton XmppService so
    // that sendTransactionAlert flows all the way through to sendAlert.
    // Originals are saved here and restored in the `after` hook to prevent
    // singleton state leakage across test files.
    let xmppSendCount = 0;
    const xmpp = getXmpp() as unknown as AnyRecord;
    xmppOriginals = {
      isConfigured: xmpp["isConfigured"],
      isConnected: xmpp["isConnected"],
      sendAlert: xmpp["sendAlert"],
    };
    xmpp["isConfigured"] = () => true;
    xmpp["isConnected"] = () => true;
    xmpp["sendAlert"] = async (_msg: string) => {
      xmppSendCount++;
    };

    // ── Step 4: slow down get_history responses to force the race ──────────────
    // With a 200 ms delay, both catchUpAllAddresses calls will be concurrently
    // inside processScripthashHistory awaiting their getHistory responses before
    // either one reaches the SELECT→INSERT step.
    getHistoryDelayMs = 200;

    // ── Step 5: emit "reconnected" twice in quick succession ───────────────────
    // The first emission starts catchUpAllAddresses #1 (async, not awaited by the
    // event system — the handler is `async () => { ... }` so it runs concurrently).
    // After a 50 ms gap, the second emission starts catchUpAllAddresses #2.
    // Both are running concurrently, both process the same txid.
    const client = getElectrumClient();
    assert.ok(client !== null, "ElectrumClient must be active before the race");

    client!.emit("reconnected"); // catch-up #1 starts
    await sleep(50);             // gap << 200 ms getHistory delay
    client!.emit("reconnected"); // catch-up #2 starts while #1 still awaits getHistory

    // ── Step 6: wait for both catch-ups to fully settle ────────────────────────
    // 200 ms (getHistory delay) + 200 ms (tx decode + DB write) + generous buffer
    await sleep(800);

    // ── Step 7: assert exactly one alert_events row ───────────────────────────
    const [{ n: rowCount }] = await db
      .select({ n: count() })
      .from(alertEvents)
      .where(and(eq(alertEvents.addressId, TEST_ADDR_ID), eq(alertEvents.txid, TEST_TXID)));

    assert.equal(
      rowCount,
      1,
      `Expected exactly 1 alert_events row after two concurrent catchUpAllAddresses runs, ` +
        `but found ${rowCount}. The unique constraint + onConflictDoNothing() must absorb ` +
        `the second concurrent INSERT attempt.`,
    );

    // Verify the row content is correct.
    const [alertRow] = await db
      .select()
      .from(alertEvents)
      .where(and(eq(alertEvents.addressId, TEST_ADDR_ID), eq(alertEvents.txid, TEST_TXID)))
      .limit(1);

    assert.ok(alertRow, "The single alert_events row must be readable");
    assert.equal(alertRow!.txid, TEST_TXID, "txid must match");
    assert.equal(alertRow!.addressId, TEST_ADDR_ID, "addressId must match");
    assert.equal(
      alertRow!.direction,
      "incoming",
      "Output pays to our scripthash → direction must be 'incoming'",
    );
    assert.equal(alertRow!.amountSats, 45_000, "Output value must be 45 000 sats");

    // ── Step 8: assert XMPP send count ≤ 1 ────────────────────────────────────
    // sendAlert is called only after a successful INSERT (inserted.length > 0),
    // so exactly 1 DB row structurally implies at most 1 XMPP send.
    assert.ok(
      xmppSendCount <= 1,
      `Expected at most 1 XMPP send from two racing catchUpAllAddresses calls, ` +
        `but sendAlert was called ${xmppSendCount} times. The second catchUp must not ` +
        `re-send an alert for a txid that was already inserted.`,
    );
  },
);
