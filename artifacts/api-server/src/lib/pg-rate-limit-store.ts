/**
 * PgRateLimitStore — a persistent express-rate-limit Store backed by PostgreSQL.
 *
 * Why: express-rate-limit's default MemoryStore resets all counters on process
 * restart.  In Umbrel's on-failure restart policy a crash grants every IP a
 * fresh 120-request window the moment the process comes back up.  This store
 * keeps counters in the existing Postgres database so they survive restarts.
 *
 * Design notes:
 * - The store creates its own pg.Pool from DATABASE_URL rather than sharing the
 *   application pool, so rate-limit queries can never block or be blocked by
 *   application queries.
 * - Table creation is idempotent (CREATE TABLE IF NOT EXISTS) and runs once in
 *   the constructor.  migrate.ts also creates the table so the first boot order
 *   of (migrate → server start) is safe, but the IF NOT EXISTS guard means the
 *   store is self-sufficient even if migrate is skipped in tests.
 * - The core increment is a single atomic UPSERT so concurrent requests from
 *   the same IP never produce a TOCTOU race.
 * - Expired windows are re-initialised inside the same UPSERT; no separate
 *   cleanup job is needed for correctness (a periodic DELETE is nice-to-have
 *   but not required for correct limiting behaviour).
 */

import pg from "pg";
import type { Store, Options, ClientRateLimitInfo } from "express-rate-limit";

export class PgRateLimitStore implements Store {
  private readonly pool: pg.Pool;
  private windowMs: number = 60_000;
  private readonly ready: Promise<void>;

  constructor(connectionString: string) {
    this.pool = new pg.Pool({ connectionString, max: 3 });
    this.ready = this.ensureTable();
  }

  private async ensureTable(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS rate_limit_windows (
        key        TEXT PRIMARY KEY,
        hits       INTEGER NOT NULL DEFAULT 1,
        reset_time TIMESTAMPTZ NOT NULL
      )
    `);
  }

  /** Called by express-rate-limit with the resolved options object. */
  init(options: Options): void {
    this.windowMs = options.windowMs;
  }

  /**
   * Atomically increment (or initialise) the counter for a key.
   *
   * The UPSERT handles two cases in one round-trip:
   *   - New key: insert with hits = 1 and a fresh reset_time.
   *   - Existing key, window still open: increment hits in place.
   *   - Existing key, window expired: reset hits to 1 and reset_time to now.
   */
  async increment(key: string): Promise<ClientRateLimitInfo> {
    await this.ready;
    const windowSecs = (this.windowMs / 1000).toFixed(3);
    const result = await this.pool.query<{ hits: number; reset_time: Date }>(
      `INSERT INTO rate_limit_windows (key, hits, reset_time)
       VALUES ($1, 1, NOW() + ($2 || ' seconds')::interval)
       ON CONFLICT (key) DO UPDATE
         SET
           hits = CASE
             WHEN rate_limit_windows.reset_time <= NOW() THEN 1
             ELSE rate_limit_windows.hits + 1
           END,
           reset_time = CASE
             WHEN rate_limit_windows.reset_time <= NOW()
               THEN NOW() + ($2 || ' seconds')::interval
             ELSE rate_limit_windows.reset_time
           END
       RETURNING hits, reset_time`,
      [key, windowSecs],
    );
    const row = result.rows[0];
    return { totalHits: row.hits, resetTime: row.reset_time };
  }

  async decrement(key: string): Promise<void> {
    await this.ready;
    await this.pool.query(
      `UPDATE rate_limit_windows SET hits = GREATEST(0, hits - 1) WHERE key = $1`,
      [key],
    );
  }

  async resetKey(key: string): Promise<void> {
    await this.ready;
    await this.pool.query(`DELETE FROM rate_limit_windows WHERE key = $1`, [
      key,
    ]);
  }

  async resetAll(): Promise<void> {
    await this.ready;
    await this.pool.query(`DELETE FROM rate_limit_windows`);
  }

  /** Release pool connections when the server shuts down. */
  async shutdown(): Promise<void> {
    await this.pool.end();
  }
}
