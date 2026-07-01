---
name: Watchtower schema migrations
description: The published image runs hand-written raw SQL migrations, not drizzle-kit — Drizzle schema and migrate.ts must be kept in parity
---

## The rule
The Watchtower's published Docker image runs the **hand-written raw-SQL migration** (`artifacts/api-server/src/migrate.ts`, compiled to `dist/migrate.mjs`, invoked by `umbrel/entrypoint.sh` before the server). It does NOT run `drizzle-kit`. So the Drizzle schema (`lib/db/src/schema/*`) is the source of truth the *server queries against*, but `migrate.ts` is what actually *creates the columns* in production.

**Any column/default/nullability added to the Drizzle schema MUST also be added to `migrate.ts`** — both in the `CREATE TABLE` (for fresh installs) and as an idempotent `ALTER TABLE ... ADD COLUMN IF NOT EXISTS ...` (so already-installed versions self-repair on upgrade). Keep `NOT NULL DEFAULT` values byte-for-byte equal to the Drizzle default (in JS template literals, `\n` becomes a real newline — match exactly).

**Why:** v1.0.0 shipped with `migrate.ts` missing `app_settings.alert_template` while the Drizzle schema + server SELECT included it → `column "alert_template" does not exist` crashed `initMonitor()` at runtime. The error was swallowed (server kept listening) so the CI `/api/healthz` smoke test still passed — the drift was invisible until a user installed it.

**How to apply:** Whenever editing `lib/db/src/schema`, diff it against `migrate.ts` before publishing. Known *remaining* drift (non-crashing, fix opportunistically): XMPP fields (`xmpp_server`, `xmpp_jid`, `xmpp_password`, `recipient_jid`) are `NOT NULL DEFAULT ''` in Drizzle but nullable/no-default in raw SQL; raw SQL also has an extra `updated_at` not in Drizzle.

## CI smoke test is too shallow (known gap)
The docker-publish smoke test only hits `/api/healthz`, which returns 200 even when the monitor failed to init. A meaningful smoke test should hit a DB-backed route (e.g. `/api/settings`, which selects `app_settings`) and/or assert the container logs do not contain a monitor-init failure. Editing the workflow requires the `workflow` GitHub scope, which the Replit connector lacks — so this is a user-side manual change.
