---
name: Watchtower future-only baseline
description: Design of "future-only" address alerts — how pre-existing history is silenced without alerts, and the invariants that must hold.
---

# Future-only baseline design

Addresses have a `watchMode` ("future" | "all"). "future" (the global default via
`settings.futureOnlyDefault`) means: when an address is first caught up, its existing
on-chain/mempool history is recorded **silently** so it never alerts; only genuinely
new transactions afterwards alert.

## Invariants (do not break)
- **Baseline rows are silent forever.** A baselined `activity`/`alertEvents` row has
  `baselined=true` and MUST keep `mempoolAlertedAt=null` and `confirmedAlertedAt=null`.
  The mempool→confirmed upgrade path MUST guard with `&& !evt.baselined`, or a tx that
  was already in the mempool at baseline time will wrongly fire a "confirmed" alert when
  it later confirms.
- **Baseline is idempotent + restart-safe.** `addresses.baselineApplied` gates it; the
  baseline branch applies the bulk insert (onConflictDoNothing, no decode/alert) then sets
  `baselineApplied=true` and returns. Reconnect catch-up re-processes unconditionally, so
  the flag — not the connection event — is what prevents re-baselining.
- **Changing an address re-baselines.** PUT that changes the `address` resets
  `baselineApplied=false` so the new address's history is silenced afresh.
- **"all" reproduces old behavior** (decode + alert on everything, no baseline).

**Why:** the whole point is that adding a long-lived address must not spam the user with
its entire back-history; only the guard on `baselined` keeps that promise across the
mempool→confirmed lifecycle and across reconnects.

**How to apply:** any new code that upgrades/re-decodes existing activity rows must
respect `baselined` and skip alerting for those rows. Activity list/count endpoints filter
`baselined=false`.
