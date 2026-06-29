/**
 * Integration test: an address added to the DB while the node is offline
 * is picked up and subscribed when the node reconnects.
 *
 * Scenario:
 *  1. Seed one "pre-existing" address and settings in the DB.
 *  2. Start a mock Electrum TCP server that serves history for both addresses.
 *  3. initMonitor() → client connects, subscribes the pre-existing address.
 *  4. Simulate an outage by destroying all active TCP sockets.
 *     (subscribeAddress early-returns when not connected, so the new address
 *      written to the DB during the outage is NOT subscribed at insert time.)
 *  5. Insert the NEW watched address into the DB while offline.
 *  6. Wait for the ElectrumClient to auto-reconnect.
 *     The "connected" event re-runs subscribeAllAddresses which re-reads
 *     the DB — it picks up both the pre-existing and the newly-added address.
 *  7. Assert the new address is subscribed (subscriptionCount covers it).
 *  8. Assert at least one alert_events row exists for the new address.
 *
 * Done looks like:
 *  - subscriptionCount >= 2 (both addresses tracked).
 *  - At least 1 alert_events row for the new address (history was processed).
 */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import net from "net";
import crypto from "crypto";
import { db, watchedAddresses, alertEvents, appSettings } from "@workspace/db";
import { eq, inArray } from "drizzle-orm";
import { initMonitor, destroyMonitor, getElectrumClient } from "../monitor.js";

// ── Scripthash helpers ────────────────────────────────────────────────────────

function scriptToScripthash(scriptHex: string): string {
  const script = Buffer.from(scriptHex, "hex");
  const hash = crypto.createHash("sha256").update(script).digest();
  return Buffer.from(hash).reverse().toString("hex");
}

// Use witness programs in the 0xC0–0xC1 range — distinct from all other tests.
const EXISTING_WITNESS  = "000000000000000000000000000000000000" + "00c0";
const NEW_WITNESS       = "000000000000000000000000000000000000" + "00c1";

const EXISTING_SCRIPT_HEX = "0014" + EXISTING_WITNESS;
const NEW_SCRIPT_HEX      = "0014" + NEW_WITNESS;

const EXISTING_SCRIPTHASH = scriptToScripthash(EXISTING_SCRIPT_HEX);
const NEW_SCRIPTHASH      = scriptToScripthash(NEW_SCRIPT_HEX);

// Unique IDs — include a UUID so parallel test runs don't collide in the DB.
const EXISTING_ADDR_ID = `offline-add-existing-${crypto.randomUUID()}`;
const NEW_ADDR_ID      = `offline-add-new-${crypto.randomUUID()}`;

// Unique txids for each address.
const EXISTING_TXID = "e0".repeat(32);
const NEW_TXID      = "e1".repeat(32);

// Minimal raw P2WPKH transaction paying 10 000 sats to a given output script.
function makeRawTx(scriptHex: string): string {
  return (
    "01000000" +        // version: 1 (LE)
    "01" +               // 1 input
    "00".repeat(32) +   // prevhash: 32 zero bytes
    "ffffffff" +         // previndex
    "00" +               // input script length = 0
    "ffffffff" +         // sequence
    "01" +               // 1 output
    "1027000000000000" + // value: 10 000 sats in LE
    "16" +               // output script length: 22 bytes
    scriptHex +          // P2WPKH output script
    "00000000"           // locktime
  );
}

const EXISTING_RAW_TX = makeRawTx(EXISTING_SCRIPT_HEX);
const NEW_RAW_TX      = makeRawTx(NEW_SCRIPT_HEX);

// ── Mock Electrum TCP server ──────────────────────────────────────────────────

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
      // Always return non-null so the monitor immediately processes history.
      respond(socket, id, "status-offline-add-v1");
      break;

    case "blockchain.scripthash.get_history": {
      const scripthash = (params as string[])[0];
      if (scripthash === EXISTING_SCRIPTHASH) {
        respond(socket, id, [{ tx_hash: EXISTING_TXID, height: 800_000 }]);
      } else if (scripthash === NEW_SCRIPTHASH) {
        respond(socket, id, [{ tx_hash: NEW_TXID, height: 800_000 }]);
      } else {
        respond(socket, id, []);
      }
      break;
    }

    case "blockchain.transaction.get": {
      const txid = (params as string[])[0];
      if (txid === EXISTING_TXID) {
        respond(socket, id, EXISTING_RAW_TX);
      } else if (txid === NEW_TXID) {
        respond(socket, id, NEW_RAW_TX);
      } else {
        respond(socket, id, null);
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

  // Only the pre-existing address is seeded before the monitor starts.
  await db
    .insert(watchedAddresses)
    .values({
      id: EXISTING_ADDR_ID,
      label: "Offline-Add Existing Address",
      address: `offline-add-existing-placeholder-${EXISTING_ADDR_ID}`,
      scripthash: EXISTING_SCRIPTHASH,
    })
    .onConflictDoNothing();
}

async function cleanupTestData(): Promise<void> {
  const ids = [EXISTING_ADDR_ID, NEW_ADDR_ID];
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

async function waitUntilConnected(timeoutMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const client = getElectrumClient();
    if (client?.connected) return true;
    await sleep(30);
  }
  return false;
}

async function waitUntilDisconnected(timeoutMs = 3_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const client = getElectrumClient();
    if (!client?.connected) return true;
    await sleep(30);
  }
  return false;
}

async function waitUntilSubscribed(target: number, timeoutMs = 5_000): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const client = getElectrumClient();
    if (client && client.subscriptionCount >= target) return client.subscriptionCount;
    await sleep(30);
  }
  return getElectrumClient()?.subscriptionCount ?? 0;
}

// ── Lifecycle hooks ───────────────────────────────────────────────────────────

before(async () => {
  process.env.ELECTRUM_RECONNECT_DELAY_MS = "50";
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

test("address added while node is offline is subscribed and alerted after reconnect", async () => {
  // ── Step 1: initial connect ───────────────────────────────────────────────────
  await initMonitor();

  const initialConnected = await waitUntilConnected();
  assert.ok(initialConnected, "Monitor should connect to mock server on startup");

  // Allow subscribeAllAddresses to finish and history processing to settle.
  // At this point only EXISTING_ADDR_ID is in the DB.
  await sleep(400);

  // Sanity check: the pre-existing address should be subscribed.
  const clientAfterInit = getElectrumClient();
  assert.ok(clientAfterInit !== null, "ElectrumClient should exist after initMonitor");
  assert.ok(
    clientAfterInit!.subscriptionCount >= 1,
    `Expected at least 1 subscription after initial connect, ` +
      `got ${clientAfterInit!.subscriptionCount}`,
  );

  // ── Step 2: simulate outage ───────────────────────────────────────────────────
  simulateOutage();

  const disconnected = await waitUntilDisconnected();
  assert.ok(disconnected, "Monitor should detect the outage and mark itself disconnected");

  // ── Step 3: add new address to DB while offline ───────────────────────────────
  // This mirrors exactly what the API route does when a user adds a watched
  // address.  subscribeAddress() early-returns when not connected, so this
  // address is persisted but NOT yet subscribed via Electrum.
  await db
    .insert(watchedAddresses)
    .values({
      id: NEW_ADDR_ID,
      label: "Offline-Add New Address",
      address: `offline-add-new-placeholder-${NEW_ADDR_ID}`,
      scripthash: NEW_SCRIPTHASH,
    })
    .onConflictDoNothing();

  // Confirm the new row is in the DB before the reconnect.
  const [newRow] = await db
    .select()
    .from(watchedAddresses)
    .where(eq(watchedAddresses.id, NEW_ADDR_ID));
  assert.ok(newRow, "New address should be persisted in the DB while offline");

  // ── Step 4: wait for reconnect ────────────────────────────────────────────────
  // The ElectrumClient reconnects automatically (50 ms delay).
  // On the "connected" event, subscribeAllAddresses re-reads the DB and picks
  // up both the pre-existing address and the newly-added one.
  const reconnected = await waitUntilConnected(5_000);
  assert.ok(reconnected, "Monitor should reconnect to the mock server automatically");

  // ── Step 5: assert new address is subscribed ──────────────────────────────────
  // Both addresses must now be in the subscriptions Set.
  const finalCount = await waitUntilSubscribed(2, 5_000);

  assert.ok(
    finalCount >= 2,
    `Expected subscriptionCount >= 2 (both addresses subscribed after reconnect), ` +
      `but got ${finalCount}. The new address added while offline was not picked up ` +
      `by subscribeAllAddresses on reconnect.`,
  );

  // ── Step 6: allow history processing to settle ────────────────────────────────
  await sleep(600);

  // ── Step 7: assert new address has at least one alert_events row ─────────────
  const [{ n }] = await db
    .select({ n: (await import("drizzle-orm")).count() })
    .from(alertEvents)
    .where(eq(alertEvents.addressId, NEW_ADDR_ID));

  assert.ok(
    n >= 1,
    `Expected at least 1 alert_events row for the new address added while offline ` +
      `(addressId: ${NEW_ADDR_ID}), but found ${n}. ` +
      `subscribeAllAddresses on reconnect should re-read the DB and subscribe — ` +
      `and the non-null status returned by the mock should trigger history processing.`,
  );
});
