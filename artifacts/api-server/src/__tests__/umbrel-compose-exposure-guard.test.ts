/**
 * Security guard: the production Umbrel compose must never expose the app or
 * database to third parties without going through umbrelOS authentication.
 *
 * Why this test exists
 * --------------------
 * The Watchtower has no application-level login by design.  It relies entirely
 * on Umbrel's `app_proxy`, which forces every external/LAN request to
 * authenticate through umbrelOS before it can reach the app.  That protection
 * is real but UNENFORCED by code: it holds only because the production compose
 * file (umbrel/docker-compose.yml) happens not to publish the `web`/`db` host
 * ports, not to disable proxy auth, and not to enable a debug-only route.
 *
 * A single careless edit to that compose file would silently expose the app or
 * the Postgres database to anyone on the LAN with no test catching it.  This
 * guard parses the production compose and fails the build if any of those
 * regressions appear, while explicitly allowing the test-only exposures that
 * live in umbrel/docker-compose.override.test.yml (used by the XFF CI workflow).
 *
 * Scope: this asserts our compose never OPTS OUT of umbrelOS auth.  It does not
 * test umbrelOS's auth implementation itself (that lives upstream in
 * getumbrel/app-proxy).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { parse } from "yaml";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// artifacts/api-server/src/__tests__ -> repo root is four levels up.
const repoRoot = path.resolve(__dirname, "..", "..", "..", "..");
const prodComposePath = path.join(repoRoot, "umbrel", "docker-compose.yml");
const testOverridePath = path.join(
  repoRoot,
  "umbrel",
  "docker-compose.override.test.yml",
);

type ComposeService = {
  ports?: unknown;
  environment?: Record<string, unknown> | string[] | undefined;
};

type Compose = {
  services?: Record<string, ComposeService | undefined>;
};

function loadCompose(filePath: string): Compose {
  const raw = readFileSync(filePath, "utf8");
  return parse(raw) as Compose;
}

/**
 * Normalise a service's `environment` (which may be a map or a `KEY=value`
 * array) into a plain { KEY: value } object so individual flags can be checked.
 */
function envOf(service: ComposeService | undefined): Record<string, string> {
  const env = service?.environment;
  if (!env) return {};

  if (Array.isArray(env)) {
    const out: Record<string, string> = {};
    for (const entry of env) {
      const str = String(entry);
      const eq = str.indexOf("=");
      if (eq === -1) {
        out[str] = "";
      } else {
        out[str.slice(0, eq)] = str.slice(eq + 1);
      }
    }
    return out;
  }

  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    out[k] = v == null ? "" : String(v);
  }
  return out;
}

function hasPublishedPorts(service: ComposeService | undefined): boolean {
  const ports = service?.ports;
  return Array.isArray(ports) && ports.length > 0;
}

const prod = loadCompose(prodComposePath);
const prodServices = prod.services ?? {};

test("production compose: web service must NOT publish a host port", () => {
  const web = prodServices.web;
  assert.ok(web, "Expected a `web` service in umbrel/docker-compose.yml");

  assert.equal(
    hasPublishedPorts(web),
    false,
    "SECURITY REGRESSION: the `web` service publishes a host port in " +
      "umbrel/docker-compose.yml. This makes the app reachable directly on " +
      "the LAN, bypassing umbrelOS authentication entirely. The web service " +
      "must remain reachable only via the internal Docker network / app_proxy. " +
      "Remove the `ports:` entry — host-port exposure for testing belongs only " +
      "in umbrel/docker-compose.override.test.yml.",
  );
});

test("production compose: db (Postgres) service must NOT publish a host port", () => {
  const db = prodServices.db;
  assert.ok(db, "Expected a `db` service in umbrel/docker-compose.yml");

  assert.equal(
    hasPublishedPorts(db),
    false,
    "SECURITY REGRESSION: the `db` (Postgres) service publishes a host port " +
      "in umbrel/docker-compose.yml. This exposes the database directly to " +
      "third parties on the network with no umbrelOS authentication in front " +
      "of it. The database must stay on the internal Docker network only. " +
      "Remove the `ports:` entry from the `db` service.",
  );
});

test("production compose: NO service may publish a host port (catches brand-new services too)", () => {
  // The web/db tests above name those two services explicitly, but a future
  // contributor could add an entirely new service (an admin panel, a metrics
  // exporter, a second backend, …) that publishes a host port and is therefore
  // reachable directly on the LAN — bypassing umbrelOS authentication just like
  // an exposed web/db would. On Umbrel, only the app_proxy is meant to be
  // reachable, and umbrelOS wires that up itself; NOTHING in this compose file
  // should ever publish a host `ports:` entry. This iterates over EVERY service
  // so the guard covers services that don't exist yet.
  const offenders = Object.entries(prodServices)
    .filter(([, service]) => hasPublishedPorts(service))
    .map(([name]) => name);

  assert.deepEqual(
    offenders,
    [],
    "SECURITY REGRESSION: the following service(s) in umbrel/docker-compose.yml " +
      `publish a host port: ${offenders.join(", ")}. Any published host port ` +
      "makes that service reachable directly on the LAN by third parties, " +
      "bypassing umbrelOS authentication entirely — the app has no in-app login " +
      "and relies solely on the app_proxy auth layer. No service in the " +
      "production compose may publish a host port; umbrelOS exposes the " +
      "app_proxy itself. Remove the `ports:` entry — host-port exposure for " +
      "testing belongs only in umbrel/docker-compose.override.test.yml.",
  );
});

test("production compose: app_proxy must NOT disable or weaken umbrelOS auth", () => {
  const appProxy = prodServices.app_proxy;
  assert.ok(
    appProxy,
    "Expected an `app_proxy` service in umbrel/docker-compose.yml — without it " +
      "there is no umbrelOS authentication in front of the app at all.",
  );

  const env = envOf(appProxy);

  // Known umbrelOS / app_proxy flags that turn authentication off. If any of
  // these is present and truthy in production, external requests reach the app
  // without authenticating through umbrelOS.
  const authBypassFlags = [
    "PROXY_AUTH_WHITELIST",
    "PROXY_AUTH_BLACKLIST",
    "PROXY_AUTH_ADD",
    "SKIP_AUTH",
    "DISABLE_AUTH",
    "AUTH_DISABLED",
    "NO_AUTH",
  ];

  for (const flag of authBypassFlags) {
    if (!(flag in env)) continue;

    const value = env[flag].trim().toLowerCase();

    // PROXY_AUTH_ADD=false is the documented umbrelOS switch that turns the
    // auth layer OFF; any of the explicit *_AUTH disable flags being truthy is
    // equally dangerous.
    const disablesAuth =
      flag === "PROXY_AUTH_ADD"
        ? value === "false" || value === "0" || value === "no"
        : value === "true" || value === "1" || value === "yes";

    assert.ok(
      !disablesAuth,
      `SECURITY REGRESSION: the app_proxy service sets ${flag}=${env[flag]} in ` +
        "umbrel/docker-compose.yml, which disables or weakens umbrelOS " +
        "authentication. With auth bypassed, third parties can reach the app " +
        "without logging into umbrelOS. Remove this flag — the app has no " +
        "in-app login and depends entirely on the app_proxy auth layer.",
    );
  }
});

test("production compose: web service must NOT enable the debug XFF probe (or other debug toggles)", () => {
  const web = prodServices.web;
  assert.ok(web, "Expected a `web` service in umbrel/docker-compose.yml");

  const env = envOf(web);

  assert.ok(
    !("XFF_PROBE_ENABLED" in env),
    "SECURITY REGRESSION: XFF_PROBE_ENABLED is set on the `web` service in " +
      "umbrel/docker-compose.yml. The /api/xff-probe route is a debug-only " +
      "endpoint that reflects request internals and must never be mounted in " +
      "production. It belongs ONLY in umbrel/docker-compose.override.test.yml. " +
      "Remove XFF_PROBE_ENABLED from the production compose.",
  );
});

test("test override is the only sanctioned place for host-port publish + XFF_PROBE_ENABLED", () => {
  // Sanity-check that the whitelisted test exposures still live in the override
  // file. If someone moves them out of the override (e.g. into production), the
  // assertions above catch it; this test documents WHERE they are allowed and
  // keeps the XFF CI workflow's expectations explicit.
  const override = loadCompose(testOverridePath);
  const services = override.services ?? {};

  assert.ok(
    hasPublishedPorts(services.app_proxy),
    "Expected the test override to publish app_proxy's host port so the XFF CI " +
      "workflow can reach it. If this moved, update the XFF workflow too.",
  );

  const webEnv = envOf(services.web);
  assert.equal(
    webEnv.XFF_PROBE_ENABLED,
    "1",
    "Expected XFF_PROBE_ENABLED=1 in the test override (it enables the debug " +
      "probe used only by the XFF CI workflow).",
  );
});
