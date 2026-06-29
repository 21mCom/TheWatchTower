/**
 * Security test: X-Forwarded-For spoofing cannot bypass the per-IP rate limiter
 * when the app is running behind Umbrel's nginx reverse proxy.
 *
 * Background
 * ----------
 * app.ts sets app.set('trust proxy', 1) so that Express derives req.ip from
 * the X-Forwarded-For header written by the immediate upstream proxy (Umbrel's
 * nginx).  Specifically, trust proxy = 1 (numeric) means Express uses the
 * RIGHTMOST address in the XFF list as req.ip — the address added by the
 * last trusted hop.
 *
 * This is only safe because Umbrel's nginx is configured in
 * umbrel/docker-compose.yml with:
 *
 *   proxy_set_header X-Forwarded-For $remote_addr;
 *
 * That directive OVERWRITES any client-supplied XFF with the actual TCP remote
 * address before the request reaches Express, producing a single-element XFF
 * containing the real client IP.  An attacker cannot forge their IP because
 * nginx always replaces whatever header they send.
 *
 * Attack surface: nginx passthrough ($http_x_forwarded_for)
 * ----------------------------------------------------------
 * If nginx were misconfigured to pass the client's XFF through unchanged
 * (proxy_set_header X-Forwarded-For $http_x_forwarded_for), a client could
 * send a single forged XFF header.  Express with trust proxy = 1 would use
 * that forged address as req.ip, creating a fresh rate-limit bucket for each
 * new fake IP — a complete bypass of the per-IP limit.
 *
 * Tests
 * -----
 * Test 1 — Safe path (nginx overwrites XFF with $remote_addr).
 *   Simulates what Umbrel's nginx produces: requests arrive at Express with a
 *   single-address XFF equal to the real connecting IP.  All requests from
 *   that IP share one rate-limit bucket; the 4th request (max = 3) is
 *   correctly rejected with 429.
 *
 * Test 2 — Vulnerability demonstration (why nginx MUST use $remote_addr
 *   not $http_x_forwarded_for).
 *   With trust proxy = 1, Express uses the rightmost XFF value as req.ip.
 *   If nginx simply passes the client's header through, a client can send any
 *   single-element forged XFF address and Express will key the rate limiter
 *   on that forged value.  Each unique forged address = a fresh bucket =
 *   unlimited requests.  This test proves the bypass is real, confirming that
 *   the $remote_addr overwrite in the nginx config is load-bearing.
 */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import rateLimit from "express-rate-limit";

// ---------------------------------------------------------------------------
// Shared helper: build a minimal Express app that mirrors app.ts's rate-limit
// configuration, with trust proxy = 1 and a low max to keep tests fast.
// ---------------------------------------------------------------------------
function buildApp() {
  const app = express();
  app.set("trust proxy", 1);
  app.use(
    rateLimit({
      windowMs: 60 * 1000,
      max: 3,
      standardHeaders: true,
      legacyHeaders: false,
      message: { error: "Too many requests, please slow down." },
    }),
  );
  app.get("/probe", (req, res) => {
    res.json({ ok: true, ip: req.ip });
  });
  return app;
}

// ---------------------------------------------------------------------------
// Test 1: safe path — nginx overwrites XFF with $remote_addr (single element)
// ---------------------------------------------------------------------------

let safeServer: http.Server;
let safeBaseUrl: string;

before(async () => {
  safeServer = http.createServer(buildApp());
  await new Promise<void>((resolve) => {
    safeServer.listen(0, "127.0.0.1", resolve);
  });
  const addr = safeServer.address() as { port: number };
  safeBaseUrl = `http://127.0.0.1:${addr.port}`;
});

after(async () => {
  await new Promise<void>((resolve, reject) => {
    safeServer.close((err) => (err ? reject(err) : resolve()));
  });
});

test(
  "Safe path: nginx-overwritten XFF ($remote_addr) keys all requests to the same rate-limit bucket",
  async () => {
    // Umbrel's nginx sets X-Forwarded-For: $remote_addr — a single address —
    // after discarding whatever the client sent.  All requests from the same
    // client carry the same XFF value.  With trust proxy = 1, Express uses
    // that single value as req.ip, so all requests share one bucket.
    const nginxSetXff = "203.0.113.42"; // fixed "real client IP" as nginx would set it

    for (let i = 1; i <= 3; i++) {
      const res = await fetch(`${safeBaseUrl}/probe`, {
        headers: { "X-Forwarded-For": nginxSetXff },
      });
      assert.notEqual(
        res.status,
        429,
        `Request ${i}/3 should not be rate-limited (got ${res.status})`,
      );
    }

    // 4th request with the same IP: bucket now exhausted → must be rejected.
    const overLimit = await fetch(`${safeBaseUrl}/probe`, {
      headers: { "X-Forwarded-For": nginxSetXff },
    });
    assert.equal(
      overLimit.status,
      429,
      `Request 4 from the same IP should be rate-limited (got ${overLimit.status})`,
    );

    const body = (await overLimit.json()) as { error?: string };
    assert.ok(
      typeof body.error === "string" && body.error.length > 0,
      "429 response should carry an error message",
    );
  },
);

// ---------------------------------------------------------------------------
// Test 2: vulnerability demo — nginx passthrough lets attacker forge req.ip
// ---------------------------------------------------------------------------

let vulnServer: http.Server;
let vulnBaseUrl: string;

before(async () => {
  vulnServer = http.createServer(buildApp());
  await new Promise<void>((resolve) => {
    vulnServer.listen(0, "127.0.0.1", resolve);
  });
  const addr = vulnServer.address() as { port: number };
  vulnBaseUrl = `http://127.0.0.1:${addr.port}`;
});

after(async () => {
  await new Promise<void>((resolve, reject) => {
    vulnServer.close((err) => (err ? reject(err) : resolve()));
  });
});

test(
  "Vulnerability demo: if nginx passes client XFF through unchanged, forged single-element XFF bypasses rate limiting",
  async () => {
    // Simulate the misconfigured nginx scenario:
    //   proxy_set_header X-Forwarded-For $http_x_forwarded_for;  ← WRONG
    //
    // The client sends a single forged XFF address.  nginx forwards it
    // unchanged.  With trust proxy = 1, Express uses the rightmost (only)
    // XFF value as req.ip — the attacker-controlled forged address.
    // Each unique forged IP maps to a fresh rate-limit bucket → unlimited reqs.
    const forgedAddresses = [
      "1.2.3.4",
      "5.6.7.8",
      "203.0.113.99",
      "198.51.100.7",
    ];

    // Requests 1–3: each uses a different forged single-element XFF.
    // If the rate limiter saw all of these as the same physical client, it
    // would hit 429 on request 4 even with a new forged address.
    // But because trust proxy = 1 makes req.ip = the forged address, each
    // request lands in its own bucket → all pass.
    for (let i = 0; i < 3; i++) {
      const res = await fetch(`${vulnBaseUrl}/probe`, {
        headers: { "X-Forwarded-For": forgedAddresses[i] },
      });
      assert.notEqual(
        res.status,
        429,
        `Request ${i + 1}/3 with forged XFF=${forgedAddresses[i]} should not be rate-limited (got ${res.status})`,
      );
    }

    // Request 4 with a fourth distinct forged address.
    // The attacker's bucket for this forged IP is empty → bypass succeeds → 200.
    // This proves that nginx MUST overwrite XFF with $remote_addr so that
    // forged values never reach Express.
    const bypassRes = await fetch(`${vulnBaseUrl}/probe`, {
      headers: { "X-Forwarded-For": forgedAddresses[3] },
    });
    assert.equal(
      bypassRes.status,
      200,
      `Vulnerability confirmed: forged XFF ${forgedAddresses[3]} got a fresh bucket and bypassed the rate limiter ` +
        `(got ${bypassRes.status}, wanted 200) — this is why nginx MUST use ` +
        `proxy_set_header X-Forwarded-For $remote_addr, not $http_x_forwarded_for`,
    );
  },
);
