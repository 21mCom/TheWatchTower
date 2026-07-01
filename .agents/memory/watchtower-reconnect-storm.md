---
name: Watchtower Electrum reconnect storm
description: Why the api-server must schedule reconnects from one idempotent path and bind its port before starting the monitor
---

## Rule
- The Electrum client must schedule a reconnect from exactly ONE idempotent place. A single `scheduleReconnect()` (no-op when a `reconnectTimer` is already pending; the timer callback nulls the timer before calling `reconnect()`) must be the only scheduler. Route the socket `error` path, the `close` handler, and a failed `reconnect()` all through it.
- Bind the HTTP port BEFORE starting the monitor: call `initMonitor()` inside the `app.listen(...)` callback, and add `server.on("error", ...)`. The monitor must never be able to prevent the port from opening.
- On a successful connect, clear any pending `reconnectTimer` so a timer scheduled by an earlier failure cannot fire a redundant reconnect after we are already connected.

**Why:** When Electrum is unreachable (the Umbrel default points at a not-yet-ready/closed `127.0.0.1` Electrs port), each failed attempt previously scheduled a reconnect from multiple event handlers (settle/error + close + reconnect-catch) with no reliable cancellation. Timers doubled every cycle → exponential reconnect storm → event loop starvation + heap OOM → `app.listen()` never bound port 3000 → Umbrel shows "Oops … ECONNREFUSED at umbrel.local:3000". Reproduces locally: the dev workflow against the unreachable default storms thousands of "Electrum socket error ECONNREFUSED" per tick then OOM-crashes.

**How to apply:** Any change to Electrum reconnect/lifecycle logic must keep a single idempotent scheduler and must not add a second setTimeout-based reconnect from another handler. Keep server bind independent of monitor startup. Regression guard: `reconnect-storm.test.ts` points a client at a closed port and asserts attempts grow linearly, not exponentially.

## Testing note
- Running the FULL api-server vitest/node test suite in this Replit container OOM-kills (multiple dev servers + DB-backed integration tests in one process). Run reconnect tests individually in fresh processes (`tsx --test <one file>`), writing output to a file; they share the `app_settings` id=1 row so do NOT run them in parallel. The Docker image uses esbuild (no typecheck), so pre-existing test-file typecheck errors don't block the image build.
