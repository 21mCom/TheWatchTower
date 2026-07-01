---
name: Umbrel shared-network container naming
description: Why Umbrel apps must use full container names (not bare compose service names) for APP_HOST and all inter-service connection URLs
---

On umbrelOS every app's containers join ONE shared `umbrel_main_network`. Bare
docker-compose service names (`web`, `db`, ...) get registered as network aliases
on that shared network, so they are NOT unique — the same alias exists for every
app that happens to use it. Docker's embedded DNS returns ALL matching containers
round-robin.

**Symptom:** `app_proxy` → `web:3000` intermittently resolves to some *other*
app's container that doesn't listen on the port → `ECONNREFUSED` (Umbrel "Oops"
page). A `web` → `db` connection string can silently land on a different app's
Postgres. On-device proof: `docker exec <appid>_app_proxy_1 node -e
'dns.lookup("web",{all:true},...)'` returns several IPs; connecting by the full
container name returns 200.

**Rule:** reference this app's UNIQUE full container name everywhere a container
talks to another container: `<app-id>_<service>_1` (e.g.
`21mcom-app-store-the-watchtower_web_1`, `..._db_1`). Set `app_proxy` `APP_HOST`
and every inter-service URL (DATABASE_URL, redis host, etc.) to the full name.
`depends_on` keeps the bare service name (it's a compose construct, not DNS). The
app id is the store folder name.

**Why:** official Umbrel apps do exactly this — n8n `APP_HOST: n8n_server_1`,
immich `APP_HOST: immich_server_1` AND `DB_HOSTNAME: immich_postgres_1`. This is a
compose-only fix; no image rebuild. Bump `umbrel-app.yml` `version` so Umbrel
offers the update even when the image tag is unchanged.

**Why CI never caught it:** the dev/CI smoke test uses a single Postgres with host
networking, where bare names resolve fine. The collision only manifests on a real
multi-app Umbrel box.

**Distinct from the reconnect-storm bug** (`watchtower-reconnect-storm.md`): that
one *crashed* the web container (OOM, port never binds). This one leaves the web
container healthy and listening — it's purely a name-resolution problem in front
of it. Diagnose by checking whether the container is `Up` and the server answers
on `127.0.0.1` inside it (it does) before blaming the app.
