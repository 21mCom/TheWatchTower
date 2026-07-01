import { Router } from "express";
import rateLimit from "express-rate-limit";
import { db } from "@workspace/db";
import { appSettings } from "@workspace/db";
import { eq } from "drizzle-orm";
import { UpdateSettingsBody } from "@workspace/api-zod";
import { getXmpp, reloadMonitor } from "../services/monitor.js";

const router = Router();

// Tight rate limit for write/action endpoints — 10 req/min per IP
const settingsWriteLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests, please slow down." },
});

async function getOrCreateSettings() {
  const [s] = await db.select().from(appSettings).limit(1);
  if (s) return s;
  const [created] = await db.insert(appSettings).values({ id: 1 }).returning();
  return created!;
}

// GET /settings
router.get("/", async (_req, res) => {
  const s = await getOrCreateSettings();
  res.json({
    electrumHost: s.electrumHost,
    electrumPort: s.electrumPort,
    electrumTls: s.electrumTls,
    electrumAllowSelfSigned: s.electrumAllowSelfSigned,
    confirmationThreshold: s.confirmationThreshold,
    xmppServer: s.xmppServer,
    xmppPort: s.xmppPort,
    xmppJid: s.xmppJid,
    xmppTls: s.xmppTls,
    recipientJid: s.recipientJid,
    xmppConfigured: !!(s.xmppJid && s.xmppPassword && s.recipientJid),
    alertTemplate: s.alertTemplate,
    futureOnlyDefault: s.futureOnlyDefault,
  });
});

// PUT /settings
router.put("/", settingsWriteLimiter, async (req, res) => {
  const parsed = UpdateSettingsBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Validation failed", details: parsed.error.message });
    return;
  }

  const current = await getOrCreateSettings();
  const data = parsed.data;

  const updates: Record<string, unknown> = {};
  if (data.electrumHost !== undefined) updates.electrumHost = data.electrumHost;
  if (data.electrumPort !== undefined) updates.electrumPort = data.electrumPort;
  if (data.electrumTls !== undefined) updates.electrumTls = data.electrumTls;
  if (data.electrumAllowSelfSigned !== undefined) updates.electrumAllowSelfSigned = data.electrumAllowSelfSigned;
  if (data.confirmationThreshold !== undefined) updates.confirmationThreshold = data.confirmationThreshold;
  if (data.xmppServer !== undefined) updates.xmppServer = data.xmppServer;
  if (data.xmppPort !== undefined) updates.xmppPort = data.xmppPort;
  if (data.xmppJid !== undefined) updates.xmppJid = data.xmppJid;
  if (data.xmppPassword !== undefined) updates.xmppPassword = data.xmppPassword;
  if (data.xmppTls !== undefined) updates.xmppTls = data.xmppTls;
  if (data.recipientJid !== undefined) updates.recipientJid = data.recipientJid;
  if (data.alertTemplate !== undefined) updates.alertTemplate = data.alertTemplate;
  if (data.futureOnlyDefault !== undefined) updates.futureOnlyDefault = data.futureOnlyDefault;

  if (Object.keys(updates).length === 0) {
    res.status(400).json({ error: "No fields to update were provided." });
    return;
  }

  const [updated] = await db
    .update(appSettings)
    .set(updates)
    .where(eq(appSettings.id, 1))
    .returning();

  reloadMonitor().catch(() => {});

  const s = updated ?? current;
  res.json({
    electrumHost: s.electrumHost,
    electrumPort: s.electrumPort,
    electrumTls: s.electrumTls,
    electrumAllowSelfSigned: s.electrumAllowSelfSigned,
    confirmationThreshold: s.confirmationThreshold,
    xmppServer: s.xmppServer,
    xmppPort: s.xmppPort,
    xmppJid: s.xmppJid,
    xmppTls: s.xmppTls,
    recipientJid: s.recipientJid,
    xmppConfigured: !!(s.xmppJid && s.xmppPassword && s.recipientJid),
    alertTemplate: s.alertTemplate,
    futureOnlyDefault: s.futureOnlyDefault,
  });
});

// GET /settings/xmpp-status
router.get("/xmpp-status", (_req, res) => {
  const xmpp = getXmpp();
  const lastError = xmpp.getLastError();
  res.json({
    connected: xmpp.isConnected(),
    configured: xmpp.isConfigured(),
    error: lastError ? { kind: lastError.kind, message: lastError.message } : null,
  });
});

// POST /settings/test-alert
router.post("/test-alert", settingsWriteLimiter, async (_req, res) => {
  const xmpp = getXmpp();
  if (!xmpp.isConfigured()) {
    res.json({ success: false, message: "XMPP is not configured. Please set the JID, password, and recipient." });
    return;
  }
  try {
    // Ensure a live connection first so we can report the specific reason it
    // failed (auth, host not found, TLS, timeout, …) rather than a generic
    // "not connected" message.
    await xmpp.ensureConnected();
    await xmpp.sendAlert("🗼 Watchtower test alert — your notifications are working correctly.");
    res.json({ success: true, message: "Test alert sent successfully." });
  } catch (err) {
    res.json({ success: false, message: `Failed to send test alert: ${(err as Error).message}` });
  }
});

export default router;
