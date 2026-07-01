/**
 * Integration test: catchUpAllAddresses outer throw does not permanently skip any address.
 *
 * The bug scenario:
 *   The per-address try/catch inside catchUpAllAddresses only protects errors thrown by
 *   processScripthashHistory. If an unexpected error (e.g. a DB query failure) occurs
 *   BEFORE the loop — specifically in the `db.select().from(watchedAddresses)` call at the
 *   top of catchUpAllAddresses — the error escapes the for-loop entirely and is caught by
 *   the outer try/catch in the "reconnected" event handler.  The handler logs it and moves
 *   on, leaving every address unprocessed.  There must be a guarantee that the next
 *   "reconnected" event retries all of them.
 *
 * Flow:
 *  1. Start a mock Electrum TCP server that always reports non-null subscribe status and
 *     returns history for each watched address.
 *  2. Seed 3 watched addresses + settings pointing to the mock server.
 *  3. Call initMonitor() → initial connection → subscribeAllAddresses processes history →
 *     3 alert_events rows created (one per address).
 *  4. Delete the alert rows so the retry starts from a clean slate.
 *  5. Monkey-patch db.select to throw exactly once, simulating an unexpected DB failure
 *     that propagates out of the for-loop in catchUpAllAddresses.
 *  6. Emit "reconnected" on the live ElectrumClient.
 *     → catchUpAllAddresses(client) is called.
 *     → db.select().from(watchedAddresses) throws (patched).
 *     → The throw escapes the for-loop.
 *     → The outer catch in the "reconnected" handler logs it and swallows it.
 *     → 0 addresses were processed during this reconnect.
 *  7. Restore db.select to the real implementation.
 *  8. Assert the monitor is still in a good state: getNodeStatus().connected === true.
 *  9. Emit "reconnected" again → catchUpAllAddresses runs normally.
 *     → All 3 addresses are retried and alert rows are inserted.
 * 10. Assert all 3 addresses have at least 1 alert_events row.
 *     No address was permanently lost due to the outer throw.
 */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import net from "net";
import crypto from "crypto";
import { db, watchedAddresses, alertEvents, appSettings } from "@workspace/db";
import { eq, inArray } from "drizzle-orm";
import { initMonitor, destroyMonitor, getElectrumClient, getNodeStatus } from "../monitor.js";

// ── Scripthash helpers ────────────────────────────────────────────────────────

function scriptToScripthash(scriptHex: string): string {
  const script = Buffer.from(scriptHex, "hex");
  const hash = crypto.createHash("sha256").update(script).digest();
  return Buffer.from(hash).reverse().toString("hex");
}

// 3 distinct P2WPKH scripts — witness programs differ in the last byte (0xF0–0xF2).
// Chosen to be far from all other tests' addresses to avoid DB collisions.
const NUM_ADDRESSES = 3;

interface AddressFixture {
  id: string;
  label: string;
  address: string;
  scripthash: string;
  txid: string;
  rawTxHex: string;
}

function makeFixture(index: number): AddressFixture {
  const lastByte = (0xf0 + index).toString(16).padStart(2, "0");
  const witnessProgram = "00000000000000000000000000000000000000" + lastByte;
  const scriptHex = "0014" + witnessProgram;
  const scripthash = scriptToScripthash(scriptHex);
  const id = `outer-throw-${index}-${crypto.randomUUID()}`;
  const label = `Outer Throw Test Address ${index}`;
  const address = `outer-throw-placeholder-${id}`;

  // Unique txid per address: repeat (0xA0 + index) byte 32 times → 64 hex chars
  const txByte = (0xa0 + index).toString(16).padStart(2, "00");
  const txid = txByte.repeat(32);

  // Minimal legacy raw transaction paying 30_000 sats to this script.
  // value: 30_000 = 0x7530 → LE uint64: 30 75 00 00 00 00 00 00
  const rawTxHex =
    "01000000" +         // version: 1 (LE)
    "01" +               // 1 input
    "00".repeat(32) +    // prevhash: 32 zero bytes
    "ffffffff" +         // previndex
    "00" +               // input script length = 0
    "ffffffff" +         // sequence
    "01" +               // 1 output
    "3075000000000000" + // value: 30 000 sats (LE uint64)
    "16" +               // output script length: 22 bytes
    scriptHex +          // P2WPKH output script (22 bytes)
    "00000000";          // locktime

  return { id, label, address, scripthash, txid, rawTxHex };
}

const FIXTURES: AddressFixture[] = Array.from({ length: NUM_ADDRESSES }, (_, i) => makeFixture(i));

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
      // Chain tip 800_001: a tx at height 800_000 has 2 confirmations ≥ threshold 1.
      respond(socket, id, { height: 800_001 });
      break;

    case "blockchain.scripthash.subscribe":
      // Always return non-null: history exists from the start.
      respond(socket, id, "status-outer-throw-v1");
      break;

    case "blockchain.scripthash.get_history": {
      const scripthash = (params as string[])[0];
      const fixture = FIXTURES.find((f) => f.scripthash === scripthash);
      if (fixture) {
        respond(socket, id, [{ tx_hash: fixture.txid, height: 800_000 }]);
      } else {
        respond(socket, id, []);
      }
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

async function waitForAllAlerts(timeoutMs = 8_000): Promise<Map<string, number>> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    let allFound = true;
    for (const f of FIXTURES) {
      const rows = await db
        .select()
        .from(alertEvents)
        .where(eq(alertEvents.addressId, f.id));
      if (rows.length === 0) {
        allFound = false;
        break;
      }
    }
    if (allFound) break;
    await sleep(150);
  }
  // Collect final counts regardless of timeout.
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
  "all addresses are retried on next reconnect when catchUpAllAddresses itself throws unexpectedly",
  async () => {
    // ── Step 1: initial connect — history available from the start ─────────────
    // subscribeAllAddresses processes history for all 3 addresses and inserts rows.
    await initMonitor();

    // Wait for the initial subscribeAllAddresses to settle and create alert rows.
    const initialCounts = await waitForAllAlerts(8_000);
    for (const f of FIXTURES) {
      const count = initialCounts.get(f.id) ?? 0;
      assert.ok(
        count >= 1,
        `Expected at least 1 alert_events row for "${f.label}" after initial connect, ` +
          `but found ${count}. The mock server always returns non-null subscribe status.`,
      );
    }

    // ── Step 2: delete all alert rows — clean slate for the retry test ─────────
    const ids = FIXTURES.map((f) => f.id);
    await db.delete(alertEvents).where(inArray(alertEvents.addressId, ids));

    for (const f of FIXTURES) {
      const rows = await db
        .select()
        .from(alertEvents)
        .where(eq(alertEvents.addressId, f.id));
      assert.equal(
        rows.length,
        0,
        `alert_events must be empty for "${f.label}" before the outer-throw reconnect`,
      );
    }

    // ── Step 3: patch db.select to throw exactly once ──────────────────────────
    // The FIRST db.select() call inside catchUpAllAddresses is
    //   `db.select().from(watchedAddresses)`
    // at the top of the function, BEFORE the per-address for-loop.  If this throws,
    // the error escapes the loop and is caught by the outer try/catch in the
    // "reconnected" handler — which logs it and swallows it, leaving 0 addresses
    // processed.  The next "reconnected" event must retry all of them.
    let shouldFailOnce = true;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const origSelect = (db as any).select;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (db as any).select = function (this: unknown, ...args: unknown[]) {
      if (shouldFailOnce) {
        shouldFailOnce = false;
        throw new Error("Simulated unexpected DB failure in catchUpAllAddresses");
      }
      return origSelect.apply(this, args);
    };

    // ── Step 4: emit "reconnected" — the outer throw scenario ─────────────────
    // catchUpAllAddresses(client) → db.select() throws → error escapes for-loop →
    // outer catch in "reconnected" handler catches, logs, and swallows it.
    // 0 addresses are processed during this reconnect.
    const client = getElectrumClient();
    assert.ok(client !== null, "ElectrumClient must be active before emitting reconnected");

    client!.emit("reconnected");

    // Allow the async reconnected handler to run to completion (it awaits
    // catchUpAllAddresses, which throws immediately, so 100 ms is generous).
    await sleep(300);

    // ── Step 5: restore db.select ──────────────────────────────────────────────
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (db as any).select = origSelect;

    // ── Step 6: confirm no alert rows were inserted during the failed reconnect ─
    for (const f of FIXTURES) {
      const rows = await db
        .select()
        .from(alertEvents)
        .where(eq(alertEvents.addressId, f.id));
      assert.equal(
        rows.length,
        0,
        `Expected 0 alert_events rows for "${f.label}" immediately after the outer-throw ` +
          `reconnect (the DB failure aborted catchUpAllAddresses before any address was ` +
          `processed), but found ${rows.length}.`,
      );
    }

    // ── Step 7: confirm the monitor is not in a bad state ─────────────────────
    // The "reconnected" handler sets nodeStatus.connected = true at its very start,
    // before calling catchUpAllAddresses.  The outer catch must not interfere with
    // that status — the monitor must remain usable for subsequent reconnects.
    const status = getNodeStatus();
    assert.equal(
      status.connected,
      true,
      `Monitor must remain connected after the outer-throw reconnect (nodeStatus.connected ` +
        `is set before catchUpAllAddresses is called, so a DB failure inside it must not ` +
        `flip the connection status to false).`,
    );

    // ── Step 8: emit "reconnected" again — normal retry ───────────────────────
    // Now db.select works normally.  catchUpAllAddresses processes all 3 addresses.
    // Each address has no existing alert row → processScripthashHistory inserts one.
    client!.emit("reconnected");

    // ── Step 9: wait for all 3 alert rows to appear ───────────────────────────
    const alertCounts = await waitForAllAlerts(8_000);

    // ── Step 10: assertions ───────────────────────────────────────────────────
    for (const f of FIXTURES) {
      const count = alertCounts.get(f.id) ?? 0;
      assert.ok(
        count >= 1,
        `Expected at least 1 alert_events row for "${f.label}" (addressId: ${f.id}) ` +
          `after the successful retry reconnect, but found ${count}. ` +
          `This address was permanently skipped: the outer throw on the first reconnect ` +
          `prevented it from being processed, and the second reconnect did not retry it.`,
      );
    }
  },
);
