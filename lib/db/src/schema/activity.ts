import { pgTable, text, timestamp, integer, bigint, boolean, uniqueIndex } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const alertEvents = pgTable(
  "alert_events",
  {
    id: text("id").primaryKey(),
    addressId: text("address_id").notNull(),
    txid: text("txid").notNull(),
    direction: text("direction", { enum: ["incoming", "outgoing"] }).notNull(),
    amountSats: bigint("amount_sats", { mode: "number" }).notNull().default(0),
    status: text("status", { enum: ["mempool", "confirmed"] }).notNull(),
    blockHeight: integer("block_height"),
    mempoolAlertedAt: timestamp("mempool_alerted_at", { withTimezone: true }),
    confirmedAlertedAt: timestamp("confirmed_alerted_at", { withTimezone: true }),
    // True for rows recorded by the silent "future-only" baseline: these mark an
    // address's pre-existing history as already-seen and must never fire an alert,
    // including when a baselined mempool entry later confirms.
    baselined: boolean("baselined").notNull().default(false),
    detectedAt: timestamp("detected_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("alert_events_address_id_txid_idx").on(t.addressId, t.txid)],
);

export const insertAlertEventSchema = createInsertSchema(alertEvents).omit({
  detectedAt: true,
});
export type InsertAlertEvent = z.infer<typeof insertAlertEventSchema>;
export type AlertEvent = typeof alertEvents.$inferSelect;
