import { Router, type IRouter } from "express";
import healthRouter from "./health";
import addressesRouter from "./addresses";
import settingsRouter from "./settings";
import activityRouter from "./activity";
import statusRouter from "./status";
import xffProbeRouter from "./xff-probe";

const router: IRouter = Router();

router.use(healthRouter);
router.use("/addresses", addressesRouter);
router.use("/settings", settingsRouter);
router.use("/activity", activityRouter);
router.use("/node-status", statusRouter);
router.use(xffProbeRouter);

export default router;
