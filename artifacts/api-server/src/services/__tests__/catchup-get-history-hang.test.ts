/**
 * Integration test: a hanging get_history does not stall catchUpAllAddresses forever.
 *
 * Flow:
 *  1. Start a mock Electrum TCP server that accepts connections and handles most
 *     requests normally, but *never* responds to get_history for address #0.
 *  2. Seed 3 watched addresses + settings pointing to the mock server.
 *  3. Call initMonitor() → initial connection → subscribeAllAddresses → null status
 *     (no history yet) → no alert rows.
 *  4. Simulate an outage (destroy all active client sockets).
 *  5. Inject history for all 3 addresses so the reconnect triggers catch-up.
 *  6. After reconnect, catchUpAllAddresses iterates all 3 addresses:
 *       - addr[0]: get_history hangs → RPC timeout fires → per-address catch block
 *                  logs a warning and moves on
 *       - addr[1]: get_history responds normally → alert row inserted
 *       - addr[2]: get_history responds normally → alert row inserted
 *  7. Assert: addresses #1 and #2 each have at least 1 alert_events row, confirming
 *     that the hang on address #0 did not permanently stall the loop.
 */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import net from "net";
import crypto from "crypto";
import { db, watchedAddresses, alertEvents, appSettings } from "@workspace/db";
import { eq, inArray } from "drizzle-orm";
import { initMonitor, destroyMonitor } from "../monitor.js";

const RPC_TIMEOUT_MS = 800;

function scriptToScripthash(scriptHex: string): string {
  const script = Buffer.from(scriptHex, "hex");
  const hash = crypto.createHash("sha256").update(script).digest();
  return Buffer.from(hash).reverse().toString("hex");
}

interface AddressFixture {
  id: string;
  label: string;
  address: string;
  scripthash: string;
  txid: string;
  rawTxHex: string;
}

function makeFixture(index: number): AddressFixture {
  const lastByte = (0xa0 + index).toString(16).padStart(2, "0");
  const witnessProgram = "00000000000000000000000000000000000000" + lastByte;
  const scriptHex = "0014" + witnessProgram;
  const scripthash = scriptToScripthash(scriptHex);
  const id = `hang-test-${index}-${crypto.randomUUID()}`;
  const label = `Hang Test Address ${index}`;
  const address = `hang-test-placeholder-${id}`;

  const txByte = (0xb0 + index).toString(16).padStart(2, "00");
  const txid = txByte.repeat(32);

  const rawTxHex =
    "01000000" +
    "01" +
    "00".repeat(32) +
    "ffffffff" +
    "00" +
    "ffffffff" +
    "01" +
    "204e000000000000" +
    "16" +
    scriptHex +
    "00000000";

  return { id, label, address, scripthash, txid, rawTxHex };
}

const FIXTURES: AddressFixture[] = Array.from({ length: 3 }, (_, i) => makeFixture(i));

let mockServer!: net.Server;
let serverPort!: number;
const activeClientSockets = new Set<net.Socket>();

let mockHistory: Map<string, Array<{ tx_hash: string; height: number }>> = new Map();

function respond(socket: net.Socket, id: number, result: unknown): void {
  socket.write(JSON.stringify({ id, result }) + "\n");
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
      respond(socket, id, mockHistory.size > 0 ? "status-hang-test-v1" : null);
      break;

    case "blockchain.scripthash.get_history": {
      const scripthash = (params as string[])[0];

      if (scripthash === FIXTURES[0]!.scripthash) {
        return;
      }

      const history = mockHistory.get(scripthash!) ?? [];
      respond(socket, id, history);
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

function simulateOutage(): void {
  for (const socket of activeClientSockets) {
    socket.destroy();
  }
}

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

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitForAlerts(
  addressIds: string[],
  timeoutMs: number,
): Promise<Map<string, number>> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const counts = new Map<string, number>();
    let allFound = true;
    for (const id of addressIds) {
      const rows = await db
        .select()
        .from(alertEvents)
        .where(eq(alertEvents.addressId, id));
      counts.set(id, rows.length);
      if (rows.length === 0) allFound = false;
    }
    if (allFound) return counts;
    await sleep(200);
  }
  const counts = new Map<string, number>();
  for (const id of addressIds) {
    const rows = await db
      .select()
      .from(alertEvents)
      .where(eq(alertEvents.addressId, id));
    counts.set(id, rows.length);
  }
  return counts;
}

before(async () => {
  process.env.ELECTRUM_RECONNECT_DELAY_MS = "100";
  process.env.ELECTRUM_RPC_TIMEOUT_MS = String(RPC_TIMEOUT_MS);
  await startMockServer();
  await seedTestData();
});

after(async () => {
  destroyMonitor();
  await new Promise<void>((r) => mockServer.close(() => r()));
  await cleanupTestData();
  delete process.env.ELECTRUM_RECONNECT_DELAY_MS;
  delete process.env.ELECTRUM_RPC_TIMEOUT_MS;
});

test(
  "hanging get_history for address #0 does not block addresses #1 and #2 from being processed",
  async () => {
    await initMonitor();

    await sleep(400);

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

    simulateOutage();

    for (const f of FIXTURES) {
      mockHistory.set(f.scripthash, [{ tx_hash: f.txid, height: 800_000 }]);
    }

    const nonHangingIds = [FIXTURES[1]!.id, FIXTURES[2]!.id];
    const waitMs = RPC_TIMEOUT_MS * 2 + 5_000;
    const alertCounts = await waitForAlerts(nonHangingIds, waitMs);

    assert.ok(
      (alertCounts.get(FIXTURES[1]!.id) ?? 0) >= 1,
      `Expected at least 1 alert_events row for "${FIXTURES[1]!.label}" but found ` +
        `${alertCounts.get(FIXTURES[1]!.id) ?? 0}. ` +
        `The hanging get_history for address #0 should not have blocked address #1.`,
    );

    assert.ok(
      (alertCounts.get(FIXTURES[2]!.id) ?? 0) >= 1,
      `Expected at least 1 alert_events row for "${FIXTURES[2]!.label}" but found ` +
        `${alertCounts.get(FIXTURES[2]!.id) ?? 0}. ` +
        `The hanging get_history for address #0 should not have blocked address #2.`,
    );
  },
);
