/**
 * DB bootstrap / schema-init script.
 * Run once at container startup (before index.ts) to ensure all tables exist.
 * Uses raw DDL (CREATE TABLE IF NOT EXISTS) — idempotent and safe to re-run.
 *
 * Includes a DB readiness retry loop so this can run immediately at container
 * start without depending on external healthcheck tooling.
 */
import { pool } from "@workspace/db";

const MAX_RETRIES = 30;
const RETRY_DELAY_MS = 2_000;

async function waitForDb(): Promise<void> {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const client = await pool.connect();
      client.release();
      console.log("[migrate] Database is ready");
      return;
    } catch (err) {
      const msg = (err as Error).message ?? String(err);
      console.log(`[migrate] DB not ready (attempt ${attempt}/${MAX_RETRIES}): ${msg}`);
      if (attempt === MAX_RETRIES) {
        throw new Error(`Database did not become ready after ${MAX_RETRIES} attempts`);
      }
      await new Promise((res) => setTimeout(res, RETRY_DELAY_MS));
    }
  }
}

async function main() {
  await waitForDb();

  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS app_settings (
        id                     INTEGER PRIMARY KEY DEFAULT 1,
        electrum_host          TEXT NOT NULL DEFAULT 'localhost',
        electrum_port          INTEGER NOT NULL DEFAULT 50001,
        electrum_tls           BOOLEAN NOT NULL DEFAULT FALSE,
        xmpp_server            TEXT,
        xmpp_port              INTEGER NOT NULL DEFAULT 5222,
        xmpp_jid               TEXT,
        xmpp_password          TEXT,
        xmpp_tls               BOOLEAN NOT NULL DEFAULT TRUE,
        recipient_jid          TEXT,
        confirmation_threshold INTEGER NOT NULL DEFAULT 1,
        updated_at             TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      );

      INSERT INTO app_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

      CREATE TABLE IF NOT EXISTS watched_addresses (
        id          TEXT PRIMARY KEY,
        label       TEXT NOT NULL,
        address     TEXT NOT NULL UNIQUE,
        scripthash  TEXT NOT NULL,
        created_at  TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS alert_events (
        id                   TEXT PRIMARY KEY,
        address_id           TEXT NOT NULL,
        txid                 TEXT NOT NULL,
        direction            TEXT NOT NULL CHECK (direction IN ('incoming', 'outgoing')),
        amount_sats          BIGINT NOT NULL DEFAULT 0,
        status               TEXT NOT NULL CHECK (status IN ('mempool', 'confirmed')),
        block_height         INTEGER,
        mempool_alerted_at   TIMESTAMP WITH TIME ZONE,
        confirmed_alerted_at TIMESTAMP WITH TIME ZONE,
        detected_at          TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
      );

      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'alert_events'
            AND column_name = 'amount_sats'
            AND data_type IN ('real', 'double precision')
        ) THEN
          ALTER TABLE alert_events ALTER COLUMN amount_sats TYPE BIGINT USING amount_sats::BIGINT;
        END IF;
      END$$;
    `);

    console.log("[migrate] Schema initialized successfully");
  } finally {
    client.release();
  }

  // Allow pool to drain so the process exits cleanly
  await pool.end();
}

main().catch((err) => {
  console.error("[migrate] Fatal:", err.message ?? err);
  process.exit(1);
});
