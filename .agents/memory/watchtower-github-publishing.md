---
name: Watchtower GitHub publishing
description: Repos/registry names for Watchtower publishing and the hard scope limits of the Replit GitHub connector
---

## Build source & local↔repo drift (durable — read first)
- The deployed Umbrel image is built by CI **from the `21mCom/TheWatchTower` GitHub repo**, NOT from this Replit workspace. Editing files locally does NOTHING for the deployed app until they are pushed to that repo AND a new `v*.*.*` tag is cut to rebuild the image.
- Publishing has been done file-by-file via the GitHub Contents/Git Data API (no `git push` of the whole tree), so the repo frontend SILENTLY DIVERGED from local: the repo's `index.css` was missing the light-mode `--wt-*` card/input tokens that local already had → deployed app showed dark cards in light mode while local source was correct.
- **Before fixing any UI/behavior bug "already fixed locally", diff local vs repo.** Cheapest way: pull the repo tree recursively (`git/trees/<sha>?recursive=1`), compute the git-blob-sha locally (`sha1("blob "+len+"\0"+bytes)`), and compare per file. Anything that differs is stale on the repo and must be pushed.
- **Push atomically with `base_tree` = current remote HEAD tree** and list only changed blobs — this overlays files without deleting CI/`.github/`, `Dockerfile`, or `pnpm-lock.yaml`. EXCLUDE build artifacts (`.tsbuildinfo`, `dist/`) and don't touch the lockfile unless deps actually changed (CI uses `--frozen-lockfile`).
**Why:** drift is invisible — the app "loads" and CI passes while running stale frontend.
**How to apply:** for every release, sync the full set of diverged source files (not just the one file you think is broken), then tag to rebuild.

## Names
- Source GitHub repo: `21mCom/TheWatchTower` (public). NOT `21mCom/watchtower` (that 404s).
- GHCR image namespace: `ghcr.io/21mcom/watchtower` (tags built by the repo's docker-publish workflow on a `v*.*.*` tag).
- Community store repo: `21mCom/umbrel-app-store`, store id `21mcom-app-store`. Listing folder AND manifest `id` are `21mcom-app-store-the-watchtower` (docker-compose.yml, umbrel-app.yml, icon.png, 1.jpg). **Umbrel community stores hide any app whose folder name / manifest `id` is not prefixed with the store id** — that is why the unprefixed `the-watchtower` never appeared. Store `name` must NOT end in "App Store" (Umbrel appends " App Store", causing a doubled title) — set it to `21mCom`.

## Community-store images (durable)
- In community stores, `icon:` and `gallery:` entries in `umbrel-app.yml` must be **absolute URLs** (the official `getumbrel/umbrel-community-app-store` template uses full URLs). Relative filenames like `1.jpg` do NOT resolve in the community-store UI → broken gallery; a missing `icon:` field → default gray placeholder icon.
- We host them on the repo itself via `https://raw.githubusercontent.com/21mCom/umbrel-app-store/main/21mcom-app-store-the-watchtower/<file>`. **raw.githubusercontent.com serves jpg/png with correct image content-types (render in `<img>`), but serves `.svg` as `text/plain` + `X-Content-Type-Options: nosniff` → an SVG icon will NOT render in `<img>`.** So the app icon must be a **PNG** (not SVG) when hosted on raw GitHub. Icon is generated from `artifacts/watchtower-app/src/assets/logo.svg` (lighthouse) → rasterized to 512px PNG with ImageMagick (`magick`); the `₿` glyph (U+20BF) is absent from system fonts so it is drawn as vector shapes, not text.

## Replit GitHub connector scope limits (durable constraint)
- The connector grants ONLY: `read:org, read:project, read:user, repo, user:email`.
- **No `workflow` scope** → cannot create/update files under `.github/workflows/` via the contents API. A PUT to a workflow path returns **404** (not 403) even with repo admin. Normal (non-workflow) file writes work fine (verified: editing the store compose returned 200).
- **No `read:packages` / `write:packages`** → cannot list user/org packages or change GHCR package visibility via API (403 "need at least read:packages scope").

**Why:** These are fixed connector scopes; the user cannot extend them through the connector.
**How to apply:** Any task needing to add/modify GitHub Actions workflows must be handed to the user as a manual step. The agent CAN still: read repos, edit non-workflow files, and create tags/releases (release/tag creation is not workflow-scope gated, so once a workflow already exists in the repo the agent can cut a release to trigger it).

## GHCR visibility is per-package, not per-version (durable)
- Image visibility is set ONCE at the package level. The manual "flip to Public" step is only needed the FIRST time the package is created (new packages default Private). Every later version tag (`:1.0.1`, `:1.0.2`, …) pushed to an already-Public package is public automatically — no manual step. **Verify** anonymously: GET `https://ghcr.io/token?scope=repository:21mcom/watchtower:pull&service=ghcr.io` then GET `https://ghcr.io/v2/21mcom/watchtower/manifests/<tag>` with an OCI-index Accept header; 200 = publicly pullable. The connector can't read/change visibility (no packages scope) but anyone can verify public pullability this way.

## Re-triggering a build after a bad tagged release (durable)
- The docker-publish workflow runs `pnpm install --frozen-lockfile`, so the pushed repo's `pnpm-lock.yaml` MUST match every `package.json` (a stray dep like a `yaml` devDep added without the lockfile breaks the build with `ERR_PNPM_OUTDATED_LOCKFILE`). Keep the published diff minimal.
- To re-point a semver tag at a fixed commit and re-fire CI: push the fix to `main`, then DELETE the tag ref and RECREATE it at the new sha (a force-update may not reliably emit the tag push). Deleting the tag also drops its GitHub Release, so recreate the release afterward.

## Invalid umbrel-app.yml silently hides the app (durable)
- If `umbrel-app.yml` is invalid YAML (or fails Umbrel's manifest schema), the community store page still renders its **title** (from `umbrel-app-store.yml`) but lists **no app card** — there is no visible error. So "store loads but app is missing" ⇒ suspect the per-app manifest, not the store file.
- Real incident: a multi-line `releaseNotes: >-` block scalar was over-indented (4 spaces) and the following `developer:` key landed at 2-space indent — invalid at the top-level mapping, breaking the whole file. **All top-level keys must sit at column 0; block-scalar bodies (`description`, `releaseNotes`) indent 2 spaces.**
- **Always validate before pushing manifest edits.** The `yaml` pkg isn't hoisted to repo root; resolve it from the api-server package, e.g. `createRequire('<root>/artifacts/api-server/package.json')('yaml')` then `YAML.parse(readFileSync(...))`.
- After fixing the store repo, Umbrel won't show it until it re-pulls: remove and re-add the community app store (App Store → Community App Stores) to force a refresh.

## v1.0.0 published (done)
- `ghcr.io/21mcom/watchtower` now serves `1.0.0`, `1.0`, `1`, `latest` as a multi-arch OCI index (`linux/amd64`+`linux/arm64`); package is Public. Cut by pushing the `v1.0.0` git tag (workflow promotes semver tags on `tags: v*.*.*`). GitHub Release also created on `TheWatchTower`.
- Store app `docker-compose.yml` (in `21mcom-app-store-the-watchtower/`) pinned to `:1.0.0`; manifest `website/repo/support` URLs corrected to `TheWatchTower` (had pointed at the 404 `watchtower`).

## Docker build/runtime gotchas that blocked the publish (durable)
- **CI corepack pnpm drift:** root `package.json` must pin `"packageManager":"pnpm@<ver>"`; otherwise CI corepack pulls newest pnpm which ignored `onlyBuiltDependencies` → `ERR_PNPM_IGNORED_BUILDS` on esbuild. **Why:** newer pnpm changed build-script approval defaults.
- **musl natives:** do NOT add `@rollup/...-musl`/other musl override lines to `pnpm-workspace.yaml` for the alpine image — they broke the lockfile (`Cannot find module @rollup/rollup-linux-x64-musl`). Rollup/esbuild self-install the right native per-platform; removing the overrides + regenerating the lock fixed it.
- **`exec` cannot take inline env assignments:** `exec PORT=3000 node ...` in POSIX sh tries to run a program literally named `PORT=3000` → `exec: PORT=3000: not found`, server never starts. Use `export PORT=...; exec node ...`.
- **esbuild-plugin-pino bakes ABSOLUTE worker paths:** the bundle hard-codes the build-time outdir (e.g. `/app/artifacts/api-server/dist/thread-stream-worker.mjs`, plus `pino-*.mjs`) via `pinoBundlerAbsolutePath`. The Docker runner stage MUST place the dist at the exact same path it was built at and run node from there, or startup crashes with `Cannot find module .../thread-stream-worker.mjs`. **How to apply:** never relocate the api-server `dist` in the image; copy it to `/app/artifacts/api-server/dist` and exec from that path.
