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
let nodeStatus: NodeStatus = {
  connected: false,
  blockHeight: null,
  message: "Not initialized",
  lastCheckedAt: null,
};

export function getNodeStatus(): NodeStatus {
  return { ...nodeStatus };
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
      xmpp.sendAlert("Watchtower: Node connection restored.").catch(() => {});
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
      xmpp.sendAlert("WARNING Watchtower: Lost connection to Bitcoin node.").catch(() => {});
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
async function processScripthashHistory(scripthash: string, client: ElectrumClient) {
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
      // Upgrade mempool → confirmed only when the threshold is reached
      if (evt.status === "mempool" && meetsThreshold) {
        await db
          .update(alertEvents)
          .set({ status: "confirmed", blockHeight: height, confirmedAlertedAt: new Date() })
          .where(eq(alertEvents.id, evt.id));

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

  await db.insert(alertEvents).values({
    id,
    addressId,
    txid,
    direction,
    amountSats,
    status,
    blockHeight: !isUnconfirmed(height) ? height : null,
    mempoolAlertedAt: status === "mempool" ? now : null,
    confirmedAlertedAt: status === "confirmed" ? now : null,
  });

  // For mempool: always alert. For confirmed: alert with confirmation count.
  await sendTransactionAlert(label, address, txid, direction, amountSats, status, height, confs, threshold);
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
  if (!xmpp.isConfigured() || !xmpp.isConnected()) return;

  const sign = direction === "incoming" ? "+" : "-";
  const btc = (amountSats / 1e8).toFixed(8);
  const statusLabel =
    status === "mempool"
      ? "unconfirmed (mempool)"
      : `confirmed (block ${height}, ${confs}/${threshold} confirmations)`;

  const msg =
    `[${direction.toUpperCase()}] ${label}\n` +
    `Amount: ${sign}${btc} BTC (${amountSats.toLocaleString()} sats)\n` +
    `Address: ${address}\n` +
    `Txid: ${txid}\n` +
    `Status: ${statusLabel}`;

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
