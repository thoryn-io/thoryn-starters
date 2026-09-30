// SSO-3428 — the shared CI steps read their wiring from the environment (the Actions variables the
// workflow maps in), never from a rendered file. These tests run the real scripts with a fake `thoryn`
// on PATH that records its arguments.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/** A throw-away "repository": .thoryn/ with the given starter's declaration and the shared scripts. */
function repo(starter = "express") {
  const dir = mkdtempSync(join(tmpdir(), "ci-scripts-"));
  mkdirSync(join(dir, ".thoryn"), { recursive: true });
  cpSync(join(root, "shared/thoryn/ci"), join(dir, ".thoryn/ci"), { recursive: true });
  cpSync(join(root, "starters", starter, ".thoryn/template.json"), join(dir, ".thoryn/template.json"));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "thoryn"), `#!/usr/bin/env bash\nprintf '%s\\n' "$@" > "${join(dir, "thoryn.args")}"\n`);
  chmodSync(join(bin, "thoryn"), 0o755);
  return { dir, bin, args: () => readFileSync(join(dir, "thoryn.args"), "utf8").trim().split("\n") };
}

function run(r, script, args, env) {
  const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("THORYN_") && !k.startsWith("GITHUB_")));
  return spawnSync("bash", [join(".thoryn/ci", script), ...args], {
    cwd: r.dir,
    env: { ...clean, PATH: `${r.bin}:${process.env.PATH}`, ...env },
    encoding: "utf8",
  });
}

const app = {
  THORYN_ISSUER: "https://auth.stg.thoryn.org",
  THORYN_WORKSPACE: "acme",
  THORYN_ENVIRONMENT: "dev",
  THORYN_WIF_CLIENT_ID: "wi_0123456789abcdef",
};

test("login.sh signs in as the connection: its client id variable, the composed audience and exactly its scopes", () => {
  const r = repo("express");
  const res = run(r, "login.sh", ["sandbox"], app);
  assert.equal(res.status, 0, res.stderr + res.stdout);
  assert.deepEqual(r.args(), [
    "login", "--workload-identity",
    "--issuer", "https://auth.stg.thoryn.org",
    "--workspace", "acme",
    "--client-id", "wi_0123456789abcdef",
    "--audience", "https://acme.auth.stg.thoryn.org/dev",
    "--scope", "tenant:applications.read tenant:applications.write tenant:users.read tenant:users.write tenant:environments.read",
  ]);
});

test("login.sh for the config project's production connection has no sandbox in the audience", () => {
  const r = repo("config");
  const res = run(r, "login.sh", ["production"], {
    THORYN_ISSUER: "https://auth.stg.thoryn.org/",
    THORYN_WORKSPACE: "acme",
    THORYN_PRODUCTION_WIF_CLIENT_ID: "wi_prod",
  });
  assert.equal(res.status, 0, res.stderr + res.stdout);
  const args = r.args();
  assert.equal(args[args.indexOf("--audience") + 1], "https://acme.auth.stg.thoryn.org");
  assert.equal(args[args.indexOf("--client-id") + 1], "wi_prod");
  assert.equal(args[args.indexOf("--scope") + 1], "tenant:environments.read tenant:environments.write tenant:idp.read tenant:idp.write");
});

test("login.sh names every missing variable, with where to set it, and never calls the CLI", () => {
  const r = repo("config");
  const res = run(r, "login.sh", ["production"], { GITHUB_ACTIONS: "true", THORYN_ISSUER: "https://auth.stg.thoryn.org" });
  assert.equal(res.status, 1);
  assert.match(res.stdout, /::error title=Thoryn variable THORYN_WORKSPACE is not set::.*a repository variable/);
  assert.match(res.stdout, /::error title=Thoryn variable THORYN_PRODUCTION_WIF_CLIENT_ID is not set::.*GitHub environment "thoryn-production"/);
  assert.doesNotMatch(res.stdout, /THORYN_ISSUER is not set/);
  assert.throws(() => r.args(), /ENOENT/);
});

test("login.sh refuses a sandbox that is not a slug, and honours THORYN_AUDIENCE", () => {
  const r = repo("express");
  assert.equal(run(r, "login.sh", ["sandbox"], { ...app, THORYN_ENVIRONMENT: "dev/../prod" }).status, 1);
  const res = run(r, "login.sh", ["sandbox"], { ...app, THORYN_AUDIENCE: "https://login.acme.com/dev" });
  assert.equal(res.status, 0, res.stderr);
  assert.ok(r.args().includes("https://login.acme.com/dev"));
});

test("login.sh refuses a connection the declaration does not have", () => {
  const res = run(repo("express"), "login.sh", ["production"], app);
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /declares no connection "production"/);
});

test("gate.sh is ready when every variable is set", () => {
  const r = repo();
  const out = join(r.dir, "out");
  const res = run(r, "gate.sh", Object.keys(app), { ...app, GITHUB_OUTPUT: out, GITHUB_ACTIONS: "true" });
  assert.equal(res.status, 0, res.stdout);
  assert.equal(readFileSync(out, "utf8"), "ready=true\n");
});

test("gate.sh fails naming the missing variable once any is set", () => {
  const r = repo();
  const res = run(r, "gate.sh", Object.keys(app), { ...app, THORYN_WIF_CLIENT_ID: "", GITHUB_OUTPUT: join(r.dir, "out"), GITHUB_ACTIONS: "true", FIRST_PUSH: "true" });
  assert.equal(res.status, 1);
  assert.match(res.stdout, /THORYN_WIF_CLIENT_ID is not set/);
});

test("gate.sh skips with a notice: the template repository, a fork, and a just-created repository without variables", () => {
  for (const env of [{ ...app, IS_TEMPLATE: "true" }, { ...app, FORK: "true" }, { FIRST_PUSH: "true" }]) {
    const r = repo();
    const out = join(r.dir, "out");
    const res = run(r, "gate.sh", Object.keys(app), { ...env, GITHUB_OUTPUT: out, GITHUB_ACTIONS: "true" });
    assert.equal(res.status, 0, res.stdout);
    assert.match(res.stdout, /::notice::/);
    assert.equal(readFileSync(out, "utf8"), "ready=false\n");
  }
});

test("gate.sh fails without variables on any later run", () => {
  const r = repo();
  const res = run(r, "gate.sh", Object.keys(app), { GITHUB_OUTPUT: join(r.dir, "out"), GITHUB_ACTIONS: "true", FIRST_PUSH: "false" });
  assert.equal(res.status, 1);
  for (const name of Object.keys(app)) assert.match(res.stdout, new RegExp(`${name} is not set`));
});

test("provision.sh stops before signing in when a variable is missing, outside Actions too", () => {
  const r = repo();
  const res = run(r, "provision.sh", [], { THORYN_ISSUER: app.THORYN_ISSUER, THORYN_WORKSPACE: "acme" });
  assert.equal(res.status, 1);
  assert.match(res.stderr, /error: THORYN_ENVIRONMENT is not set\..*export THORYN_ENVIRONMENT/);
  assert.throws(() => r.args(), /ENOENT/);
});
