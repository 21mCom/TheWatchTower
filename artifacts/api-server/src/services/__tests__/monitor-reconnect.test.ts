/**
 * Integration test: no alerts are missed during a real node outage.
 *
 * Flow:
 *  1. Start a minimal mock Electrum TCP server (returns no history initially).
 *  2. Seed the DB: watched address + settings pointing to the mock server.
 *  3. Call initMonitor() → client connects, subscribes, gets null status (no history yet).
 *  4. Simulate outage: destroy all active client sockets.
 *  5. Inject a missed transaction into the mock server's history.
 *  6. Wait for the ElectrumClient's auto-reconnect (configured to 200 ms in this test).
 *  7. On reconnect, subscribeAllAddresses runs → subscribeScripthash returns a non-null
 *     status → processScripthashHistory fires → alert_events row is inserted.
 *  8. Assert the row exists with the correct txid, direction, and amount.
 */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import net from "net";
import crypto from "crypto";
import { db, watchedAddresses, alertEvents, appSettings } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { initMonitor, destroyMonitor } from "../monitor.js";

// ── Scripthash helpers ────────────────────────────────────────────────────────

/**
 * Compute the Electrum scripthash for a raw script (hex).
 * scripthash = REVERSE(SHA256(script))
 */
function scriptToScripthash(scriptHex: string): string {
  const script = Buffer.from(scriptHex, "hex");
  const hash = crypto.createHash("sha256").update(script).digest();
  return Buffer.from(hash).reverse().toString("hex");
}

// P2WPKH output script paying to a deterministic 20-byte hash we control.
// Script = OP_0 <20-byte-program> = 0x0014 + <20 bytes>
// Using all-zeros + 0x01 at the end so it is unique and easy to spot.
const WITNESS_PROGRAM_HEX = "0000000000000000000000000000000000000001";
const OUTPUT_SCRIPT_HEX = "0014" + WITNESS_PROGRAM_HEX; // 22 bytes
const TEST_SCRIPTHASH = scriptToScripthash(OUTPUT_SCRIPT_HEX);

// A placeholder address string stored alongside the scripthash.
// The value must be unique in the watched_addresses table; we use the test
// run ID to avoid collisions across parallel or repeated runs.
const TEST_ADDR_ID = `test-${crypto.randomUUID()}`;
const TEST_ADDRESS_LABEL = "Test Outage Address";

// Fake txid representing the transaction that arrived while the node was down
const TEST_TXID = "bb".repeat(32); // 64-char hex

// ── Raw transaction ───────────────────────────────────────────────────────────

// Minimal legacy-format transaction with one dummy input and one P2WPKH output.
// decodeRawTx will parse this and find OUTPUT_SCRIPT_HEX, computing TEST_SCRIPTHASH
// as the output's scripthash — matching the watched address.
//
// Layout (all LE):
//   version     01000000        4 bytes
//   in_count    01              1 byte
//   prevhash    00..00          32 bytes  (dummy)
//   previndex   ffffffff        4 bytes
//   scriptLen   01              1 byte
//   script      00              1 byte    (dummy)
//   sequence    ffffffff        4 bytes
//   out_count   01              1 byte
//   value       50c3000000000000  8 bytes  (50 000 sats)
//   scriptLen   16              1 byte    (22 bytes)
//   script      0014…           22 bytes  (P2WPKH)
//   locktime    00000000        4 bytes
//
// 0x16 = 22 = length of OUTPUT_SCRIPT_HEX / 2
// 50 000 sats = 0xC350 → LE uint64: 50 c3 00 00 00 00 00 00
const RAW_TX_HEX =
  "01000000" + // version
  "01" + // 1 input
  "0".repeat(64) + // prevhash (32 zero bytes)
  "ffffffff" + // previndex
  "01" + "00" + // scriptLen=1, script=0x00 (dummy coinbase-style)
  "ffffffff" + // sequence
  "01" + // 1 output
  "50c3000000000000" + // value: 50 000 sats (LE uint64)
  "16" + // scriptLen=22
  OUTPUT_SCRIPT_HEX + // P2WPKH output script (22 bytes)
  "00000000"; // locktime

// ── Mock Electrum TCP server ──────────────────────────────────────────────────

/** History the mock server advertises; mutated during the test to inject the missed tx. */
let mockHistory: Array<{ tx_hash: string; height: number }> = [];

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
      // Return the chain tip; height 800 001 > block height in history → 1 confirmation
      respond(socket, id, { height: 800_001 });
      break;
    case "blockchain.scripthash.subscribe":
      // Return a non-null status only when history has been injected.
      // This drives processScripthashHistory via the subscribeAllAddresses path.
      respond(socket, id, mockHistory.length > 0 ? "status-hash-v1" : null);
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

/** Forcibly close every connected client socket to simulate a node outage. */
function simulateOutage(): void {
  for (const socket of activeClientSockets) {
    socket.destroy();
  }
}

// ── Database helpers ──────────────────────────────────────────────────────────

let savedSettings: typeof appSettings.$inferSelect | null = null;

async function seedTestData(): Promise<void> {
  // Preserve the existing settings row so we can restore it after the test
  const [existing] = await db.select().from(appSettings).limit(1);
  savedSettings = existing ?? null;

  // Point the monitor at the mock server.
  // confirmationThreshold=1: a tx at height 800 000 with chain tip 800 001
  //   has 2 confirmations → already meets the threshold → inserted as "confirmed".
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

  // Insert the watched address using the scripthash we derived from the output script.
  // The address string is arbitrary (used only for labels/alerts); we use the test ID
  // to guarantee uniqueness in the watched_addresses table.
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

  // Restore original settings
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

// ── Polling helper ────────────────────────────────────────────────────────────

async function waitForAlertEvent(
  addressId: string,
  txid: string,
  timeoutMs = 6_000,
): Promise<typeof alertEvents.$inferSelect | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const [row] = await db
      .select()
      .from(alertEvents)
      .where(and(eq(alertEvents.addressId, addressId), eq(alertEvents.txid, txid)))
      .limit(1);
    if (row) return row;
    await new Promise<void>((r) => setTimeout(r, 150));
  }
  return null;
}

// ── Lifecycle hooks ───────────────────────────────────────────────────────────

before(async () => {
  // Use a short reconnect delay (200 ms) so the test does not wait 10 s
  process.env.ELECTRUM_RECONNECT_DELAY_MS = "200";
  await startMockServer();
  await seedTestData();
});

after(async () => {
  // Tear down the monitor's connections without scheduling further reconnects
  destroyMonitor();
  // Stop the mock server
  await new Promise<void>((resolve) => mockServer.close(() => resolve()));
  // Restore DB state
  await cleanupTestData();
  delete process.env.ELECTRUM_RECONNECT_DELAY_MS;
});

// ── The test ──────────────────────────────────────────────────────────────────

test("alert_events row is created for a transaction that arrived during a node outage", async () => {
  // ── Step 1: connect the monitor (no history → null subscribe status) ────────
  await initMonitor();

  // Allow the async "connected" handler (subscribeAllAddresses) time to finish
  await new Promise<void>((r) => setTimeout(r, 400));

  // Confirm no alert exists before the outage
  const [beforeOutage] = await db
    .select()
    .from(alertEvents)
    .where(eq(alertEvents.addressId, TEST_ADDR_ID))
    .limit(1);
  assert.equal(beforeOutage, undefined, "No alert should exist before the outage");

  // ── Step 2: simulate outage ─────────────────────────────────────────────────
  // Destroy all active client sockets. The ElectrumClient sees a 'close' event
  // and schedules a reconnect after ELECTRUM_RECONNECT_DELAY_MS (200 ms).
  simulateOutage();

  // ── Step 3: inject the missed transaction into mock server history ──────────
  // The next time the client connects and calls subscribeScripthash, the mock
  // will return a non-null status and expose this history entry.
  mockHistory = [{ tx_hash: TEST_TXID, height: 800_000 }];

  // ── Step 4: wait for reconnect + catch-up (up to 6 s) ──────────────────────
  // On reconnect, ElectrumClient fires "connected" → subscribeAllAddresses →
  // subscribeScripthash returns "status-hash-v1" (non-null) →
  // processScripthashHistory fetches the history, decodes RAW_TX_HEX, and
  // inserts an alert_events row.
  const alertRow = await waitForAlertEvent(TEST_ADDR_ID, TEST_TXID);

  // ── Step 5: assertions ──────────────────────────────────────────────────────
  assert.ok(
    alertRow !== null,
    "Expected an alert_events row for the missed transaction, but none was found within the timeout",
  );
  assert.equal(alertRow.txid, TEST_TXID, "txid should match the injected transaction");
  assert.equal(
    alertRow.addressId,
    TEST_ADDR_ID,
    "addressId should reference the correct watched address",
  );
  assert.equal(
    alertRow.direction,
    "incoming",
    "Transaction output pays to our scripthash → direction should be 'incoming'",
  );
  assert.equal(alertRow.amountSats, 50_000, "Output value should be 50 000 sats");
  assert.ok(
    alertRow.status === "mempool" || alertRow.status === "confirmed",
    `status should be 'mempool' or 'confirmed', got '${alertRow.status}'`,
  );
});
