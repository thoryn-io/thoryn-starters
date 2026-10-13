import { test } from "node:test";
import assert from "node:assert/strict";
import { AppEnvError, clientIdFromReceipt, composeIssuer, resolveAppEnv, resolveWiring, toDotenv, wiringFromWhoami } from "./app-env.mjs";

test("composeIssuer puts the workspace in front of the platform host and the sandbox in the path", () => {
  assert.equal(composeIssuer("https://auth.stg.thoryn.org", "acme", "dev"), "https://acme.auth.stg.thoryn.org/dev");
  assert.equal(composeIssuer("https://auth.stg.thoryn.org/", "acme", null), "https://acme.auth.stg.thoryn.org");
  assert.equal(composeIssuer("http://127.0.0.1:54702", "dev", "sbx"), "http://dev.127.0.0.1:54702/sbx");
});

test("composeIssuer refuses a plain-http platform that is not loopback", () => {
  assert.throws(() => composeIssuer("http://auth.example.com", "acme", "dev"), AppEnvError);
  assert.throws(() => composeIssuer("not a url", "acme", "dev"), AppEnvError);
});

test("clientIdFromReceipt reads the named application and explains a missing one", () => {
  const receipt = { resources: [{ kind: "user", name: "test-user", id: "u1" }, { kind: "application", name: "web", id: "app-123" }] };
  assert.equal(clientIdFromReceipt(receipt, "web"), "app-123");
  assert.throws(() => clientIdFromReceipt(receipt, "api"), /provision apply/);
  assert.throws(() => clientIdFromReceipt({}, "web"), AppEnvError);
});

const where = { workspace: "acme", environment: "dev" };
const receipt = { resources: [{ kind: "application", name: "web", id: "app-123" }] };

test("resolveAppEnv uses the issuer the discovery document publishes (a custom domain wins)", async () => {
  const seen = [];
  const fetchImpl = async (url) => {
    seen.push(url);
    return new Response(JSON.stringify({ issuer: "https://login.acme.com/dev" }), { status: 200 });
  };
  const vars = await resolveAppEnv({ ...where, receipt, platformIssuer: "https://auth.stg.thoryn.org", application: "web", fetchImpl });
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
  await assert.rejects(resolveAppEnv({ ...where, receipt, platformIssuer: undefined, application: "web" }), /THORYN_ISSUER/);
  const notFound = async () => new Response("", { status: 404 });
  await assert.rejects(
    resolveAppEnv({ ...where, receipt, platformIssuer: "https://auth.stg.thoryn.org", application: "web", fetchImpl: notFound }),
    /HTTP 404/,
  );
});

test("resolveAppEnv names THORYN_WORKSPACE / THORYN_ENVIRONMENT when they are missing or not slugs", async () => {
  const base = { receipt, platformIssuer: "https://auth.stg.thoryn.org", application: "web", fetchImpl: async () => assert.fail("no fetch expected") };
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

// SSO-3666 — production mode: the client id comes from the variable the config project published, the issuer
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

test("resolveProductionAppEnv never reads a receipt: a receipt naming another client changes nothing", async () => {
  const fetchImpl = async () => new Response(JSON.stringify({ issuer: "https://acme.auth.stg.thoryn.org" }), { status: 200 });
  const vars = await resolveProductionAppEnv({ workspace: "acme", platformIssuer: "https://auth.stg.thoryn.org", clientId: "app-prod-9", receipt, fetchImpl });
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
