// SSO-3428 — the shared CI steps read their wiring from the environment (the Actions variables the
// workflow maps in), never from a rendered file. These tests run the real scripts with a fake `thoryn`
// on PATH that records its arguments.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
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
    "--scope", "tenant:applications.read tenant:applications.write tenant:access.read tenant:environments.read tenant:test-identities.write",
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
  // Exactly the connection's declared scopes, in order (SSO-3993: read and write for every tenant kind).
  const declared = JSON.parse(readFileSync(join(root, "starters/config/.thoryn/template.json"), "utf8")).connections.production.scopes;
  assert.ok(declared.includes("tenant:roles.write"), declared.join(" "));
  assert.equal(args[args.indexOf("--scope") + 1], declared.join(" "));
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

/** A repository with app-env.mjs too, and a `thoryn` that answers `whoami` like a signed-in session. */
function localRepo(whoami) {
  const r = repo("express");
  cpSync(join(root, "shared/thoryn/app-env.mjs"), join(r.dir, ".thoryn/app-env.mjs"));
  const log = join(r.dir, "thoryn.log");
  writeFileSync(join(r.bin, "thoryn"), `#!/usr/bin/env bash
if [ "$1" = "whoami" ]; then printf '%s' '${JSON.stringify(whoami)}'; exit 0; fi
echo "$* | ws=$THORYN_WORKSPACE env=$THORYN_ENVIRONMENT app=$THORYN_APP_NAME" >> "${log}"
`);
  chmodSync(join(r.bin, "thoryn"), 0o755);
  return { ...r, calls: () => readFileSync(log, "utf8").trim().split("\n") };
}

test("provision.sh runs locally from the thoryn login session: no Actions variable, its own local client", () => {
  const r = localRepo({ issuer: "https://acme.auth.stg.thoryn.org", activeEnvironment: "dev" });
  const res = run(r, "provision.sh", [], { USER: "dana", THORYN_TEST_USER_EMAIL: "dana+test@example.com", THORYN_TEST_USER_PASSWORD: "x" });
  assert.match(res.stdout, /Local run: workspace acme, sandbox dev/);
  assert.doesNotMatch(res.stdout, /::add-mask::/);
  const calls = r.calls();
  const app = `${r.dir.split("/").pop()}-local-dana`;
  assert.deepEqual(calls, [
    `provision plan --file .thoryn/provision.yaml | ws=acme env=dev app=${app}`,
    `provision apply --file .thoryn/provision.yaml --yes | ws=acme env=dev app=${app}`,
  ]);
  assert.ok(!calls.some((c) => c.startsWith("login")), "a local run uses your own session, never workload identity");
});

test("provision.sh locally: an exported value wins over the session, and a missing sandbox is named", () => {
  const r = localRepo({ issuer: "https://acme.auth.stg.thoryn.org", activeEnvironment: "dev" });
  run(r, "provision.sh", [], { THORYN_ENVIRONMENT: "qa", THORYN_TEST_USER_EMAIL: "a@example.com", THORYN_TEST_USER_PASSWORD: "x" });
  assert.match(r.calls()[0], /env=qa/);

  const noEnv = localRepo({ issuer: "https://acme.auth.stg.thoryn.org" });
  const res = run(noEnv, "provision.sh", [], { THORYN_TEST_USER_EMAIL: "a@example.com", THORYN_TEST_USER_PASSWORD: "x" });
  assert.equal(res.status, 1);
  assert.match(res.stderr, /THORYN_ENVIRONMENT is not set.*thoryn env use <sandbox>/);
});

test("provision.sh refuses production: an application project provisions into a sandbox only", () => {
  const r = localRepo({ issuer: "https://acme.auth.stg.thoryn.org", activeEnvironment: "dev" });
  const res = run(r, "provision.sh", [], { THORYN_ENVIRONMENT: "production" });
  assert.equal(res.status, 1);
  assert.match(res.stderr, /provisions into a sandbox only/);
  assert.throws(() => r.calls(), /ENOENT/);
});

// SSO-4087 — the test account is an ephemeral sandbox test identity (oauthy ADR 2026-10-30): minted by the CLI, never
// declared in provision.yaml, never written to a file.
test("provision.sh locally mints nothing and writes no test-user file: it prints the one eval line that mints a 24-hour test identity into your shell", () => {
  const r = localRepo({ issuer: "https://acme.auth.stg.thoryn.org", activeEnvironment: "dev" });
  const res = run(r, "provision.sh", [], { USER: "Dana" });
  assert.equal(existsSync(join(r.dir, ".thoryn/local.env")), false, "the .thoryn/local.env mechanism is retired");
  assert.ok(res.stdout.includes('eval "$(thoryn env test-identity create --env dev --lifetime PT24H --output env)"'), res.stdout);
  assert.match(res.stdout, /mint again before you run it a second time/);
  assert.ok(!r.calls().some((c) => c.startsWith("env test-identity")), "a script cannot export into its parent shell, so it does not mint: you do");
  assert.deepEqual(r.calls().map((c) => c.split(" | ")[0]), ["provision plan --file .thoryn/provision.yaml", "provision apply --file .thoryn/provision.yaml --yes"]);

  // An exported pair (a sandbox user of your own) wins, and the hint is not printed.
  const exported = run(r, "provision.sh", [], { THORYN_TEST_USER_EMAIL: "mine@example.com", THORYN_TEST_USER_PASSWORD: "x" });
  assert.ok(exported.stdout.includes("Test user: mine@example.com (exported)"), exported.stdout);
  assert.doesNotMatch(exported.stdout, /test-identity create/);
  assert.ok(!(exported.stdout + exported.stderr).includes("THORYN_TEST_USER_PASSWORD=x"), "the password is never printed");
});

/** An Actions-shaped repository: app-env.mjs stubbed (it is unit-tested on its own) and a `thoryn` that logs every call. */
function actionsRepo() {
  const r = repo("express");
  writeFileSync(join(r.dir, ".thoryn/app-env.mjs"), "process.exit(0);\n");
  const log = join(r.dir, "thoryn.log");
  writeFileSync(join(r.bin, "thoryn"), `#!/usr/bin/env bash
echo "$*" >> "${log}"
`);
  chmodSync(join(r.bin, "thoryn"), 0o755);
  return { ...r, calls: () => readFileSync(log, "utf8").trim().split("\n") };
}

const actions = { ...app, GITHUB_ACTIONS: "true", GITHUB_REPOSITORY: "acme/shop", GITHUB_RUN_ID: "41094232255", GITHUB_RUN_ATTEMPT: "2" };

test("provision.sh in Actions mints one test identity per run, after the sandbox sign-in and the apply, into $GITHUB_ENV through the CLI", () => {
  const r = actionsRepo();
  const githubEnv = join(r.dir, "github.env");
  const res = run(r, "provision.sh", [], { ...actions, GITHUB_ENV: githubEnv });
  assert.equal(res.status, 0, res.stderr + res.stdout);
  const calls = r.calls();
  assert.equal(calls.length, 4, calls.join("\n"));
  assert.match(calls[0], /^login --workload-identity /);
  assert.equal(calls[1], "provision plan --file .thoryn/provision.yaml");
  assert.equal(calls[2], "provision apply --file .thoryn/provision.yaml --yes");
  // The mint: the sandbox named explicitly, the label = the client's name (the repository) + the run, github-env output
  // (the CLI prints ::add-mask:: first, then appends the three THORYN_TEST_* variables for the next steps).
  assert.equal(calls[3], "env test-identity create --env dev --label shop-41094232255-2 --output github-env");
  // The script itself handles no credential any more: it exports only the client's name.
  assert.equal(readFileSync(githubEnv, "utf8"), "THORYN_APP_NAME=shop\n");
  assert.doesNotMatch(res.stdout, /::add-mask::/);
  assert.equal(existsSync(join(r.dir, ".thoryn/local.env")), false);
});

test("provision.sh in Actions: the label is the sanitised client name (THORYN_APP_NAME) plus the run, within the API's 64-character grammar", () => {
  const r = actionsRepo();
  run(r, "provision.sh", [], { ...actions, GITHUB_ENV: join(r.dir, "github.env"), THORYN_APP_NAME: "My Shop (staging)!" });
  assert.equal(r.calls().at(-1), "env test-identity create --env dev --label My-Shop--staging---41094232255-2 --output github-env");

  const long = actionsRepo();
  run(long, "provision.sh", [], { ...actions, GITHUB_ENV: join(long.dir, "github.env"), THORYN_APP_NAME: "a".repeat(100) });
  const label = long.calls().at(-1).match(/--label (\S+)/)[1];
  assert.equal(label, `${"a".repeat(40)}-41094232255-2`);
  assert.ok(label.length <= 64 && /^[A-Za-z0-9._-]{1,64}$/.test(label), label);
});

test("provision.sh in Actions mints nothing when the sign-in or the apply fails", () => {
  const r = actionsRepo();
  writeFileSync(join(r.bin, "thoryn"), `#!/usr/bin/env bash
echo "$*" >> "${join(r.dir, "thoryn.log")}"
[[ "$1" == "provision" && "$2" == "apply" ]] && exit 1
exit 0
`);
  const res = run(r, "provision.sh", [], { ...actions, GITHUB_ENV: join(r.dir, "github.env") });
  assert.notEqual(res.status, 0);
  assert.ok(!r.calls().some((c) => c.startsWith("env test-identity")), r.calls().join("\n"));
});

test("teardown.sh revokes the run's test identity in its sandbox, then destroys what the apply created; each part runs even when the other fails", () => {
  const r = actionsRepo();
  writeFileSync(join(r.dir, ".thoryn/provision.receipt.json"), "{}");
  const res = run(r, "teardown.sh", [], { ...actions, THORYN_TEST_IDENTITY_ID: "5d1c2b3a-0000-4000-8000-000000000001" });
  assert.equal(res.status, 0, res.stderr + res.stdout);
  assert.deepEqual(r.calls(), [
    "env test-identity revoke 5d1c2b3a-0000-4000-8000-000000000001 --env dev",
    "provision destroy --file .thoryn/provision.yaml --yes",
  ]);

  // A failing revoke (the identity already expired and purged, a network blip) does not skip the destroy, and the step is red.
  const failing = actionsRepo();
  writeFileSync(join(failing.dir, ".thoryn/provision.receipt.json"), "{}");
  writeFileSync(join(failing.bin, "thoryn"), `#!/usr/bin/env bash
echo "$*" >> "${join(failing.dir, "thoryn.log")}"
[[ "$1 $2 $3" == "env test-identity revoke" ]] && exit 1
exit 0
`);
  const red = run(failing, "teardown.sh", [], { ...actions, THORYN_TEST_IDENTITY_ID: "ti-1" });
  assert.equal(red.status, 1);
  assert.equal(failing.calls().length, 2, failing.calls().join("\n"));
  assert.equal(failing.calls()[1], "provision destroy --file .thoryn/provision.yaml --yes");
});

test("teardown.sh with no identity minted and no receipt calls the CLI for nothing and exits 0", () => {
  const r = actionsRepo();
  const res = run(r, "teardown.sh", [], actions);
  assert.equal(res.status, 0, res.stderr + res.stdout);
  assert.match(res.stdout, /No test identity to revoke/);
  assert.match(res.stdout, /Nothing to destroy/);
  assert.throws(() => r.calls(), /ENOENT/);

  // Only the identity (provision.sh failed after the mint, or the receipt is gone): revoke it, and without a sandbox in the
  // environment the CLI's selected environment applies.
  const only = actionsRepo();
  run(only, "teardown.sh", [], { GITHUB_ACTIONS: "true", THORYN_TEST_IDENTITY_ID: "ti-2" });
  assert.deepEqual(only.calls(), ["env test-identity revoke ti-2"]);
});
