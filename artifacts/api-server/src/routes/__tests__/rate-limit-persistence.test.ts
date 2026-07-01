/**
 * Integration test: PgRateLimitStore survives a simulated server restart.
 *
 * Without a persistent store the default MemoryStore resets all counters on
 * process restart.  On Umbrel's on-failure restart policy that grants every IP
 * a free 120-request window immediately after a crash.
 *
 * This test:
 *   1. Increments a key 5 times through PgRateLimitStore instance A.
 *   2. Destroys A (simulating a process exit / pool teardown).
 *   3. Creates a fresh PgRateLimitStore instance B (simulating the restarted
 *      process) connected to the same database.
 *   4. Asserts that B sees 6 total hits after one more increment — proving the
 *      previous 5 were not lost.
 *
 * Requires DATABASE_URL to be set.  The test is skipped automatically when the
 * variable is absent so the unit-test suite remains self-contained.
 */

import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { PgRateLimitStore } from "../../lib/pg-rate-limit-store.js";

const DB_URL = process.env.DATABASE_URL;

describe("PgRateLimitStore restart persistence", { skip: !DB_URL }, () => {
  const TEST_KEY = `test-ip::persistence-${Date.now()}`;
  let storeA: PgRateLimitStore;

  before(async () => {
    storeA = new PgRateLimitStore(DB_URL!);
    storeA.init({ windowMs: 60_000 } as Parameters<PgRateLimitStore["init"]>[0]);
    // Clean up any leftover row from a previous run of this exact key
    await storeA.resetKey(TEST_KEY);
  });

  after(async () => {
    // Best-effort cleanup so the table doesn't accumulate test rows
    const storeCleanup = new PgRateLimitStore(DB_URL!);
    storeCleanup.init({
      windowMs: 60_000,
    } as Parameters<PgRateLimitStore["init"]>[0]);
    await storeCleanup.resetKey(TEST_KEY);
    await storeCleanup.shutdown();
  });

  test("counters written by instance A are visible to a fresh instance B", async () => {
    // ── Phase 1: accumulate 5 hits with storeA ──────────────────────────────
    for (let i = 1; i <= 5; i++) {
      const info = await storeA.increment(TEST_KEY);
      assert.equal(
        info.totalHits,
        i,
        `storeA: hit ${i} should report totalHits = ${i}`,
      );
    }

    // Shut down storeA — simulates the process exiting / pool teardown
    await storeA.shutdown();

    // ── Phase 2: fresh instance B (simulates the restarted process) ─────────
    const storeB = new PgRateLimitStore(DB_URL!);
    storeB.init({ windowMs: 60_000 } as Parameters<PgRateLimitStore["init"]>[0]);

    try {
      const info = await storeB.increment(TEST_KEY);
      assert.equal(
        info.totalHits,
        6,
        `storeB should see 6 total hits (5 from storeA + 1 new), got ${info.totalHits}`,
      );
    } finally {
      await storeB.shutdown();
    }
  });

  test("decrement reduces the persisted counter", async () => {
    // Use a separate key to avoid interference with the previous test
    const DECR_KEY = `${TEST_KEY}-decr`;
    const storeC = new PgRateLimitStore(DB_URL!);
    storeC.init({ windowMs: 60_000 } as Parameters<PgRateLimitStore["init"]>[0]);

    try {
      // Accumulate 3 hits
      await storeC.increment(DECR_KEY);
      await storeC.increment(DECR_KEY);
      const before3 = await storeC.increment(DECR_KEY);
      assert.equal(before3.totalHits, 3, "should have 3 hits before decrement");

      await storeC.decrement(DECR_KEY);

      // Fresh instance to confirm the decrement is durable
      const storeD = new PgRateLimitStore(DB_URL!);
      storeD.init({
        windowMs: 60_000,
      } as Parameters<PgRateLimitStore["init"]>[0]);
      try {
        const afterDecr = await storeD.increment(DECR_KEY);
        assert.equal(
          afterDecr.totalHits,
          3,
          "after decrement from 3 → 2, one more increment should give 3",
        );
      } finally {
        await storeD.resetKey(DECR_KEY);
        await storeD.shutdown();
      }
    } finally {
      await storeC.shutdown();
    }
  });

  test("cleanupExpired deletes only rows whose reset_time is in the past", async () => {
    const LIVE_KEY = `${TEST_KEY}-cleanup-live`;
    const DEAD_KEY = `${TEST_KEY}-cleanup-dead`;
    const store = new PgRateLimitStore(DB_URL!);
    store.init({ windowMs: 60_000 } as Parameters<PgRateLimitStore["init"]>[0]);
    const tempPool = new pg.Pool({ connectionString: DB_URL });

    try {
      // A live window (reset_time in the future) and a dead one (in the past)
      await store.increment(LIVE_KEY);
      await store.increment(DEAD_KEY);
      await tempPool.query(
        `UPDATE rate_limit_windows SET reset_time = NOW() - interval '1 second' WHERE key = $1`,
        [DEAD_KEY],
      );

      const deleted = await store.cleanupExpired();
      assert.ok(
        deleted >= 1,
        `cleanupExpired should report at least the 1 dead row deleted, got ${deleted}`,
      );

      const live = await tempPool.query(
        `SELECT 1 FROM rate_limit_windows WHERE key = $1`,
        [LIVE_KEY],
      );
      assert.equal(live.rowCount, 1, "live window must survive cleanup");

      const dead = await tempPool.query(
        `SELECT 1 FROM rate_limit_windows WHERE key = $1`,
        [DEAD_KEY],
      );
      assert.equal(dead.rowCount, 0, "expired window must be deleted by cleanup");
    } finally {
      await store.resetKey(LIVE_KEY);
      await store.resetKey(DEAD_KEY);
      await tempPool.end();
      await store.shutdown();
    }
  });

  test("an expired window is reset to 1 on the next increment", async () => {
    const EXPIRED_KEY = `${TEST_KEY}-expired`;
    const storeE = new PgRateLimitStore(DB_URL!);
    // Use a very short window so we can force expiry via a direct SQL write
    storeE.init({ windowMs: 1_000 } as Parameters<PgRateLimitStore["init"]>[0]);

    try {
      // Seed 10 hits with a reset_time in the past
      await storeE.increment(EXPIRED_KEY); // creates the row normally first

      // Back-date reset_time to the past so the window is expired
      const tempPool = new pg.Pool({ connectionString: DB_URL });
      await tempPool.query(
        `UPDATE rate_limit_windows SET hits = 10, reset_time = NOW() - interval '1 second' WHERE key = $1`,
        [EXPIRED_KEY],
      );
      await tempPool.end();

      // Fresh store — on the next increment the expired window must restart at 1
      const storeF = new PgRateLimitStore(DB_URL!);
      storeF.init({
        windowMs: 60_000,
      } as Parameters<PgRateLimitStore["init"]>[0]);
      try {
        const info = await storeF.increment(EXPIRED_KEY);
        assert.equal(
          info.totalHits,
          1,
          `expired window should reset to 1, got ${info.totalHits}`,
        );
      } finally {
        await storeF.resetKey(EXPIRED_KEY);
        await storeF.shutdown();
      }
    } finally {
      await storeE.shutdown();
    }
  });
});
