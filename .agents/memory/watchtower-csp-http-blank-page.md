---
name: Watchtower CSP HTTP blank page
description: Why helmet's default upgrade-insecure-requests blanks the app on Umbrel (HTTP-only) and how to avoid it
---

## Symptom
App installs, tab title shows, but the page is BLANK. Browser console shows every
same-origin sub-resource (`/assets/*.js`, `/assets/*.css`, `/favicon.svg`) failing
with `net::ERR_SSL_PROTOCOL_ERROR`, plus "Unsafe attempt to load https from http
frame". The document loads over `http://umbrel.local:<port>` but assets are
requested over `https://…:<port>`.

## Root cause
helmet@8 `contentSecurityPolicy` keeps `useDefaults: true` even when you pass a
custom `directives` object, so helmet's DEFAULT `upgrade-insecure-requests`
directive stays in the policy unless you override it. That directive tells the
browser to upgrade ALL http sub-resource requests to https. Umbrel serves the app
over plain HTTP with no TLS on that port → the upgraded https requests fail the TLS
handshake → JS/CSS never load → blank page.

## Fix / rule
For any deployment served over plain HTTP with no TLS at the app port (Umbrel
community apps, LAN-only self-hosted), DISABLE `upgrade-insecure-requests` by
setting the directive to null in helmet:
`directives: { …, upgradeInsecureRequests: null }` (helmet removes a directive
whose value is null).

**Why:** upgrade-insecure-requests is a self-DoS in an HTTP-only context — it only
makes sense when the origin actually serves HTTPS. Source restrictions
(`default-src 'self'`, etc.) stay intact, so no real security regression on a
LAN/Tor self-hosted box.
**How to apply:** Verify at runtime with
`curl -sI http://localhost:<port>/ | grep -i content-security-policy` — the header
must NOT contain `upgrade-insecure-requests`. Keep this as a release smoke check
whenever helmet/CSP is touched.

## Related: unused external fonts under strict CSP
`index.html` shipped Google Fonts `<link>`s (Inter) that were never applied (no
`font-family: Inter` anywhere; components use `fontFamily:"inherit"` + Tailwind
tokens). Under a tightened CSP (and on an offline Umbrel) they only produce blocked
requests + a privacy leak. Prefer removing/self-hosting unused external fonts for
HTTP-only/offline self-hosted apps.
