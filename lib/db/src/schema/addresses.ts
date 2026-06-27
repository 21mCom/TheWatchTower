import { pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const watchedAddresses = pgTable("watched_addresses", {
  id: text("id").primaryKey(),
  label: text("label").notNull(),
  address: text("address").notNull().unique(),
  scripthash: text("scripthash").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertWatchedAddressSchema = createInsertSchema(watchedAddresses).omit({
  createdAt: true,
});
export type InsertWatchedAddress = z.infer<typeof insertWatchedAddressSchema>;
export type WatchedAddress = typeof watchedAddresses.$inferSelect;
