/**
 * Focused integration test: concurrent reconnect catch-up and notification-handler
 * processScripthashHistory calls race to upgrade the same "mempool" row to "confirmed".
 *
 * Scenario:
 *  When the chain tip advances while a slow reconnect catch-up is in progress,
 *  catchUpAllAddresses (path A) and the subscription notification handler (path B)
 *  can both call processScripthashHistory for the same txid that is already stored
 *  as status="mempool". Without a guard, both would read "mempool", both would UPDATE
 *  to "confirmed", and both would fire an XMPP alert — producing a duplicate alert.
 *
 * Fix under test:
 *  The "existing row / upgrade" branch uses:
 *    .where(and(eq(alertEvents.id, evt.id), eq(alertEvents.status, "mempool")))
 *    .returning({ id: alertEvents.id })
 *  so only the concurrent call whose UPDATE actually transitions the row (i.e. returns
 *  a non-empty result) proceeds to send the alert. The losing call gets 0 rows back
 *  and skips the alert entirely.
 *
 * Synchronization (rendezvous barrier):
 *  getHistory is called inside processScripthashHistory after loading settings but
 *  before the alertEvents SELECT. The mock client uses a rendezvous barrier: the
 *  first call blocks inside getHistory until the second call also arrives. Both then
 *  return simultaneously, so both paths proceed to their alertEvents SELECT at the
 *  same instant — guaranteeing both read "mempool" before either UPDATE fires.
 *
 * Assertions:
 *  - Both getHistory calls were made (rendezvous was hit).
 *  - Exactly one alert_events row exists (no duplicate rows).
 *  - Row status is "confirmed" and confirmedAlertedAt is set (non-null).
 *  - _getAlertSendAttempts() == 1  (exactly one UPDATE winner reached sendTransactionAlert).
 *  - xmppSendCount for confirmed alerts == 1.
 */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "crypto";
import { db, watchedAddresses, alertEvents, appSettings } from "@workspace/db";
import { eq, and, count } from "drizzle-orm";
import {
  processScripthashHistory,
  getXmpp,
  _getAlertSendAttempts,
  _resetAlertSendAttempts,
} from "../monitor.js";
import type { ElectrumClient } from "../electrum.js";

// ── Scripthash helpers ────────────────────────────────────────────────────────

function scriptToScripthash(scriptHex: string): string {
  const script = Buffer.from(scriptHex, "hex");
  const hash = crypto.createHash("sha256").update(script).digest();
  return Buffer.from(hash).reverse().toString("hex");
}

// Unique 20-byte witness program (byte 0x99) — does not collide with other tests.
const WITNESS_PROGRAM_HEX = "0000000000000000000000000000000000000099";
const OUTPUT_SCRIPT_HEX = "0014" + WITNESS_PROGRAM_HEX;
const TEST_SCRIPTHASH = scriptToScripthash(OUTPUT_SCRIPT_HEX);

const TEST_ADDR_ID = `catchup-mempool-race-${crypto.randomUUID()}`;
const TEST_ADDRESS_LABEL = "Test Catchup-Mempool Race";
const TEST_TXID = "ab".repeat(32); // 64 hex chars, unique

// chain tip and tx height configured so threshold=1 is met
const TX_BLOCK_HEIGHT = 800_000;
const CHAIN_TIP_HEIGHT = 800_001; // 2 confirmations ≥ threshold 1

// ── Mock ElectrumClient ───────────────────────────────────────────────────────

/**
 * Rendezvous barrier: ensures both concurrent getHistory calls arrive before
 * either one returns. This guarantees both paths reach their alertEvents SELECT
 * simultaneously — so both read status="mempool" before either UPDATE fires,
 * creating a deterministic race on the UPDATE.
 */
function makeRendezvousBarrier(expectedCount: number): {
  wait: () => Promise<void>;
  arrivedCount: () => number;
} {
  let arrived = 0;
  let resolve!: () => void;
  const gate = new Promise<void>((r) => { resolve = r; });
  return {
    wait: () => {
      arrived++;
      if (arrived >= expectedCount) resolve();
      return gate;
    },
    arrivedCount: () => arrived,
  };
}

let barrier = makeRendezvousBarrier(2);

/**
 * Returns a minimal duck-typed ElectrumClient mock.
 * processScripthashHistory only uses blockHeight and getHistory in the
 * "existing row / upgrade" branch (no raw-tx decode for pre-seeded rows).
 *
 * Both concurrent calls block inside getHistory until both have arrived,
 * then both proceed simultaneously toward their alertEvents SELECT + UPDATE.
 */
function makeMockClient(): ElectrumClient {
  return {
    blockHeight: CHAIN_TIP_HEIGHT,
    async getHistory(_scripthash: string) {
      await barrier.wait();
      return [{ tx_hash: TEST_TXID, height: TX_BLOCK_HEIGHT }];
    },
  } as unknown as ElectrumClient;
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
      electrumPort: 50001,
      electrumTls: false,
      confirmationThreshold: 1,
    })
    .onConflictDoUpdate({
      target: appSettings.id,
      set: {
        electrumHost: "127.0.0.1",
        electrumPort: 50001,
        electrumTls: false,
        confirmationThreshold: 1,
      },
    });

  await db
    .insert(watchedAddresses)
    .values({
      id: TEST_ADDR_ID,
      label: TEST_ADDRESS_LABEL,
      address: `test-placeholder-catchup-race-${TEST_ADDR_ID}`,
      scripthash: TEST_SCRIPTHASH,
    })
    .onConflictDoNothing();

  // Pre-seed a "mempool" alert_events row — simulating a transaction that was
  // seen as unconfirmed before the node went offline. During the reconnect,
  // two concurrent processScripthashHistory calls will race to upgrade this
  // row to "confirmed". Only one should win and fire an XMPP alert.
  await db
    .insert(alertEvents)
    .values({
      id: crypto.randomUUID(),
      addressId: TEST_ADDR_ID,
      txid: TEST_TXID,
      direction: "incoming",
      amountSats: 50_000,
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

// ── XMPP patch state ──────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyRecord = Record<string, any>;
let xmppOriginals: {
  isConfigured: unknown;
  isConnected: unknown;
  sendAlert: unknown;
} | null = null;

// ── Lifecycle hooks ───────────────────────────────────────────────────────────

before(async () => {
  await seedTestData();
});

after(async () => {
  // Restore XMPP singleton so other test suites are unaffected.
  if (xmppOriginals !== null) {
    const xmpp = getXmpp() as unknown as AnyRecord;
    xmpp["isConfigured"] = xmppOriginals.isConfigured;
    xmpp["isConnected"] = xmppOriginals.isConnected;
    xmpp["sendAlert"] = xmppOriginals.sendAlert;
    xmppOriginals = null;
  }
  await cleanupTestData();
});

// ── The test ──────────────────────────────────────────────────────────────────

test(
  "concurrent catch-up and notification paths racing on the same mempool tx produce exactly one confirmed row and exactly one XMPP send",
  async () => {
    // ── Patch XMPP to count alert sends ─────────────────────────────────────
    // Replace isConfigured/isConnected/sendAlert so sendTransactionAlert flows
    // all the way to sendAlert without a real XMPP connection.
    // Connection-status alerts use sendConnectionAlert — a separate method —
    // so no txid filtering is needed here.
    let xmppSendCount = 0;
    const xmppSvc = getXmpp() as unknown as AnyRecord;
    xmppOriginals = {
      isConfigured: xmppSvc["isConfigured"],
      isConnected: xmppSvc["isConnected"],
      sendAlert: xmppSvc["sendAlert"],
    };
    xmppSvc["isConfigured"] = () => true;
    xmppSvc["isConnected"] = () => true;
    xmppSvc["sendAlert"] = async (_msg: string) => {
      xmppSendCount++;
    };

    // Reset the module-level alert-attempt counter so we can assert exactly
    // how many times sendTransactionAlert was reached for this txid.
    _resetAlertSendAttempts();

    // ── Verify pre-condition: row starts as "mempool" ────────────────────────
    const [initialRow] = await db
      .select()
      .from(alertEvents)
      .where(and(eq(alertEvents.addressId, TEST_ADDR_ID), eq(alertEvents.txid, TEST_TXID)))
      .limit(1);

    assert.equal(
      initialRow?.status,
      "mempool",
      "Pre-seeded row must start as 'mempool' before the race",
    );
    assert.equal(
      initialRow?.confirmedAlertedAt,
      null,
      "confirmedAlertedAt must be null before the race",
    );

    // ── Fire two concurrent processScripthashHistory calls ───────────────────
    // Path A: simulates catchUpAllAddresses (reconnect catch-up)
    // Path B: simulates the notification handler (subscription status callback)
    //
    // The mock client's rendezvous barrier holds both calls inside getHistory
    // until both have arrived. Both then return simultaneously, so both paths
    // proceed to their alertEvents SELECT at the same instant — guaranteeing
    // both read status="mempool" before either UPDATE fires.
    barrier = makeRendezvousBarrier(2);
    const mockClient = makeMockClient();

    await Promise.all([
      processScripthashHistory(TEST_SCRIPTHASH, mockClient), // path A
      processScripthashHistory(TEST_SCRIPTHASH, mockClient), // path B
    ]);

    // ── Assert both paths hit the barrier (race was actually exercised) ──────
    assert.equal(
      barrier.arrivedCount(),
      2,
      "Both concurrent paths must have called getHistory — the rendezvous barrier " +
        "ensures both read 'mempool' before either UPDATE fires.",
    );

    // ── Assert exactly one alert_events row (no duplicate rows) ─────────────
    const [{ n: rowCount }] = await db
      .select({ n: count() })
      .from(alertEvents)
      .where(and(eq(alertEvents.addressId, TEST_ADDR_ID), eq(alertEvents.txid, TEST_TXID)));

    assert.equal(
      rowCount,
      1,
      `Expected exactly 1 alert_events row for txid ${TEST_TXID} after the concurrent ` +
        `race, but found ${rowCount}. The unique index must prevent duplicate rows.`,
    );

    // ── Assert row was upgraded to "confirmed" ────────────────────────────────
    const [afterRow] = await db
      .select()
      .from(alertEvents)
      .where(and(eq(alertEvents.addressId, TEST_ADDR_ID), eq(alertEvents.txid, TEST_TXID)))
      .limit(1);

    assert.equal(
      afterRow?.status,
      "confirmed",
      `Row must be upgraded to 'confirmed' after the race, but got '${afterRow?.status}'`,
    );

    // ── Assert confirmedAlertedAt was set exactly once ────────────────────────
    assert.ok(
      afterRow?.confirmedAlertedAt !== null && afterRow?.confirmedAlertedAt !== undefined,
      "confirmedAlertedAt must be set (non-null) after the mempool→confirmed upgrade",
    );

    // ── Assert exactly one UPDATE reached sendTransactionAlert ───────────────
    // _getAlertSendAttempts() increments inside sendTransactionAlert, which is
    // only called when the conditional UPDATE returns a non-empty .returning()
    // result. This directly counts how many times the UPDATE winner path ran.
    const alertAttempts = _getAlertSendAttempts();
    assert.equal(
      alertAttempts,
      1,
      `Expected exactly 1 sendTransactionAlert call (one UPDATE winner), but got ` +
        `${alertAttempts}. The WHERE status='mempool' + .returning() guard must ensure ` +
        `only the concurrent path that actually transitions the row sends the alert.`,
    );

    // ── Assert exactly one XMPP confirmed alert was sent ─────────────────────
    assert.equal(
      xmppSendCount,
      1,
      `Expected exactly 1 XMPP confirmed alert, but sendAlert was called ` +
        `${xmppSendCount} time(s). The conditional UPDATE guard must prevent ` +
        `the losing concurrent path from firing a duplicate alert.`,
    );
  },
);
