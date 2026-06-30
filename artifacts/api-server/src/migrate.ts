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
        id                          INTEGER PRIMARY KEY DEFAULT 1,
        electrum_host               TEXT NOT NULL DEFAULT 'localhost',
        electrum_port               INTEGER NOT NULL DEFAULT 50001,
        electrum_tls                BOOLEAN NOT NULL DEFAULT FALSE,
        electrum_allow_self_signed  BOOLEAN NOT NULL DEFAULT FALSE,
        xmpp_server                 TEXT,
        xmpp_port                   INTEGER NOT NULL DEFAULT 5222,
        xmpp_jid                    TEXT,
        xmpp_password               TEXT,
        xmpp_tls                    BOOLEAN NOT NULL DEFAULT TRUE,
        recipient_jid               TEXT,
        confirmation_threshold      INTEGER NOT NULL DEFAULT 1,
        alert_template              TEXT NOT NULL DEFAULT '[{direction}] {label}\nAmount: {amount_btc} ({amount_sats} sats)\nAddress: {address}\nTxid: {txid}\nStatus: {status}',
        updated_at                  TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      );

      -- Idempotent upgrade: add electrum_allow_self_signed to existing installs
      ALTER TABLE app_settings
        ADD COLUMN IF NOT EXISTS electrum_allow_self_signed BOOLEAN NOT NULL DEFAULT FALSE;

      -- Idempotent upgrade: add alert_template to existing installs (schema-drift fix)
      ALTER TABLE app_settings
        ADD COLUMN IF NOT EXISTS alert_template TEXT NOT NULL DEFAULT '[{direction}] {label}\nAmount: {amount_btc} ({amount_sats} sats)\nAddress: {address}\nTxid: {txid}\nStatus: {status}';

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

      -- Remove any pre-existing duplicate (address_id, txid) rows before applying the
      -- unique constraint. Keeps the row with the earliest detected_at (lowest id as
      -- tiebreaker). Safe to run on a fresh DB with no rows.
      DELETE FROM alert_events
      WHERE id IN (
        SELECT id FROM (
          SELECT id,
                 ROW_NUMBER() OVER (
                   PARTITION BY address_id, txid
                   ORDER BY detected_at, id
                 ) AS rn
          FROM alert_events
        ) t
        WHERE rn > 1
      );

      CREATE UNIQUE INDEX IF NOT EXISTS alert_events_address_id_txid_idx
        ON alert_events (address_id, txid);

      -- Rate-limiter backing store.  Keeps per-IP hit counters across process
      -- restarts so Umbrel's on-failure restart policy can't grant a free window.
      CREATE TABLE IF NOT EXISTS rate_limit_windows (
        key        TEXT PRIMARY KEY,
        hits       INTEGER NOT NULL DEFAULT 1,
        reset_time TIMESTAMPTZ NOT NULL
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
