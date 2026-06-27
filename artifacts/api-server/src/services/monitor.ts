import crypto from "crypto";
import { db } from "@workspace/db";
import { watchedAddresses, appSettings, alertEvents } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { ElectrumClient } from "./electrum.js";
import { XmppService } from "./xmpp.js";
import { decodeRawTxOutputs } from "./bitcoin.js";
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

  const client = new ElectrumClient(
    settings.electrumHost,
    settings.electrumPort,
    settings.electrumTls,
  );

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

    await subscribeAllAddresses(client);

    if (xmpp.isConfigured() && xmpp.isConnected()) {
      xmpp.sendAlert("🗼 Watchtower: Node connection restored.").catch(() => {});
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
      xmpp.sendAlert("⚠️ Watchtower: Lost connection to Bitcoin node.").catch(() => {});
    }
  });

  client.on("reconnected", async () => {
    nodeStatus = { connected: true, blockHeight: client.blockHeight, message: null, lastCheckedAt: new Date() };
  });

  client.on("blockHeight", (height: number) => {
    nodeStatus.blockHeight = height;
    nodeStatus.lastCheckedAt = new Date();
  });

  client.setNotificationHandler((scripthash, status) => {
    if (status !== null) {
      handleScripthashNotification(scripthash).catch((err) => {
        logger.error({ err, scripthash }, "[monitor] notification handling failed");
      });
    }
  });

  try {
    await client.connect();
    electrum = client;
  } catch (err) {
    logger.error({ err }, "[monitor] Electrum connect failed");
    nodeStatus = {
      connected: false,
      blockHeight: null,
      message: `Connection failed: ${(err as Error).message}`,
      lastCheckedAt: new Date(),
    };
    electrum = client; // keep it so reconnect can work
  }
}

async function subscribeAllAddresses(client: ElectrumClient) {
  const addresses = await db.select().from(watchedAddresses);
  for (const addr of addresses) {
    try {
      await client.subscribeScripthash(addr.scripthash);
    } catch (err) {
      logger.warn({ err, address: addr.address }, "[monitor] subscribe failed");
    }
  }
  logger.info({ count: addresses.length }, "[monitor] Subscribed to addresses");
}

async function handleScripthashNotification(scripthash: string) {
  if (!electrum) return;

  const [watched] = await db
    .select()
    .from(watchedAddresses)
    .where(eq(watchedAddresses.scripthash, scripthash));
  if (!watched) return;

  const history = await electrum.getHistory(scripthash);

  for (const entry of history) {
    const { tx_hash: txid, height } = entry;
    const status = height === 0 ? "mempool" : "confirmed";

    // Check if we already have this event
    const existing = await db
      .select()
      .from(alertEvents)
      .where(and(eq(alertEvents.addressId, watched.id), eq(alertEvents.txid, txid)))
      .limit(1);

    if (existing.length === 0) {
      // New transaction
      let amountSats = 0;
      let direction: "incoming" | "outgoing" = "incoming";

      try {
        const rawTx = await electrum.getTransaction(txid);
        const outputs = decodeRawTxOutputs(rawTx);
        const ours = outputs.filter((o) => o.scripthash === scripthash);
        if (ours.length > 0) {
          amountSats = ours.reduce((sum, o) => sum + o.valueSats, 0);
          direction = "incoming";
        } else {
          // No outputs to us — this is a spend
          direction = "outgoing";
          amountSats = 0; // hard to calculate without prevout lookups
        }
      } catch (err) {
        logger.warn({ err, txid }, "[monitor] Failed to decode transaction");
      }

      const id = crypto.randomUUID();
      const now = new Date();

      await db.insert(alertEvents).values({
        id,
        addressId: watched.id,
        txid,
        direction,
        amountSats,
        status,
        blockHeight: height > 0 ? height : null,
        mempoolAlertedAt: status === "mempool" ? now : null,
        confirmedAlertedAt: status === "confirmed" ? now : null,
      });

      await sendTransactionAlert(watched.label, watched.address, txid, direction, amountSats, status, height);
    } else {
      const evt = existing[0]!;
      // If previously mempool and now confirmed
      if (evt.status === "mempool" && status === "confirmed") {
        await db
          .update(alertEvents)
          .set({
            status: "confirmed",
            blockHeight: height,
            confirmedAlertedAt: new Date(),
          })
          .where(eq(alertEvents.id, evt.id));

        await sendTransactionAlert(watched.label, watched.address, txid, evt.direction, evt.amountSats, "confirmed", height);
      }
    }
  }
}

async function sendTransactionAlert(
  label: string,
  address: string,
  txid: string,
  direction: "incoming" | "outgoing",
  amountSats: number,
  status: "mempool" | "confirmed",
  height: number,
) {
  if (!xmpp.isConfigured() || !xmpp.isConnected()) return;

  const arrow = direction === "incoming" ? "📥" : "📤";
  const sign = direction === "incoming" ? "+" : "−";
  const btc = (amountSats / 1e8).toFixed(8);
  const statusLabel = status === "mempool" ? "⏳ mempool" : `✅ confirmed (block ${height})`;

  const msg =
    `${arrow} [${direction.toUpperCase()}] ${label}\n` +
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
  await electrum.subscribeScripthash(scripthash);
}

export async function unsubscribeAddress(scripthash: string) {
  if (!electrum) return;
  electrum.removeScripthash(scripthash);
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
