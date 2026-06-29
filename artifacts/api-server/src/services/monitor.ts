import crypto from "crypto";
import { db } from "@workspace/db";
import { watchedAddresses, appSettings, alertEvents } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { ElectrumClient } from "./electrum.js";
import { XmppService } from "./xmpp.js";
import { decodeRawTx } from "./bitcoin.js";
import { resolveOutgoingAmountSats } from "./outgoing.js";
import { logger } from "../lib/logger.js";

interface NodeStatus {
  connected: boolean;
  blockHeight: number | null;
  message: string | null;
  lastCheckedAt: Date | null;
}

let electrum: ElectrumClient | null = null;
const xmpp = new XmppService();

/** Counts every call to sendTransactionAlert regardless of XMPP connectivity. Exposed for testing. */
let _alertSendAttempts = 0;
export function _getAlertSendAttempts(): number { return _alertSendAttempts; }
export function _resetAlertSendAttempts(): void { _alertSendAttempts = 0; }
let nodeStatus: NodeStatus = {
  connected: false,
  blockHeight: null,
  message: "Not initialized",
  lastCheckedAt: null,
};

export function getNodeStatus(): NodeStatus {
  return { ...nodeStatus };
}

/** Returns the active ElectrumClient instance, or null if not initialized. Exposed for testing. */
export function getElectrumClient(): ElectrumClient | null {
  return electrum;
}

export function getXmpp(): XmppService {
  return xmpp;
}

export async function initMonitor() {
  try {
    await loadSettingsAndConnect();
  } catch (err) {
    logger.error({ err }, "[monitor] Failed to initialize");
  }
}

async function loadSettingsAndConnect() {
  const [settings] = await db.select().from(appSettings).limit(1);
  if (!settings) {
    await db.insert(appSettings).values({ id: 1 }).onConflictDoNothing();
    return;
  }

  // Setup XMPP
  if (settings.xmppJid && settings.xmppPassword && settings.xmppServer && settings.recipientJid) {
    xmpp.configure({
      server: settings.xmppServer,
      port: settings.xmppPort,
      jid: settings.xmppJid,
      password: settings.xmppPassword,
      tls: settings.xmppTls,
      recipientJid: settings.recipientJid,
    });
    xmpp.connect().catch((err) => {
      logger.warn({ err }, "[monitor] XMPP connect failed");
    });
  }

  // Setup Electrum
  if (electrum) {
    electrum.destroy();
    electrum = null;
  }

  const reconnectDelayMs = process.env.ELECTRUM_RECONNECT_DELAY_MS
    ? parseInt(process.env.ELECTRUM_RECONNECT_DELAY_MS, 10)
    : 10_000;
  const client = new ElectrumClient(
    settings.electrumHost,
    settings.electrumPort,
    settings.electrumTls,
    reconnectDelayMs,
    settings.electrumAllowSelfSigned,
  );

  // Swallow socket errors so they don't crash the process; reconnect handles recovery
  client.on("error", (err: Error) => {
    logger.warn({ err: err.message }, "[monitor] Electrum socket error");
  });

  client.on("connected", async () => {
    logger.info("[monitor] Electrum connected");
    nodeStatus = { connected: true, blockHeight: null, message: null, lastCheckedAt: new Date() };

    try {
      const header = await client.subscribeHeaders();
      nodeStatus.blockHeight = header.height;
      nodeStatus.lastCheckedAt = new Date();
    } catch (err) {
      logger.warn({ err }, "[monitor] subscribeHeaders failed");
    }

    // Subscribe all addresses and catch up on any missed transactions
    await subscribeAllAddresses(client);

    if (xmpp.isConfigured() && xmpp.isConnected()) {
      xmpp.sendConnectionAlert("Watchtower: Node connection restored.").catch(() => {});
    }
  });

  client.on("disconnected", () => {
    logger.warn("[monitor] Electrum disconnected");
    nodeStatus = {
      connected: false,
      blockHeight: null,
      message: "Disconnected from node",
      lastCheckedAt: new Date(),
    };
    if (xmpp.isConfigured() && xmpp.isConnected()) {
      xmpp.sendConnectionAlert("WARNING Watchtower: Lost connection to Bitcoin node.").catch(() => {});
    }
  });

  client.on("reconnected", async () => {
    nodeStatus = { connected: true, blockHeight: client.blockHeight, message: null, lastCheckedAt: new Date() };
    logger.info("[monitor] Electrum reconnected — scanning for missed transactions");
    try {
      await catchUpAllAddresses(client);
    } catch (err) {
      logger.error({ err }, "[monitor] Reconnect catch-up failed");
    }
  });

  client.on("blockHeight", (height: number) => {
    nodeStatus.blockHeight = height;
    nodeStatus.lastCheckedAt = new Date();
  });

  // Notification handler: fires both on live events and on reconnect catch-up
  client.setNotificationHandler((scripthash, status) => {
    if (status !== null) {
      // status is a hash of the full history — any non-null value means activity to process
      processScripthashHistory(scripthash, client).catch((err) => {
        logger.error({ err, scripthash }, "[monitor] history processing failed");
      });
    }
  });

  try {
    await client.connect();
    electrum = client;
  } catch (err) {
    logger.error({ err }, "[monitor] Electrum initial connect failed — will retry");
    nodeStatus = {
      connected: false,
      blockHeight: null,
      message: `Connection failed: ${(err as Error).message}`,
      lastCheckedAt: new Date(),
    };
    // client is kept; it will auto-reconnect via its internal timer
    electrum = client;
  }
}

/**
 * After reconnecting, fetch and process history for every watched address.
 * Uses processScripthashHistory which deduplicates against alert_events,
 * so it is safe to call even if subscribeAllAddresses already ran.
 */
async function catchUpAllAddresses(client: ElectrumClient) {
  const addresses = await db.select().from(watchedAddresses);
  for (const addr of addresses) {
    try {
      await processScripthashHistory(addr.scripthash, client);
    } catch (err) {
      logger.warn({ err, address: addr.address }, "[monitor] reconnect catch-up failed for address");
    }
  }
  logger.info({ count: addresses.length }, "[monitor] Reconnect catch-up complete");
}

/**
 * Subscribe each watched address to Electrum.
 * If the subscribe call returns a non-null status, there is history to catch up on —
 * so we immediately process it. This handles transactions that occurred while offline.
 */
async function subscribeAllAddresses(client: ElectrumClient) {
  const addresses = await db.select().from(watchedAddresses);
  for (const addr of addresses) {
    try {
      const status = await client.subscribeScripthash(addr.scripthash);
      // Non-null status means there's history — fetch and process immediately
      if (status !== null) {
        await processScripthashHistory(addr.scripthash, client);
      }
    } catch (err) {
      logger.warn({ err, address: addr.address }, "[monitor] subscribe/catch-up failed");
    }
  }
  logger.info({ count: addresses.length }, "[monitor] Subscribed to all addresses");
}

/**
 * Classify an Electrum history entry height.
 * Electrum uses height=0 for mempool and height<0 for unconfirmed low-fee txs.
 * Both are "unconfirmed" in our model.
 */
function isUnconfirmed(height: number): boolean {
  return height <= 0;
}

/** Current number of confirmations for a mined transaction, or 0 if not yet mined. */
function confirmationCount(txHeight: number, chainTip: number | null): number {
  if (isUnconfirmed(txHeight) || chainTip == null) return 0;
  return Math.max(0, chainTip - txHeight + 1);
}

/**
 * Fetch the full history for a scripthash and process any new or updated transactions.
 * Safe to call multiple times — deduplicates via the alert_events table.
 * Respects confirmationThreshold from settings before sending confirmed alerts.
 */
export async function processScripthashHistory(scripthash: string, client: ElectrumClient) {
  const [watched] = await db
    .select()
    .from(watchedAddresses)
    .where(eq(watchedAddresses.scripthash, scripthash));
  if (!watched) return;

  // Load threshold from settings (default: 1)
  const [settings] = await db.select().from(appSettings).limit(1);
  const threshold = settings?.confirmationThreshold ?? 1;
  const chainTip = client.blockHeight;

  let history: { tx_hash: string; height: number }[];
  try {
    history = await client.getHistory(scripthash);
  } catch (err) {
    logger.warn({ err, scripthash }, "[monitor] getHistory failed");
    return;
  }

  for (const entry of history) {
    const { tx_hash: txid, height } = entry;
    // height <= 0 means mempool/unconfirmed; positive height means mined
    const unconfirmed = isUnconfirmed(height);
    const confs = confirmationCount(height, chainTip);
    const meetsThreshold = !unconfirmed && confs >= threshold;

    const existing = await db
      .select()
      .from(alertEvents)
      .where(and(eq(alertEvents.addressId, watched.id), eq(alertEvents.txid, txid)))
      .limit(1);

    if (existing.length === 0) {
      // New transaction — decode it to determine direction and amount.
      // Store as "confirmed" only if it already meets the threshold; otherwise "mempool".
      const initialStatus = meetsThreshold ? "confirmed" : "mempool";
      await processNewTx(watched.id, watched.label, watched.address, scripthash, txid, height, initialStatus, client, threshold);
    } else {
      const evt = existing[0]!;
      // Upgrade mempool → confirmed only when the threshold is reached.
      // Guard against concurrent calls racing on the same tx: add status='mempool'
      // to the WHERE clause so the UPDATE is a no-op if another call already won.
      // .returning() lets us check the affected-row count without a second SELECT.
      if (evt.status === "mempool" && meetsThreshold) {
        const upgraded = await db
          .update(alertEvents)
          .set({ status: "confirmed", blockHeight: height, confirmedAlertedAt: new Date() })
          .where(and(eq(alertEvents.id, evt.id), eq(alertEvents.status, "mempool")))
          .returning({ id: alertEvents.id });

        if (upgraded.length === 0) {
          // Another concurrent processScripthashHistory call already upgraded this
          // transaction — skip the duplicate alert.
          continue;
        }

        await sendTransactionAlert(
          watched.label,
          watched.address,
          txid,
          evt.direction,
          evt.amountSats,
          "confirmed",
          height,
          confs,
          threshold,
        );
      }
    }
  }
}

/**
 * Decode a raw transaction to determine direction and amount for a watched address.
 *
 * Incoming: one or more outputs pay to our scripthash → sum those output values.
 * Outgoing: no outputs pay to us → this is a spend. The outgoing amount is resolved
 *   via prevout lookups using resolveOutgoingAmountSats.
 */
async function processNewTx(
  addressId: string,
  label: string,
  address: string,
  scripthash: string,
  txid: string,
  height: number,
  status: "mempool" | "confirmed",
  client: ElectrumClient,
  threshold: number,
) {
  let amountSats = 0;
  let direction: "incoming" | "outgoing" = "incoming";

  try {
    const rawTx = await client.getTransaction(txid);
    const { inputs, outputs } = decodeRawTx(rawTx);

    // Check if any output pays to our address
    const ourOutputs = outputs.filter((o) => o.scripthash === scripthash);
    if (ourOutputs.length > 0) {
      direction = "incoming";
      amountSats = ourOutputs.reduce((sum, o) => sum + o.valueSats, 0);
    } else {
      // No outputs to us — this is a spend originating from our address.
      // Resolve the spent amount via prevout lookups.
      direction = "outgoing";
      amountSats = await resolveOutgoingAmountSats(inputs, scripthash, client);
      logger.info({ txid, amountSats }, "[monitor] outgoing transaction amount resolved");
    }
  } catch (err) {
    logger.warn({ err, txid }, "[monitor] Failed to decode transaction");
  }

  const id = crypto.randomUUID();
  const now = new Date();
  const confs = confirmationCount(height, client.blockHeight);

  const inserted = await db
    .insert(alertEvents)
    .values({
      id,
      addressId,
      txid,
      direction,
      amountSats,
      status,
      blockHeight: !isUnconfirmed(height) ? height : null,
      mempoolAlertedAt: status === "mempool" ? now : null,
      confirmedAlertedAt: status === "confirmed" ? now : null,
    })
    .onConflictDoNothing()
    .returning({ id: alertEvents.id });

  if (inserted.length === 0) {
    return;
  }

  // For mempool: always alert. For confirmed: alert with confirmation count.
  await sendTransactionAlert(label, address, txid, direction, amountSats, status, height, confs, threshold);
}

const DEFAULT_ALERT_TEMPLATE =
  "[{direction}] {label}\nAmount: {amount_btc} ({amount_sats} sats)\nAddress: {address}\nTxid: {txid}\nStatus: {status}";

function renderAlertTemplate(
  template: string,
  vars: {
    label: string;
    address: string;
    txid: string;
    direction: "incoming" | "outgoing";
    amountSats: number;
    status: "mempool" | "confirmed";
    height: number;
    confs: number;
    threshold: number;
  },
): string {
  const sign = vars.direction === "incoming" ? "+" : "-";
  const btc = (vars.amountSats / 1e8).toFixed(8);
  const statusLabel =
    vars.status === "mempool"
      ? "unconfirmed (mempool)"
      : `confirmed (block ${vars.height}, ${vars.confs}/${vars.threshold} confirmations)`;

  return template
    .replace(/{label}/g, vars.label)
    .replace(/{address}/g, vars.address)
    .replace(/{txid}/g, vars.txid)
    .replace(/{direction}/g, vars.direction.toUpperCase())
    .replace(/{amount_btc}/g, `${sign}${btc} BTC`)
    .replace(/{amount_sats}/g, vars.amountSats.toLocaleString())
    .replace(/{status}/g, statusLabel)
    .replace(/{block}/g, vars.height > 0 ? String(vars.height) : "mempool")
    .replace(/{confirmations}/g, `${vars.confs}/${vars.threshold}`);
}

async function sendTransactionAlert(
  label: string,
  address: string,
  txid: string,
  direction: "incoming" | "outgoing",
  amountSats: number,
  status: "mempool" | "confirmed",
  height: number,
  confs: number,
  threshold: number = 1,
) {
  _alertSendAttempts++;
  if (!xmpp.isConfigured() || !xmpp.isConnected()) return;

  const [settings] = await db.select({ alertTemplate: appSettings.alertTemplate }).from(appSettings).limit(1);
  const template = settings?.alertTemplate || DEFAULT_ALERT_TEMPLATE;

  const msg = renderAlertTemplate(template, { label, address, txid, direction, amountSats, status, height, confs, threshold });

  try {
    await xmpp.sendAlert(msg);
  } catch (err) {
    logger.warn({ err }, "[monitor] Failed to send XMPP alert");
  }
}

export async function subscribeAddress(scripthash: string) {
  if (!electrum || !electrum.connected) return;
  const status = await electrum.subscribeScripthash(scripthash);
  // Catch up on any existing history for this newly-added address
  if (status !== null && electrum) {
    await processScripthashHistory(scripthash, electrum);
  }
}

export async function unsubscribeAddress(scripthash: string) {
  electrum?.removeScripthash(scripthash);
}

export async function reloadMonitor() {
  if (electrum) {
    electrum.destroy();
    electrum = null;
  }
  xmpp.disconnect();
  nodeStatus = { connected: false, blockHeight: null, message: "Reloading...", lastCheckedAt: new Date() };
  await loadSettingsAndConnect();
}

/**
 * Tear down all active connections without scheduling a reconnect.
 * Intended for use in tests and graceful shutdown handlers.
 */
export function destroyMonitor() {
  if (electrum) {
    electrum.destroy();
    electrum = null;
  }
  xmpp.disconnect();
  nodeStatus = { connected: false, blockHeight: null, message: "Destroyed", lastCheckedAt: new Date() };
}
