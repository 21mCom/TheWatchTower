import { Router } from "express";
import { db } from "@workspace/db";
import { alertEvents, watchedAddresses } from "@workspace/db";
import { eq, desc, count, and } from "drizzle-orm";
import { ListActivityQueryParams } from "@workspace/api-zod";

const router = Router();

// GET /activity
router.get("/", async (req, res) => {
  const parsed = ListActivityQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid query params" });
    return;
  }

  const { limit = 50, offset = 0, addressId } = parsed.data;

  const baseQuery = db
    .select({
      id: alertEvents.id,
      addressId: alertEvents.addressId,
      addressLabel: watchedAddresses.label,
      address: watchedAddresses.address,
      txid: alertEvents.txid,
      direction: alertEvents.direction,
      amountSats: alertEvents.amountSats,
      status: alertEvents.status,
      blockHeight: alertEvents.blockHeight,
      mempoolAlertedAt: alertEvents.mempoolAlertedAt,
      confirmedAlertedAt: alertEvents.confirmedAlertedAt,
      detectedAt: alertEvents.detectedAt,
    })
    .from(alertEvents)
    .innerJoin(watchedAddresses, eq(alertEvents.addressId, watchedAddresses.id));

  // Baselined rows are silent history records (no direction/amount, no alert) —
  // exclude them from the activity feed and totals so they never surface as events.
  const notBaselined = eq(alertEvents.baselined, false);
  const eventsWhere = addressId
    ? and(eq(alertEvents.addressId, addressId), notBaselined)
    : notBaselined;

  const events = await baseQuery
    .where(eventsWhere)
    .orderBy(desc(alertEvents.detectedAt))
    .limit(limit)
    .offset(offset);

  const totalResult = await db
    .select({ count: count() })
    .from(alertEvents)
    .where(eventsWhere);

  const total = Number(totalResult[0]?.count ?? 0);

  res.json({ events, total, limit, offset });
});

export default router;
