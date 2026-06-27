import { Router } from "express";
import { getNodeStatus } from "../services/monitor.js";

const router = Router();

router.get("/", (_req, res) => {
  const status = getNodeStatus();
  res.json({
    connected: status.connected,
    blockHeight: status.blockHeight ?? null,
    message: status.message ?? null,
    lastCheckedAt: status.lastCheckedAt?.toISOString() ?? null,
  });
});

export default router;
