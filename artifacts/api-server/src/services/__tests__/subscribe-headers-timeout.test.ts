/**
 * Integration test: a hanging blockchain.headers.subscribe on the connected path
 * does NOT prevent subscribeAllAddresses from running.
 *
 * Flow:
 *  1. Start a mock Electrum TCP server that accepts connections and responds
 *     normally to all methods EXCEPT blockchain.headers.subscribe — those
 *     requests are silently dropped so the RPC call hangs until timeout.
 *  2. Set ELECTRUM_RPC_TIMEOUT_MS to 400 ms so the test completes quickly.
 *  3. Seed the DB: one watched address with a transaction already in history.
 *  4. Call initMonitor() → client connects → "connected" handler fires:
 *       a. subscribeHeaders() hangs → times out after 400 ms → error is caught.
 *       b. subscribeAllAddresses() runs → subscribeScripthash returns non-null
 *          → processScripthashHistory inserts an alert_events row.
 *  5. Assert the alert_events row exists, confirming subscribeAllAddresses ran
 *     despite the subscribeHeaders timeout.
 */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import net from "net";
import crypto from "crypto";
import { db, watchedAddresses, alertEvents, appSettings } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { initMonitor, destroyMonitor } from "../monitor.js";

// ── Scripthash helpers ────────────────────────────────────────────────────────

function scriptToScripthash(scriptHex: string): string {
  const script = Buffer.from(scriptHex, "hex");
  const hash = crypto.createHash("sha256").update(script).digest();
  return Buffer.from(hash).reverse().toString("hex");
}

// Unique witness program (0x03 suffix) to avoid collisions with other tests.
const WITNESS_PROGRAM_HEX = "0000000000000000000000000000000000000003";
const OUTPUT_SCRIPT_HEX = "0014" + WITNESS_PROGRAM_HEX;
const TEST_SCRIPTHASH = scriptToScripthash(OUTPUT_SCRIPT_HEX);

const TEST_ADDR_ID = `headers-timeout-${crypto.randomUUID()}`;
const TEST_ADDRESS_LABEL = "Test Headers Timeout Address";

// A transaction already in history from the moment the client connects.
const TEST_TXID = "ee".repeat(32);

// Minimal P2WPKH raw transaction paying 50 000 sats to OUTPUT_SCRIPT_HEX.
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

let mockServer!: net.Server;
let serverPort!: number;
const activeClientSockets = new Set<net.Socket>();

function respond(socket: net.Socket, id: number, result: unknown): void {
  socket.write(JSON.stringify({ id, result }) + "\n");
}

/**
 * Handle incoming Electrum RPC requests.
 * blockchain.headers.subscribe is intentionally NOT handled — the request
 * is silently dropped so the RPC call hangs until the client-side timeout fires.
 */
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
      // Intentionally dropped — never respond so the RPC timeout fires after
      // ELECTRUM_RPC_TIMEOUT_MS milliseconds.
      break;
    case "blockchain.scripthash.subscribe":
      // Return non-null status so processScripthashHistory is triggered.
      respond(socket, id, "status-headers-timeout-v1");
      break;
    case "blockchain.scripthash.get_history":
      respond(socket, id, [{ tx_hash: TEST_TXID, height: 800_000 }]);
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

// ── Database helpers ──────────────────────────────────────────────────────────

let savedSettings: typeof appSettings.$inferSelect | null = null;

async function seedTestData(): Promise<void> {
  const [existing] = await db.select().from(appSettings).limit(1);
  savedSettings = existing ?? null;

  // confirmationThreshold=1: height 800 000, chain tip 800 001 → 2 confs → confirmed
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

// ── Polling helper ────────────────────────────────────────────────────────────

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
    await new Promise<void>((r) => setTimeout(r, 150));
  }
  return null;
}

// ── Lifecycle hooks ───────────────────────────────────────────────────────────

before(async () => {
  // Short RPC timeout so the hanging headers.subscribe resolves quickly.
  process.env.ELECTRUM_RPC_TIMEOUT_MS = "400";
  // Short reconnect delay to avoid delaying the test if a reconnect is needed.
  process.env.ELECTRUM_RECONNECT_DELAY_MS = "200";
  await startMockServer();
  await seedTestData();
});

after(async () => {
  destroyMonitor();
  await new Promise<void>((resolve) => mockServer.close(() => resolve()));
  await cleanupTestData();
  delete process.env.ELECTRUM_RPC_TIMEOUT_MS;
  delete process.env.ELECTRUM_RECONNECT_DELAY_MS;
});

// ── The test ──────────────────────────────────────────────────────────────────

test(
  "subscribeAllAddresses runs and alert fires even when subscribeHeaders times out on connect",
  async () => {
    // Connect the monitor. The "connected" handler will:
    //   1. Call subscribeHeaders() → hangs → times out after 400 ms → error caught.
    //   2. Call subscribeAllAddresses() → subscribeScripthash returns non-null
    //      → processScripthashHistory → alert_events row inserted.
    await initMonitor();

    // Wait for the alert to appear. The timeout must be longer than the RPC
    // timeout (400 ms) + processing time. We allow 8 s in total.
    const alertRow = await waitForAlertEvent(TEST_ADDR_ID, TEST_TXID);

    assert.ok(
      alertRow !== null,
      "Expected an alert_events row to be created after subscribeAllAddresses ran, " +
        "but none was found. subscribeAllAddresses may have been skipped because the " +
        "subscribeHeaders timeout was not caught correctly.",
    );

    assert.equal(alertRow.txid, TEST_TXID, "txid should match the pre-seeded transaction");
    assert.equal(
      alertRow.addressId,
      TEST_ADDR_ID,
      "addressId should reference the correct watched address",
    );
    assert.equal(
      alertRow.direction,
      "incoming",
      "Transaction output pays to our scripthash → direction should be incoming",
    );
    assert.equal(alertRow.amountSats, 50_000, "Output value should be 50 000 sats");
    assert.ok(
      alertRow.status === "mempool" || alertRow.status === "confirmed",
      `status should be mempool or confirmed, got '${alertRow.status}'`,
    );
  },
);
