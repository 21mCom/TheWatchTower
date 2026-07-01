/**
 * Integration test: addresses are not silently dropped when reloadMonitor() is called
 * concurrently with subscribeAllAddresses on the old client.
 *
 * Race scenario:
 *  1. Start a mock Electrum TCP server.
 *     - Connection #1: respond to the first blockchain.scripthash.subscribe immediately,
 *       then delay all subsequent subscribe responses by 300 ms.
 *       This allows the test to call reloadMonitor() after address[0] is done but while
 *       address[1] is still waiting for a response.
 *     - Connection #2+: respond normally (no delay).
 *  2. Seed 3 watched addresses (all with pre-existing history) and DB settings pointing to
 *     the mock server.
 *  3. Call initMonitor() → connection #1 → "connected" event → subscribeAllAddresses(oldClient)
 *     starts iterating.
 *     - address[0]: subscribe response arrives quickly → status non-null → history processed
 *       → alert_events row inserted.
 *     - address[1]: subscribe call is in-flight; server has not responded yet (300 ms delay).
 *  4. Sleep 80 ms (enough for address[0] to finish, not enough for address[1] to arrive).
 *  5. Call reloadMonitor() concurrently (while the old subscribeAllAddresses is still waiting):
 *     - Destroys the old ElectrumClient → pending RPC for address[1] rejects with
 *       "Client destroyed" → the catch block in subscribeAllAddresses fires, skipping it.
 *     - address[2] also fails because the client is already destroyed.
 *  6. reloadMonitor() creates a new ElectrumClient (connection #2) and connects.
 *     "connected" fires on the new client → subscribeAllAddresses(newClient) starts fresh,
 *     reading ALL addresses from the DB and subscribing every one of them.
 *  7. Wait for all 3 alert_events rows to appear.
 *
 * Done looks like:
 *  - All 3 addresses have at least one alert_events row (none were silently dropped).
 *  - The new ElectrumClient's subscriptionCount is >= 3.
 */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import net from "net";
import crypto from "crypto";
import { db, watchedAddresses, alertEvents, appSettings } from "@workspace/db";
import { eq, inArray } from "drizzle-orm";
import { initMonitor, destroyMonitor, reloadMonitor, getElectrumClient } from "../monitor.js";

// ── Scripthash helpers ────────────────────────────────────────────────────────

function scriptToScripthash(scriptHex: string): string {
  const script = Buffer.from(scriptHex, "hex");
  const hash = crypto.createHash("sha256").update(script).digest();
  return Buffer.from(hash).reverse().toString("hex");
}

// 3 distinct P2WPKH scripts — witness programs differ in the last byte (0x60–0x62).
// Far from all other test files' address ranges to avoid DB collisions.
const NUM_ADDRESSES = 3;

interface AddressFixture {
  id: string;
  label: string;
  address: string;
  scripthash: string;
  scriptHex: string;
  txid: string;
  rawTxHex: string;
}

function makeFixture(index: number): AddressFixture {
  const lastByte = (0x60 + index).toString(16).padStart(2, "0");
  const witnessProgram = "00000000000000000000000000000000000000" + lastByte;
  const scriptHex = "0014" + witnessProgram;
  const scripthash = scriptToScripthash(scriptHex);
  const id = `reload-mid-sub-${index}-${crypto.randomUUID()}`;
  const label = `Reload Mid-Subscribe Address ${index}`;
  const address = `reload-mid-placeholder-${id}`;

  // Unique txid per address: repeat (0x60 + index) byte 32 times → 64 hex chars
  const txByte = (0x60 + index).toString(16).padStart(2, "0");
  const txid = txByte.repeat(32);

  // Minimal legacy raw transaction paying 15_000 sats to this script.
  // value: 15_000 = 0x3A98 → LE uint64: 98 3a 00 00 00 00 00 00
  const rawTxHex =
    "01000000" +          // version: 1 (LE)
    "01" +                // 1 input
    "00".repeat(32) +     // prevhash: 32 zero bytes
    "ffffffff" +          // previndex
    "00" +                // input script length = 0
    "ffffffff" +          // sequence
    "01" +                // 1 output
    "983a000000000000" +  // value: 15 000 sats (LE uint64)
    "16" +                // output script length: 22 bytes
    scriptHex +           // P2WPKH output script (22 bytes)
    "00000000";           // locktime

  return { id, label, address, scripthash, scriptHex, txid, rawTxHex };
}

const FIXTURES: AddressFixture[] = Array.from({ length: NUM_ADDRESSES }, (_, i) => makeFixture(i));

// ── Mock Electrum TCP server ──────────────────────────────────────────────────

let mockServer!: net.Server;
let serverPort!: number;
const activeClientSockets = new Set<net.Socket>();

/**
 * Number of TCP connections the server has accepted.
 * Connection #1 = initial connect (delays subscribe responses after the first one).
 * Connection #2+ = new client after reloadMonitor() (responds normally).
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

      // Count blockchain.scripthash.subscribe calls on this specific connection.
      let subscribeCount = 0;

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
            handleRequest(socket, msg, thisConn, () => ++subscribeCount);
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
  incrementSubscribeCount: () => number,
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

    case "blockchain.scripthash.subscribe": {
      const count = incrementSubscribeCount();
      const doRespond = () => respond(socket, id, "status-reload-mid-v1");

      if (connectionNumber === 1 && count >= 2) {
        // Delay subscribe responses #2 and beyond on the first connection by 300 ms.
        // This creates the window for reloadMonitor() to be called while the old
        // subscribeAllAddresses is blocked waiting for subscribe response #2.
        setTimeout(doRespond, 300);
      } else {
        // First subscribe on connection #1, or any subscribe on connection #2+: respond fast.
        doRespond();
      }
      break;
    }

    case "blockchain.scripthash.get_history": {
      const scripthash = (params as string[])[0];
      const fixture = FIXTURES.find((f) => f.scripthash === scripthash);
      respond(socket, id, fixture ? [{ tx_hash: fixture.txid, height: 800_000 }] : []);
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

async function waitForAllAlerts(timeoutMs = 12_000): Promise<Map<string, number>> {
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
  // Return whatever is present so assertions can include diagnostic info.
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
  // Short reconnect delay keeps the test fast; 100 ms is enough for the race window.
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
  "all addresses remain subscribed on the new client when reloadMonitor() fires mid-subscribeAllAddresses",
  async () => {
    // ── Step 1: initial connect — subscribeAllAddresses starts ────────────────
    // address[0] subscribe arrives immediately (fast path on conn #1).
    // address[1] subscribe is delayed 300 ms by the server.
    await initMonitor();

    // ── Step 2: wait for address[0] to finish, but NOT address[1] ────────────
    // 80 ms: enough for address[0]'s subscribe + getHistory + getTransaction to complete,
    // but well before the server's 300 ms delay for address[1] elapses.
    await sleep(80);

    // ── Step 3: call reloadMonitor() while the old client is mid-iteration ───
    // This destroys the old ElectrumClient:
    //   - The pending subscribeScripthash RPC for address[1] rejects ("Client destroyed").
    //   - The catch block in subscribeAllAddresses(oldClient) logs a warning and continues.
    //   - address[2] also fails (client already destroyed before it is attempted).
    // reloadMonitor() then creates a fresh ElectrumClient (connection #2) and connects it.
    // On "connected", subscribeAllAddresses(newClient) is called, which reads ALL addresses
    // from the DB — ensuring address[1] and address[2] are not lost.
    await reloadMonitor();

    // ── Step 4: wait for all alert_events rows to appear ────────────────────
    // subscribeAllAddresses(newClient) runs asynchronously after reloadMonitor() returns,
    // so we poll until all 3 alert rows are present.
    const alertCounts = await waitForAllAlerts(12_000);

    // ── Step 5: assert no address was silently dropped ────────────────────────
    for (const f of FIXTURES) {
      const count = alertCounts.get(f.id) ?? 0;
      assert.ok(
        count >= 1,
        `Expected at least 1 alert_events row for "${f.label}" (addressId: ${f.id}) ` +
          `after reloadMonitor() fired mid-subscribeAllAddresses, but found ${count}. ` +
          `This address was silently dropped when the old ElectrumClient was replaced.`,
      );
    }

    // ── Step 6: assert all addresses are tracked by the new client ───────────
    // subscribeAllAddresses reads from the DB (not from the old Set), so all 3 addresses
    // must appear in the new client's subscriptions Set.
    const newClient = getElectrumClient();
    assert.ok(newClient !== null, "A new ElectrumClient should exist after reloadMonitor()");

    const subCount = newClient!.subscriptionCount;
    assert.ok(
      subCount >= NUM_ADDRESSES,
      `Expected the new ElectrumClient to have >= ${NUM_ADDRESSES} subscriptions after ` +
        `reloadMonitor() replaced the old client mid-subscribeAllAddresses, but got ${subCount}. ` +
        `Some addresses were left in the old (destroyed) client's Set and never re-subscribed.`,
    );
  },
);
