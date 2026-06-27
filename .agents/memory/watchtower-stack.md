---
name: Watchtower stack
description: Key decisions for The Watchtower Bitcoin address monitor — Electrum client, XMPP, DB schema, address-to-scripthash, Umbrel packaging
---

## Electrum client
- Line-delimited JSON-RPC over TCP/TLS — implemented custom in `artifacts/api-server/src/services/electrum.ts`
- `blockchain.scripthash.subscribe` for notifications; `blockchain.transaction.get` for raw tx decoding
- Auto-reconnect at 10s intervals; re-subscribes all tracked scripthashes on reconnect
- `blockchain.headers.subscribe` tracks block height for node status

## Address-to-scripthash
- Implemented in `artifacts/api-server/src/services/bitcoin.ts`
- Uses `bech32` + `bech32m` packages for segwit (P2WPKH, P2WSH, P2TR)
- Uses `bs58check` for P2PKH (version 0x00) and P2SH (version 0x05)
- Scripthash = reverse(SHA256(output_script)).hex — stored in DB for Electrum subscription

## DB schema
- `watched_addresses`: id (uuid), label, address (unique), scripthash, created_at
- `app_settings`: singleton row (id=1), all Electrum + XMPP config including plaintext xmpp_password
- `alert_events`: per-tx records with direction, amountSats, status (mempool/confirmed), blockHeight
- **Why:** xmppPassword stored plaintext — acceptable for self-hosted Umbrel, never returned in API responses

## Monitor service lifecycle
- Initialized in `app.ts` at startup via `initMonitor()`
- `reloadMonitor()` called when settings change (PUT /settings)
- Alert deduplication: check `alert_events` by (address_id, txid) before inserting
- Direction: if any output's scripthash matches watched address → "incoming"; otherwise → "outgoing"
- Outgoing amount = 0 (prevout lookup is too expensive for MVP)

## XMPP
- Uses `@xmpp/client` package; singleton `XmppService` in services/xmpp.ts
- Alert never sent if not configured or not connected (graceful no-op)
- Node connect/disconnect events also trigger XMPP alerts

## Umbrel packaging
- Files at `umbrel/`: `umbrel-app.yml`, `docker-compose.yml`, `Dockerfile`, `entrypoint.sh`
- app_proxy service in docker-compose handles Umbrel auth (no tor, no direct port exposure)
- Postgres 16 Alpine in docker-compose with volume at $APP_DATA_DIR/postgres
