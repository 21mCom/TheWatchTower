import { pgTable, text, integer, boolean } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const appSettings = pgTable("app_settings", {
  id: integer("id").primaryKey().default(1),
  electrumHost: text("electrum_host").notNull().default("localhost"),
  electrumPort: integer("electrum_port").notNull().default(50001),
  electrumTls: boolean("electrum_tls").notNull().default(false),
  electrumAllowSelfSigned: boolean("electrum_allow_self_signed").notNull().default(false),
  confirmationThreshold: integer("confirmation_threshold").notNull().default(1),
  xmppServer: text("xmpp_server").notNull().default(""),
  xmppPort: integer("xmpp_port").notNull().default(5222),
  xmppJid: text("xmpp_jid").notNull().default(""),
  xmppPassword: text("xmpp_password").notNull().default(""),
  xmppTls: boolean("xmpp_tls").notNull().default(true),
  recipientJid: text("recipient_jid").notNull().default(""),
  alertTemplate: text("alert_template").notNull().default(
    "[{direction}] {label}\nAmount: {amount_btc} ({amount_sats} sats)\nAddress: {address}\nTxid: {txid}\nStatus: {status}"
  ),
});

export const insertAppSettingsSchema = createInsertSchema(appSettings);
export type InsertAppSettings = z.infer<typeof insertAppSettingsSchema>;
export type AppSettings = typeof appSettings.$inferSelect;
