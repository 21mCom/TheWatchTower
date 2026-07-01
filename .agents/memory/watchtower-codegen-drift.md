---
name: Watchtower api-zod/openapi codegen drift
description: openapi.yaml is the source of truth for the generated clients; keep it complete and regen from it, don't hand-edit generated clients ahead of the spec.
---

`lib/api-spec/openapi.yaml` is the source of truth; `pnpm --filter @workspace/api-spec run
codegen` (orval) regenerates BOTH `lib/api-zod` and `lib/api-client-react` from it. The
two generated packages must be regenerated together — they drift relative to each other
and to the spec if only one is refreshed or if generated files are hand-edited.

**History / why:** the committed clients were once deliberately kept AHEAD of the spec —
`electrumAllowSelfSigned`, `alertTemplate`, and integer `min(1).max(65535)` bounds on
`electrumPort`/`xmppPort` lived only in the generated `api-zod` (relied on by the
`settings-put-port-validation` route test) and the frontend used
`settings.electrumAllowSelfSigned` / `settings.alertTemplate` even though
`api-client-react` lacked them. That drift caused regen to *strip* fields and break tests.

**Current state:** those fields (and the port `min(1).max(65535)` bounds) are now
expressed IN `openapi.yaml`, so regen ADDS them and brings spec + both clients into parity.
EXCEPTION: orval 8.18.0's zod client does NOT emit `.int()` for `type: integer`, so the
integer constraint on `electrumPort`/`xmppPort` (required by the "non-integer port returns
400" route test) canNOT be regenerated — it must be hand-added back to the six port lines
in `lib/api-zod/src/generated/api.ts` (`zod.number().int().min(1).max(...)`) after every
regen. api-zod exports straight from `src` (no dist build), so the edit takes effect once
saved + api-server rebuilt.

**Why:** codegen was not always re-run for both packages, and hand-edits / partial
regenerations left the spec behind. Historically there was no single `openapi.yaml` state
that reproduced both committed packages byte-for-byte (the settings fields above have since
been folded into the spec, but assume other fields may still be drifted).

**How to apply (schema changes):** edit `openapi.yaml` first (add fields to BOTH the read
schema as required and the `*Update` schema as optional; keep the port bounds), then run
codegen, then `pnpm -w run typecheck`. After a rebase/merge, if a generated file
auto-merged into an inconsistent state (e.g. a frontend field missing from
`api-client-react`), regenerate from the merged `openapi.yaml` rather than hand-patching —
the spec, not the generated file, is authoritative. If you suspect residual drift for
fields NOT yet in the spec, back up the generated files first and `diff` after regen; the
`dist/generated/*.d.ts` compiled declarations hold the pre-regen shapes for recovery.

**Adding one endpoint by hand (avoid regen):** it is safe to hand-add a single new
operation/schema to `lib/api-client-react/src/generated/{api.ts,api.schemas.ts}` (mirror an
existing GET like `getNodeStatus`) WITHOUT running orval — this avoids clobbering any
still-drifted fields. But `artifacts/*` consume the client via TS project references, which
resolve declarations from `lib/api-client-react/dist/`, NOT `src/`. After editing the src,
you MUST rebuild: `cd lib/api-client-react && npx tsc -b`, or the app typecheck fails with
"no exported member". Read-only endpoints (no request body) don't need api-zod changes.
