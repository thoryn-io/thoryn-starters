import { test } from "node:test";
import assert from "node:assert/strict";
import { AppEnvError, clientIdFromReceipt, composeIssuer, resolveAppEnv, toDotenv } from "./app-env.mjs";

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

const connection = { workspace: { slug: "acme" }, auth: { method: "workload_identity", environment: "dev" } };
const receipt = { resources: [{ kind: "application", name: "web", id: "app-123" }] };

test("resolveAppEnv uses the issuer the discovery document publishes (a custom domain wins)", async () => {
  const seen = [];
  const fetchImpl = async (url) => {
    seen.push(url);
    return new Response(JSON.stringify({ issuer: "https://login.acme.com/dev" }), { status: 200 });
  };
  const vars = await resolveAppEnv({ connection, receipt, platformIssuer: "https://auth.stg.thoryn.org", application: "web", fetchImpl });
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
  await assert.rejects(resolveAppEnv({ connection, receipt, platformIssuer: undefined, application: "web" }), /THORYN_ISSUER/);
  const notFound = async () => new Response("", { status: 404 });
  await assert.rejects(
    resolveAppEnv({ connection, receipt, platformIssuer: "https://auth.stg.thoryn.org", application: "web", fetchImpl: notFound }),
    /HTTP 404/,
  );
});
