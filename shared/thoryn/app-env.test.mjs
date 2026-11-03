import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { AppEnvError, applyResultResources, clientIdFromApplyResult, composeIssuer, resolveAppEnv, resolveWiring, toDotenv, wiringFromWhoami } from "./app-env.mjs";

test("composeIssuer puts the workspace in front of the platform host and the sandbox in the path", () => {
  assert.equal(composeIssuer("https://auth.stg.thoryn.org", "acme", "dev"), "https://acme.auth.stg.thoryn.org/dev");
  assert.equal(composeIssuer("https://auth.stg.thoryn.org/", "acme", null), "https://acme.auth.stg.thoryn.org");
  assert.equal(composeIssuer("http://127.0.0.1:54702", "dev", "sbx"), "http://dev.127.0.0.1:54702/sbx");
});

test("composeIssuer refuses a plain-http platform that is not loopback", () => {
  assert.throws(() => composeIssuer("http://auth.example.com", "acme", "dev"), AppEnvError);
  assert.throws(() => composeIssuer("not a url", "acme", "dev"), AppEnvError);
});

// SSO-4097 — the CLI keeps no receipt (thoryn-cli SSO-3715): `thoryn provision apply --output json` prints ONE document, and
// these are its real shapes at cli-v0.58.0 (ProvisionEngine ApplyResult / ProvisionPlan.toStructured, ProvisionCommand awaitDomain).
/** An apply that created the client: `ApplyResult.toStructured()`. */
const APPLY_CREATED = {
  workspace: "acme",
  resources: [{ kind: "application", name: "web", id: "app-123", environment: "dev", action: "create", attributes: { displayName: "shop" }, owner: "client:wi_0123" }],
  summary: { create: 1, update: 0, noop: 0 },
};
/** An apply with nothing to change prints the PLAN: `ProvisionPlan.toStructured()`, whose `resources[]` carries the same ids. */
const APPLY_NO_CHANGES = {
  changes: [{ kind: "application", name: "web", action: "noop", reason: "exists and matches", id: "app-123", environment: "dev", owner: "client:wi_0123" }],
  resources: [{ kind: "application", name: "web", id: "app-123", environment: "dev", action: "noop", owner: "client:wi_0123" }],
  summary: { create: 0, update: 0, remove: 0, noop: 1, skip: 0, grants: 0, error: 0, publish: 0, deliver: 0, pull: 0, customerManaged: 0 },
  warnings: [],
};

test("clientIdFromApplyResult reads the named application from every shape apply --output json prints, and explains a missing one", () => {
  assert.equal(clientIdFromApplyResult(APPLY_CREATED, "web"), "app-123");
  assert.equal(clientIdFromApplyResult(APPLY_NO_CHANGES, "web"), "app-123");
  // `--wait`: `{ "apply": <result>, "customDomain": <status> }`.
  assert.equal(clientIdFromApplyResult({ apply: APPLY_CREATED, customDomain: { state: "ACTIVE" } }, "web"), "app-123");
  assert.deepEqual(applyResultResources({ apply: APPLY_NO_CHANGES }).map((r) => r.action), ["noop"]);
  assert.throws(() => clientIdFromApplyResult(APPLY_CREATED, "api"), /apply result has no application named "api" — run \.thoryn\/ci\/provision\.sh/);
  assert.throws(() => clientIdFromApplyResult({}, "web"), AppEnvError);
  // A plan with the application still to create resolves no id: there is none to read.
  assert.throws(() => clientIdFromApplyResult({ changes: [{ kind: "application", name: "web", action: "create" }], resources: [] }, "web"), AppEnvError);
});

const where = { workspace: "acme", environment: "dev" };
const applyResult = APPLY_CREATED;

test("resolveAppEnv uses the issuer the discovery document publishes (a custom domain wins)", async () => {
  const seen = [];
  const fetchImpl = async (url) => {
    seen.push(url);
    return new Response(JSON.stringify({ issuer: "https://login.acme.com/dev" }), { status: 200 });
  };
  const vars = await resolveAppEnv({ ...where, applyResult, platformIssuer: "https://auth.stg.thoryn.org", application: "web", fetchImpl });
  assert.deepEqual(seen, ["https://acme.auth.stg.thoryn.org/dev/.well-known/openid-configuration"]);
  assert.deepEqual(vars, {
    OIDC_ISSUER: "https://login.acme.com/dev",
    OIDC_CLIENT_ID: "app-123",
    THORYN_WORKSPACE: "acme",
    THORYN_ENVIRONMENT: "dev",
  });
  assert.equal(toDotenv(vars).split("\n")[0], "OIDC_ISSUER=https://login.acme.com/dev");
});

test("resolveAppEnv fails clearly without THORYN_ISSUER or when discovery is not served", async () => {
  await assert.rejects(resolveAppEnv({ ...where, applyResult, platformIssuer: undefined, application: "web" }), /THORYN_ISSUER/);
  const notFound = async () => new Response("", { status: 404 });
  await assert.rejects(
    resolveAppEnv({ ...where, applyResult, platformIssuer: "https://auth.stg.thoryn.org", application: "web", fetchImpl: notFound }),
    /HTTP 404/,
  );
});

test("resolveAppEnv names THORYN_WORKSPACE / THORYN_ENVIRONMENT when they are missing or not slugs", async () => {
  const base = { applyResult, platformIssuer: "https://auth.stg.thoryn.org", application: "web", fetchImpl: async () => assert.fail("no fetch expected") };
  await assert.rejects(resolveAppEnv({ ...base, environment: "dev" }), /set THORYN_WORKSPACE/);
  await assert.rejects(resolveAppEnv({ ...base, workspace: "acme" }), /set THORYN_ENVIRONMENT/);
  await assert.rejects(resolveAppEnv({ ...base, workspace: "Acme/x", environment: "dev" }), /THORYN_WORKSPACE .* is not a workspace slug/);
  await assert.rejects(resolveAppEnv({ ...base, workspace: "acme", environment: "../prod" }), /THORYN_ENVIRONMENT .* is not an environment slug/);
});

test("wiringFromWhoami reads the workspace and platform issuer off the workspace issuer, and the selected sandbox", () => {
  assert.deepEqual(wiringFromWhoami({ issuer: "https://acme.auth.stg.thoryn.org", activeEnvironment: "dev" }), {
    THORYN_WORKSPACE: "acme",
    THORYN_ISSUER: "https://auth.stg.thoryn.org",
    THORYN_ENVIRONMENT: "dev",
  });
  // `thoryn workspace switch` wins for the workspace; production is never a sandbox to run against.
  assert.deepEqual(wiringFromWhoami({ issuer: "https://acme.auth.stg.thoryn.org", activeWorkspace: "beta", activeEnvironment: "production" }), {
    THORYN_WORKSPACE: "beta",
    THORYN_ISSUER: "https://auth.stg.thoryn.org",
  });
  // A platform issuer (no workspace label) or no session yields nothing it cannot vouch for.
  assert.deepEqual(wiringFromWhoami({ issuer: "https://auth.stg" }), {});
  assert.deepEqual(wiringFromWhoami(null), {});
});

test("resolveWiring keeps given values and asks the session only for what is missing", () => {
  let asked = 0;
  const whoami = () => { asked++; return { issuer: "https://acme.auth.stg.thoryn.org", activeEnvironment: "dev" }; };
  assert.deepEqual(resolveWiring({ issuer: "https://auth.example", workspace: "w", environment: "e" }, whoami), {
    THORYN_ISSUER: "https://auth.example", THORYN_WORKSPACE: "w", THORYN_ENVIRONMENT: "e",
  });
  assert.equal(asked, 0);
  assert.deepEqual(resolveWiring({ environment: "sbx" }, whoami), {
    THORYN_ISSUER: "https://auth.stg.thoryn.org", THORYN_WORKSPACE: "acme", THORYN_ENVIRONMENT: "sbx",
  });
  assert.equal(asked, 1);
  assert.deepEqual(resolveWiring({}, () => null), { THORYN_ISSUER: undefined, THORYN_WORKSPACE: undefined, THORYN_ENVIRONMENT: undefined });
});

// SSO-3666 — production mode: the client id comes from the variable THORYN_PRODUCTION_CLIENT_ID, the issuer
// is the workspace's own (no environment path), and the sandbox mode above is untouched.
import { MODES, PRODUCTION_CLIENT_ID_VARIABLE, resolveProductionAppEnv, selectMode } from "./app-env.mjs";

test("resolveProductionAppEnv composes the WORKSPACE issuer with no environment path and takes the client id from the variable", async () => {
  const seen = [];
  const fetchImpl = async (url) => {
    seen.push(url);
    return new Response(JSON.stringify({ issuer: "https://login.acme.com/" }), { status: 200 });
  };
  const vars = await resolveProductionAppEnv({ workspace: "acme", platformIssuer: "https://auth.stg.thoryn.org", clientId: "app-prod-9", fetchImpl });
  assert.deepEqual(seen, ["https://acme.auth.stg.thoryn.org/.well-known/openid-configuration"]);
  assert.deepEqual(vars, {
    OIDC_ISSUER: "https://login.acme.com",
    OIDC_CLIENT_ID: "app-prod-9",
    THORYN_WORKSPACE: "acme",
  });
  assert.equal("THORYN_ENVIRONMENT" in vars, false, "production has no environment slug");
  assert.equal(toDotenv(vars), "OIDC_ISSUER=https://login.acme.com\nOIDC_CLIENT_ID=app-prod-9\nTHORYN_WORKSPACE=acme\n");
});

test("resolveProductionAppEnv never reads an apply result: one naming another client changes nothing", async () => {
  const fetchImpl = async () => new Response(JSON.stringify({ issuer: "https://acme.auth.stg.thoryn.org" }), { status: 200 });
  const vars = await resolveProductionAppEnv({ workspace: "acme", platformIssuer: "https://auth.stg.thoryn.org", clientId: "app-prod-9", applyResult, fetchImpl });
  assert.equal(vars.OIDC_CLIENT_ID, "app-prod-9");
});

test("resolveProductionAppEnv fails naming THORYN_PRODUCTION_CLIENT_ID when it is missing or not a client id, before any fetch", async () => {
  const noFetch = async () => assert.fail("no fetch expected");
  const base = { workspace: "acme", platformIssuer: "https://auth.stg.thoryn.org", fetchImpl: noFetch };
  assert.equal(PRODUCTION_CLIENT_ID_VARIABLE, "THORYN_PRODUCTION_CLIENT_ID");
  await assert.rejects(resolveProductionAppEnv({ ...base, clientId: undefined }), /set THORYN_PRODUCTION_CLIENT_ID .*GitHub environment "production".*production-client-from-the-config-project/);
  await assert.rejects(resolveProductionAppEnv({ ...base, clientId: "" }), /set THORYN_PRODUCTION_CLIENT_ID/);
  await assert.rejects(resolveProductionAppEnv({ ...base, clientId: "app-1\nOIDC_ISSUER=https://evil" }), /THORYN_PRODUCTION_CLIENT_ID .* contains whitespace/);
});

test("resolveProductionAppEnv checks the workspace like the sandbox mode, and its discovery error points at THORYN_WORKSPACE only", async () => {
  const noFetch = async () => assert.fail("no fetch expected");
  await assert.rejects(resolveProductionAppEnv({ workspace: "acme", platformIssuer: undefined, clientId: "app-1", fetchImpl: noFetch }), /THORYN_ISSUER/);
  await assert.rejects(resolveProductionAppEnv({ workspace: undefined, platformIssuer: "https://auth.stg.thoryn.org", clientId: "app-1", fetchImpl: noFetch }), /set THORYN_WORKSPACE/);
  await assert.rejects(resolveProductionAppEnv({ workspace: "Acme/x", platformIssuer: "https://auth.stg.thoryn.org", clientId: "app-1", fetchImpl: noFetch }), /is not a workspace slug/);
  const notFound = async () => new Response("", { status: 404 });
  await assert.rejects(
    resolveProductionAppEnv({ workspace: "acme", platformIssuer: "https://auth.stg.thoryn.org", clientId: "app-1", fetchImpl: notFound }),
    (e) => e instanceof AppEnvError && /HTTP 404 — check THORYN_WORKSPACE$/.test(e.message),
  );
});

test("selectMode: asked for wins; otherwise production only when the production id is set and no sandbox is", () => {
  assert.deepEqual(MODES, ["sandbox", "production"]);
  assert.equal(selectMode({ mode: "production", productionClientId: undefined, environment: "dev" }), "production");
  assert.equal(selectMode({ mode: "sandbox", productionClientId: "app-1", environment: undefined }), "sandbox");
  assert.equal(selectMode({ productionClientId: "app-1", environment: undefined }), "production");
  assert.equal(selectMode({ productionClientId: "app-1", environment: "" }), "production");
  // Both set: a sandbox run, as before this mode existed.
  assert.equal(selectMode({ productionClientId: "app-1", environment: "dev" }), "sandbox");
  assert.equal(selectMode({}), "sandbox");
  assert.throws(() => selectMode({ mode: "staging" }), /--mode must be one of sandbox, production/);
});

// SSO-4097 — the command line: the apply result is named by --apply-result (or THORYN_APPLY_RESULT), and a missing one is explained.
const script = join(dirname(fileURLToPath(import.meta.url)), "app-env.mjs");
function appEnv(args, env = {}) {
  const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("THORYN_") && !k.startsWith("GITHUB_")));
  return spawnSync(process.execPath, [script, ...args], { env: { ...clean, GITHUB_ACTIONS: "true", ...env }, encoding: "utf8" });
}

test("app-env.mjs names the missing apply result and how to make it; the retired --receipt is refused", () => {
  const dir = mkdtempSync(join(tmpdir(), "app-env-"));
  const wiring = { THORYN_ISSUER: "https://auth.stg.thoryn.org", THORYN_WORKSPACE: "acme", THORYN_ENVIRONMENT: "dev" };
  const missing = appEnv(["--apply-result", join(dir, "thoryn-apply.json")], wiring);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /no apply result at .*thoryn-apply\.json — run \.thoryn\/ci\/provision\.sh first: it saves `thoryn provision apply --output json` there/);
  // THORYN_APPLY_RESULT is the default the CI steps share.
  const viaEnv = appEnv([], { ...wiring, THORYN_APPLY_RESULT: join(dir, "from-env.json") });
  assert.match(viaEnv.stderr, /no apply result at .*from-env\.json/);
  writeFileSync(join(dir, "bad.json"), "Applied. 1 resource(s) converged");
  assert.match(appEnv(["--apply-result", join(dir, "bad.json")], wiring).stderr, /is not a `thoryn provision apply --output json` result/);
  assert.match(appEnv(["--receipt", join(dir, "x.json")], wiring).stderr, /unknown argument --receipt/);
});
