import { Router, type Request, type Response, type IRouter } from "express";

const router: IRouter = Router();

// Debug-only endpoint: only mounted when XFF_PROBE_ENABLED=1.
// Used exclusively by the xff-nginx-proxy-test CI workflow to verify that
// Umbrel's app_proxy strips a forged X-Forwarded-For before it reaches Express.
//
// Never set XFF_PROBE_ENABLED in production (umbrel/docker-compose.yml does not
// set it and the web service runs with NODE_ENV=production by default).
if (process.env.XFF_PROBE_ENABLED === "1") {
  router.get("/xff-probe", (req: Request, res: Response) => {
    res.json({
      // Express derives req.ip from the X-Forwarded-For header written by the
      // upstream proxy, subject to the `trust proxy = 1` setting in app.ts.
      // This is the value the per-IP rate limiter uses as its bucket key.
      ip: req.ip,
      xff: req.headers["x-forwarded-for"] ?? null,
      realIp: req.headers["x-real-ip"] ?? null,
    });
  });
}

export default router;
