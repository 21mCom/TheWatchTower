import { Router } from "express";
import crypto from "crypto";
import { db } from "@workspace/db";
import { watchedAddresses } from "@workspace/db";
import { eq } from "drizzle-orm";
import {
  CreateAddressBody,
  UpdateAddressBody,
  UpdateAddressParams,
  DeleteAddressParams,
} from "@workspace/api-zod";
import { addressToScripthash, validateBitcoinAddress } from "../services/bitcoin.js";
import { subscribeAddress, unsubscribeAddress } from "../services/monitor.js";
import { logger } from "../lib/logger.js";

const router = Router();

// GET /addresses
router.get("/", async (_req, res) => {
  const addresses = await db.select().from(watchedAddresses).orderBy(watchedAddresses.createdAt);
  res.json(addresses);
});

// POST /addresses
router.post("/", async (req, res) => {
  const parsed = CreateAddressBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Validation failed", details: parsed.error.message });
    return;
  }

  const { label, address } = parsed.data;

  if (!validateBitcoinAddress(address)) {
    res.status(400).json({ error: "Invalid Bitcoin address" });
    return;
  }

  // Check duplicate
  const existing = await db
    .select()
    .from(watchedAddresses)
    .where(eq(watchedAddresses.address, address))
    .limit(1);
  if (existing.length > 0) {
    res.status(409).json({ error: "Address already watched" });
    return;
  }

  const scripthash = addressToScripthash(address);
  const id = crypto.randomUUID();

  const [created] = await db
    .insert(watchedAddresses)
    .values({ id, label, address, scripthash })
    .returning();

  // Subscribe in background
  subscribeAddress(scripthash).catch((err) => {
    logger.warn({ err, address }, "Failed to subscribe new address");
  });

  res.status(201).json(created);
});

// PUT /addresses/:id
router.put("/:id", async (req, res) => {
  const paramsParsed = UpdateAddressParams.safeParse(req.params);
  if (!paramsParsed.success) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }

  const bodyParsed = UpdateAddressBody.safeParse(req.body);
  if (!bodyParsed.success) {
    res.status(400).json({ error: "Validation failed", details: bodyParsed.error.message });
    return;
  }

  const { id } = paramsParsed.data;
  const { label, address } = bodyParsed.data;

  const existing = await db
    .select()
    .from(watchedAddresses)
    .where(eq(watchedAddresses.id, id))
    .limit(1);
  if (existing.length === 0) {
    res.status(404).json({ error: "Address not found" });
    return;
  }

  const old = existing[0]!;
  let scripthash = old.scripthash;

  if (address && address !== old.address) {
    if (!validateBitcoinAddress(address)) {
      res.status(400).json({ error: "Invalid Bitcoin address" });
      return;
    }

    // Reject if the new address is already watched by another entry
    const dup = await db
      .select()
      .from(watchedAddresses)
      .where(eq(watchedAddresses.address, address))
      .limit(1);
    if (dup.length > 0) {
      res.status(409).json({ error: "Address already watched" });
      return;
    }

    // Unsubscribe old, subscribe new
    await unsubscribeAddress(old.scripthash);
    scripthash = addressToScripthash(address);
  }

  const updates: Partial<typeof old> = {};
  if (label) updates.label = label;
  if (address && address !== old.address) {
    updates.address = address;
    updates.scripthash = scripthash;
  }

  const [updated] = await db
    .update(watchedAddresses)
    .set(updates)
    .where(eq(watchedAddresses.id, id))
    .returning();

  if (address && address !== old.address) {
    subscribeAddress(scripthash).catch((err) => {
      logger.warn({ err }, "Failed to subscribe updated address");
    });
  }

  res.json(updated);
});

// DELETE /addresses/:id
router.delete("/:id", async (req, res) => {
  const paramsParsed = DeleteAddressParams.safeParse(req.params);
  if (!paramsParsed.success) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }

  const { id } = paramsParsed.data;

  const existing = await db
    .select()
    .from(watchedAddresses)
    .where(eq(watchedAddresses.id, id))
    .limit(1);
  if (existing.length === 0) {
    res.status(404).json({ error: "Address not found" });
    return;
  }

  const addr = existing[0]!;
  await unsubscribeAddress(addr.scripthash);
  await db.delete(watchedAddresses).where(eq(watchedAddresses.id, id));

  res.status(204).send();
});

export default router;
