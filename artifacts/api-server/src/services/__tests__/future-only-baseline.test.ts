/**
 * Integration test: "future-only" baseline behaviour.
 *
 * Guarantees exercised:
 *  1. On the first catch-up of a future-only address, its existing history is
 *     recorded silently (rows flagged baselined=true, no alert) — nothing surfaces
 *     as a real event.
 *  2. A genuinely new transaction that arrives after the baseline DOES alert
 *     normally (baselined=false, real amount).
 *  3. A transaction that was already in the mempool at baseline time must NEVER
 *     fire a "confirmed" alert when it later confirms — it stays a silent
 *     baselined row.
 *
 * A single mock Electrum server drives two watched addresses (both watchMode
 * "future"): ADDR1 covers guarantees 1 & 2, ADDR2 covers guarantee 3.
 */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import net from "net";
import crypto from "crypto";
import { db, watchedAddresses, alertEvents, appSettings } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { initMonitor, destroyMonitor } from "../monitor.js";

// ── Scripthash + raw-tx helpers ───────────────────────────────────────────────

function scriptToScripthash(scriptHex: string): string {
  const hash = crypto.createHash("sha256").update(Buffer.from(scriptHex, "hex")).digest();
  return Buffer.from(hash).reverse().toString("hex");
}

function valueToLeHex(sats: number): string {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(BigInt(sats));
  return buf.toString("hex");
}

/** Minimal legacy tx: one dummy input, one output paying `outputScriptHex` `sats`. */
function buildRawTx(outputScriptHex: string, sats: number): string {
  const scriptLen = (outputScriptHex.length / 2).toString(16).padStart(2, "0");
  return (
    "01000000" + // version
    "01" + // 1 input
    "0".repeat(64) + // prevhash
    "ffffffff" + // previndex
    "01" + "00" + // scriptLen=1, dummy script
    "ffffffff" + // sequence
    "01" + // 1 output
    valueToLeHex(sats) +
    scriptLen +
    outputScriptHex +
    "00000000" // locktime
  );
}

// Two distinct P2WPKH outputs → two distinct watched addresses.
const OUTPUT_SCRIPT_1 = "0014" + "00000000000000000000000000000000000000a1";
const OUTPUT_SCRIPT_2 = "0014" + "00000000000000000000000000000000000000a2";
const SCRIPTHASH_1 = scriptToScripthash(OUTPUT_SCRIPT_1);
const SCRIPTHASH_2 = scriptToScripthash(OUTPUT_SCRIPT_2);
const RAW_TX_1 = buildRawTx(OUTPUT_SCRIPT_1, 50_000);
const RAW_TX_2 = buildRawTx(OUTPUT_SCRIPT_2, 70_000);

const ADDR1_ID = `future-baseline-1-${crypto.randomUUID()}`;
const ADDR2_ID = `future-baseline-2-${crypto.randomUUID()}`;

// Txids present at baseline time
const TX_A = "aa".repeat(32); // ADDR1 pre-existing history → must be baselined
const TX_B = "bb".repeat(32); // ADDR1 new tx after baseline → must alert
const TX_C = "cc".repeat(32); // ADDR2 pre-existing mempool → baselined, must never confirm

const CHAIN_TIP = 800_010;
const CONFIRMED_HEIGHT = 800_000; // 11 confs at chain tip → meets threshold
const MEMPOOL_HEIGHT = 0;

// ── Mock Electrum server ──────────────────────────────────────────────────────

const historyByScripthash = new Map<string, Array<{ tx_hash: string; height: number }>>();
const rawByTxid = new Map<string, string>([
  [TX_A, RAW_TX_1],
  [TX_B, RAW_TX_1],
  [TX_C, RAW_TX_2],
]);

let mockServer!: net.Server;
let serverPort!: number;
const activeClientSockets = new Set<net.Socket>();

function respond(socket: net.Socket, id: number, result: unknown): void {
  socket.write(JSON.stringify({ id, result }) + "\n");
}

function handleRequest(socket: net.Socket, msg: { id: number; method: string; params: unknown[] }): void {
  const { id, method, params } = msg;
  switch (method) {
    case "server.ping":
      respond(socket, id, null);
      break;
    case "blockchain.headers.subscribe":
      respond(socket, id, { height: CHAIN_TIP });
      break;
    case "blockchain.scripthash.subscribe": {
      const sh = params[0] as string;
      const hist = historyByScripthash.get(sh) ?? [];
      respond(socket, id, hist.length > 0 ? `status-${sh.slice(0, 8)}` : null);
      break;
    }
    case "blockchain.scripthash.get_history": {
      const sh = params[0] as string;
      respond(socket, id, historyByScripthash.get(sh) ?? []);
      break;
    }
    case "blockchain.transaction.get": {
      const txid = params[0] as string;
      respond(socket, id, rawByTxid.get(txid) ?? "");
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
            handleRequest(socket, JSON.parse(line));
          } catch {
            // ignore malformed JSON
          }
        }
      });
    });
    mockServer.listen(0, "127.0.0.1", () => {
      serverPort = (mockServer.address() as net.AddressInfo).port;
      resolve();
    });
  });
}

function simulateOutage(): void {
  for (const socket of activeClientSockets) socket.destroy();
}

// ── DB helpers ────────────────────────────────────────────────────────────────

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
      set: { electrumHost: "127.0.0.1", electrumPort: serverPort, electrumTls: false, confirmationThreshold: 1 },
    });

  // Both addresses are future-only and start un-baselined.
  await db
    .insert(watchedAddresses)
    .values([
      { id: ADDR1_ID, label: "Future Baseline 1", address: `fb1-${ADDR1_ID}`, scripthash: SCRIPTHASH_1, watchMode: "future" },
      { id: ADDR2_ID, label: "Future Baseline 2", address: `fb2-${ADDR2_ID}`, scripthash: SCRIPTHASH_2, watchMode: "future" },
    ])
    .onConflictDoNothing();
}

async function cleanupTestData(): Promise<void> {
  await db.delete(alertEvents).where(eq(alertEvents.addressId, ADDR1_ID));
  await db.delete(alertEvents).where(eq(alertEvents.addressId, ADDR2_ID));
  await db.delete(watchedAddresses).where(eq(watchedAddresses.id, ADDR1_ID));
  await db.delete(watchedAddresses).where(eq(watchedAddresses.id, ADDR2_ID));
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

async function rowsFor(addressId: string) {
  return db.select().from(alertEvents).where(eq(alertEvents.addressId, addressId));
}

async function getRow(addressId: string, txid: string) {
  const [row] = await db
    .select()
    .from(alertEvents)
    .where(and(eq(alertEvents.addressId, addressId), eq(alertEvents.txid, txid)))
    .limit(1);
  return row ?? null;
}

async function waitForRow(addressId: string, txid: string, timeoutMs = 6_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const row = await getRow(addressId, txid);
    if (row) return row;
    await new Promise((r) => setTimeout(r, 150));
  }
  return null;
}

// ── Lifecycle ─────────────────────────────────────────────────────────────────

before(async () => {
  process.env.ELECTRUM_RECONNECT_DELAY_MS = "200";
  await startMockServer();
  // Pre-existing history present at add time:
  historyByScripthash.set(SCRIPTHASH_1, [{ tx_hash: TX_A, height: CONFIRMED_HEIGHT }]);
  historyByScripthash.set(SCRIPTHASH_2, [{ tx_hash: TX_C, height: MEMPOOL_HEIGHT }]);
  await seedTestData();
});

after(async () => {
  destroyMonitor();
  await new Promise<void>((resolve) => mockServer.close(() => resolve()));
  await cleanupTestData();
  delete process.env.ELECTRUM_RECONNECT_DELAY_MS;
});

// ── The test ──────────────────────────────────────────────────────────────────

test("future-only: existing history is baselined silently, new tx alerts, baselined mempool never confirms", async () => {
  // ── Phase 1: connect → both addresses baseline their pre-existing history ────
  await initMonitor();
  // Baseline of TX_A / TX_C is written during the connect handler.
  const baselineA = await waitForRow(ADDR1_ID, TX_A);
  const baselineC = await waitForRow(ADDR2_ID, TX_C);

  assert.ok(baselineA, "TX_A should be recorded as a baseline row");
  assert.equal(baselineA!.baselined, true, "TX_A must be flagged baselined (silent)");
  assert.equal(baselineA!.mempoolAlertedAt, null, "baseline row must never have alerted");
  assert.equal(baselineA!.confirmedAlertedAt, null, "baseline row must never have alerted");

  assert.ok(baselineC, "TX_C should be recorded as a baseline row");
  assert.equal(baselineC!.baselined, true, "TX_C must be flagged baselined (silent)");
  assert.equal(baselineC!.status, "mempool", "TX_C was in the mempool at baseline time");
  assert.equal(baselineC!.confirmedAlertedAt, null, "baselined mempool tx must not be confirmed-alerted");

  // No real (non-baselined) events exist yet for either address.
  const addr1RowsAfterBaseline = await rowsFor(ADDR1_ID);
  assert.equal(
    addr1RowsAfterBaseline.filter((r) => !r.baselined).length,
    0,
    "no genuine alert events should exist immediately after baseline",
  );

  // ── Phase 2: a new tx arrives for ADDR1; TX_C confirms for ADDR2 ─────────────
  historyByScripthash.set(SCRIPTHASH_1, [
    { tx_hash: TX_A, height: CONFIRMED_HEIGHT },
    { tx_hash: TX_B, height: CONFIRMED_HEIGHT },
  ]);
  historyByScripthash.set(SCRIPTHASH_2, [{ tx_hash: TX_C, height: CONFIRMED_HEIGHT }]);

  // Force a reconnect so catch-up re-processes both addresses.
  simulateOutage();

  // ── Phase 3: TX_B alerts for real; TX_C stays a silent baseline row ─────────
  const alertB = await waitForRow(ADDR1_ID, TX_B);
  assert.ok(alertB, "TX_B (new tx after baseline) should produce an alert row");
  assert.equal(alertB!.baselined, false, "TX_B must be a genuine alert, not baselined");
  assert.equal(alertB!.direction, "incoming", "TX_B pays our scripthash → incoming");
  assert.equal(alertB!.amountSats, 50_000, "TX_B output value should be 50 000 sats");

  // TX_A remains a silent baseline row (unchanged).
  const stillBaselineA = await getRow(ADDR1_ID, TX_A);
  assert.equal(stillBaselineA!.baselined, true, "TX_A must remain baselined");

  // Give the confirm path a moment, then assert TX_C never fired a confirmed alert.
  await new Promise((r) => setTimeout(r, 800));
  const stillBaselineC = await getRow(ADDR2_ID, TX_C);
  assert.equal(stillBaselineC!.baselined, true, "TX_C must remain baselined after it confirmed");
  assert.equal(
    stillBaselineC!.confirmedAlertedAt,
    null,
    "a baselined mempool tx must NEVER fire a confirmed alert when it later confirms",
  );
  const addr2Rows = await rowsFor(ADDR2_ID);
  assert.equal(addr2Rows.length, 1, "ADDR2 should have exactly one (baselined) row, no new alert");
});
