---
name: Umbrel Electrs connection
description: How a dependent Umbrel app reaches the Electrs Electrum server (fixed IP, not a container hostname)
---

- On Umbrel the official Electrs app does NOT expose a resolvable container hostname like `electrs_electrs_1`. It pins the electrs container to a FIXED IP via `ipv4_address: $APP_ELECTRS_NODE_IP`.
- A dependent app reaches the Electrum RPC at **`10.21.21.10:50001`** (TLS OFF). Source: electrs `exports.sh` → `APP_ELECTRS_NODE_IP=10.21.21.10`, `APP_ELECTRS_NODE_PORT=50001`. (Bitcoin Core RPC is `APP_BITCOIN_NODE_IP=10.21.21.8` if ever needed.)
- Umbrel substitutes `${APP_ELECTRS_NODE_IP}` / `${APP_ELECTRS_NODE_PORT}` into a dependent app's docker-compose, so the robust default is to pass those as env (e.g. `ELECTRUM_HOST`/`ELECTRUM_PORT`) and seed the app's settings from them rather than hardcoding the literal IP (which Umbrel could change).

**Why:** an earlier guess of `electrs_electrs_1` as the host was wrong → The Watchtower stayed "Disconnected from node". Container-name DNS only works for an app's OWN services; cross-app dependencies are reached by the fixed `APP_*_NODE_IP`.
**How to apply:** tell users to enter `10.21.21.10` / `50001` / TLS off. Electrs must also be installed AND have finished its initial chain index before it accepts Electrum connections (TCP refused/offline until then).
