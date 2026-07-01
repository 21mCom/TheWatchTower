import { pgTable, text, timestamp, boolean } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const watchedAddresses = pgTable("watched_addresses", {
  id: text("id").primaryKey(),
  label: text("label").notNull(),
  address: text("address").notNull().unique(),
  scripthash: text("scripthash").notNull(),
  // "future": only notify about transactions occurring after the address is added
  // (existing history is silently baselined). "all": notify about full history.
  watchMode: text("watch_mode", { enum: ["future", "all"] }).notNull().default("future"),
  // Guard so the silent baseline runs exactly once per address (for "future" mode).
  baselineApplied: boolean("baseline_applied").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertWatchedAddressSchema = createInsertSchema(watchedAddresses).omit({
  createdAt: true,
});
export type InsertWatchedAddress = z.infer<typeof insertWatchedAddressSchema>;
export type WatchedAddress = typeof watchedAddresses.$inferSelect;
