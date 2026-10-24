// SSO-3675 — the publish gate, the mirror and its verification are what make publish.yml's green mean
// "the template repositories hold the starters". These tests run the real scripts: the gate with the
// workflow's environment shape, the mirror + verification end to end against a local bare repository
// standing in for thoryn-io/starter-<name> (a fake `gh` on PATH answers the repository API), and the
// tree assertion against fixture directories.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PUBLISH_ENVIRONMENT, PUBLISH_WORKFLOW, checkPublishEnvironment, checkPublishMatrix } from "./validate-templates.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const scripts = join(root, "scripts/publish");

function run(script, args, { env = {}, cwd } = {}) {
  const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("GITHUB_") && k !== "GH_TOKEN"));
  return spawnSync("bash", [join(scripts, script), ...args], { cwd, env: { ...clean, ...env }, encoding: "utf8" });
}

/** A fake `gh` whose `api repos/<x>` answers with the given JSON. */
function fakeGh(dir, json) {
  const bin = join(dir, "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "gh"), `#!/usr/bin/env bash
# gh api repos/<owner/repo> --jq <expr>: answer the fields the publish scripts read.
case "$*" in
  *--jq\\ .default_branch*) echo "${json.default_branch ?? ""}";;
  *--jq\\ .is_template*) echo "${json.is_template ?? ""}";;
  *) echo "fake gh: unexpected call: $*" >&2; exit 1;;
esac
`);
  chmodSync(join(bin, "gh"), 0o755);
  return `${bin}:${process.env.PATH}`;
}

function fixture(files) {
  const dir = mkdtempSync(join(tmpdir(), "mirror-fixture-"));
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), content);
  }
  return dir;
}
const starterFiles = { "README.md": "# hi\n", "src/app.js": "export default 1;\n", ".thoryn/template.json": "{}\n", ".github/workflows/ci.yml": "on: push\n" };

// --- gate.sh -----------------------------------------------------------------------------------------

const gateEnv = { PUBLISH_ENVIRONMENT: "starters-publish" };

test("gate.sh fails, as an ::error naming the environment and docs/publishing.md, when the App id variable is unset", () => {
  const res = run("gate.sh", [], { env: { ...gateEnv, APP_ID: "", HAS_PRIVATE_KEY: "true" } });
  assert.equal(res.status, 1, res.stdout);
  assert.match(res.stdout, /^::error title=The template publisher is not configured::/m);
  assert.match(res.stdout, /needs the variable STARTERS_PUBLISH_APP_ID in the GitHub environment starters-publish\./);
  assert.match(res.stdout, /docs\/publishing\.md/);
  assert.doesNotMatch(res.stdout, /::notice::/);
});

test("gate.sh fails when the private key secret is absent, and names both when both are missing", () => {
  const one = run("gate.sh", [], { env: { ...gateEnv, APP_ID: "12345", HAS_PRIVATE_KEY: "false" } });
  assert.equal(one.status, 1);
  assert.match(one.stdout, /needs the secret STARTERS_PUBLISH_APP_PRIVATE_KEY in the GitHub environment starters-publish\./);
  assert.doesNotMatch(one.stdout, /STARTERS_PUBLISH_APP_ID/);
  const both = run("gate.sh", [], { env: gateEnv });
  assert.equal(both.status, 1);
  assert.match(both.stdout, /STARTERS_PUBLISH_APP_ID and the secret STARTERS_PUBLISH_APP_PRIVATE_KEY in the GitHub environment/);
});

test("gate.sh passes only with the variable set and the secret present, and never prints a secret value", () => {
  const res = run("gate.sh", [], { env: { ...gateEnv, APP_ID: "12345", HAS_PRIVATE_KEY: "true" } });
  assert.equal(res.status, 0, res.stdout);
  assert.match(res.stdout, /Publisher configured/);
  assert.doesNotMatch(res.stdout, /12345/);
});

test("gate.sh refuses to run without the environment's name rather than guessing it", () => {
  const res = run("gate.sh", [], { env: { APP_ID: "12345", HAS_PRIVATE_KEY: "true" } });
  assert.notEqual(res.status, 0);
  assert.doesNotMatch(res.stdout, /Publisher configured/);
});

// --- assert-environment.sh ----------------------------------------------------------------------------

/**
 * A fake `gh` answering the two environment reads assert-environment.sh makes. `environment` is the GET
 * environment body (null ⇒ HTTP 404, "error" ⇒ HTTP 403); `rules` the branch_policies list.
 */
function fakeEnvGh(dir, { environment, rules = [] }) {
  const bin = join(dir, "bin");
  mkdirSync(bin, { recursive: true });
  const envJson = JSON.stringify(environment ?? {});
  const rulesJson = JSON.stringify({ total_count: rules.length, branch_policies: rules });
  writeFileSync(join(bin, "gh"), `#!/usr/bin/env bash
# gh api <path> --jq <expr>: evaluate the expression with jq over a canned body, like gh does.
path=$2; expr=$4
case "$path" in
  */deployment-branch-policies)
    ${rules === "error" ? `echo "gh: Resource not accessible by integration (HTTP 403)" >&2; exit 1` : ""}
    jq -r "$expr" <<<'${rulesJson}';;
  repos/*/environments/*)
    ${environment === null ? `echo '{"message":"Not Found","status":"404"}'; echo "gh: Not Found (HTTP 404)" >&2; exit 1` : ""}
    ${environment === "error" ? `echo "gh: Resource not accessible by integration (HTTP 403)" >&2; exit 1` : ""}
    jq -r "$expr" <<<'${envJson}';;
  *) echo "fake gh: unexpected call: $*" >&2; exit 1;;
esac
`);
  chmodSync(join(bin, "gh"), 0o755);
  return `${bin}:${process.env.PATH}`;
}

const mainOnly = { environment: { name: "starters-publish", deployment_branch_policy: { protected_branches: false, custom_branch_policies: true } }, rules: [{ id: 1, name: "main", type: "branch" }] };

function assertEnvironment(gh, env = {}) {
  const dir = mkdtempSync(join(tmpdir(), "environment-"));
  return run("assert-environment.sh", ["thoryn-io/thoryn-starters", "starters-publish"], { env: { PATH: fakeEnvGh(dir, gh), KEY_OUTSIDE_ENVIRONMENT: "false", ...env } });
}

test("assert-environment.sh passes for an environment only main can deploy to, with no repository-level key", () => {
  const res = assertEnvironment(mainOnly);
  assert.equal(res.status, 0, res.stdout + res.stderr);
  assert.match(res.stdout, /only the branch main can deploy/);
});

test("assert-environment.sh fails when the key is also readable outside the environment (a repository secret)", () => {
  const res = assertEnvironment(mainOnly, { KEY_OUTSIDE_ENVIRONMENT: "true" });
  assert.equal(res.status, 1);
  assert.match(res.stdout, /^::error title=The publish key is not confined to main::STARTERS_PUBLISH_APP_PRIVATE_KEY is readable outside the environment starters-publish/m);
  assert.match(res.stdout, /gh secret delete STARTERS_PUBLISH_APP_PRIVATE_KEY -R thoryn-io\/thoryn-starters/);
});

test("assert-environment.sh fails when the environment does not exist, instead of letting the publish job create it unprotected", () => {
  const res = assertEnvironment({ environment: null });
  assert.equal(res.status, 1);
  assert.match(res.stdout, /the environment starters-publish does not exist on thoryn-io\/thoryn-starters/);
});

test("assert-environment.sh fails for an environment with no branch policy, or one open to every protected branch", () => {
  const none = assertEnvironment({ environment: { deployment_branch_policy: null } });
  assert.equal(none.status, 1);
  assert.match(none.stdout, /has no deployment-branch policy, so a job on any branch can read its secrets/);
  const prot = assertEnvironment({ environment: { deployment_branch_policy: { protected_branches: true, custom_branch_policies: false } } });
  assert.equal(prot.status, 1);
  assert.match(prot.stdout, /may be deployed from any protected branch/);
});

test("assert-environment.sh fails unless the selected-branch rules are exactly the branch main", () => {
  const custom = { protected_branches: false, custom_branch_policies: true };
  for (const rules of [
    [],
    [{ name: "main", type: "branch" }, { name: "release/*", type: "branch" }],
    [{ name: "*", type: "branch" }],
    [{ name: "main", type: "tag" }],
  ]) {
    const res = assertEnvironment({ environment: { deployment_branch_policy: custom }, rules });
    assert.equal(res.status, 1, JSON.stringify(rules));
    assert.match(res.stdout, /it must allow exactly the branch main/, JSON.stringify(rules));
  }
});

test("assert-environment.sh fails, rather than passing, when it cannot read the environment or its branch rules", () => {
  const res = assertEnvironment({ environment: "error" });
  assert.equal(res.status, 1);
  assert.match(res.stdout, /could not read the environment starters-publish \(the job needs permissions: actions: read\)/);
  const rules = assertEnvironment({ environment: mainOnly.environment, rules: "error" });
  assert.equal(rules.status, 1);
  assert.match(rules.stdout, /could not read the deployment-branch rules of the environment starters-publish/);
});

// --- assert-mirror.sh ----------------------------------------------------------------------------------

test("assert-mirror.sh passes for an identical tree (ignoring .git and node_modules)", () => {
  const source = fixture(starterFiles);
  const mirror = fixture({ ...starterFiles, ".git/HEAD": "ref: refs/heads/main\n", "node_modules/x/index.js": "x" });
  const res = run("assert-mirror.sh", [source, mirror]);
  assert.equal(res.status, 0, res.stdout);
  assert.match(res.stdout, /Mirror verified: 4 files/);
});

test("assert-mirror.sh fails when the mirror misses a file, naming it", () => {
  const source = fixture(starterFiles);
  const { "src/app.js": _, ...rest } = starterFiles;
  const mirror = fixture(rest);
  const res = run("assert-mirror.sh", [source, mirror]);
  assert.equal(res.status, 1);
  assert.match(res.stdout, /::error::assert-mirror: the mirror .* differs .*\(3 files, expected 4\)/);
  assert.match(res.stdout, /^< [0-9a-f]{64} - src\/app\.js$/m);
});

test("assert-mirror.sh fails when the mirror is EMPTY", () => {
  const source = fixture(starterFiles);
  const mirror = fixture({});
  const res = run("assert-mirror.sh", [source, mirror]);
  assert.equal(res.status, 1);
  assert.match(res.stdout, /the mirror .* is EMPTY \(expected 4 files/);
});

test("assert-mirror.sh fails on changed content, an extra file, and a lost executable bit", () => {
  const source = fixture({ ...starterFiles, mvnw: "#!/bin/sh\n" });
  chmodSync(join(source, "mvnw"), 0o755);
  const changed = fixture({ ...starterFiles, mvnw: "#!/bin/sh\n", "README.md": "# changed\n" });
  chmodSync(join(changed, "mvnw"), 0o755);
  assert.equal(run("assert-mirror.sh", [source, changed]).status, 1, "changed content");

  const extra = fixture({ ...starterFiles, mvnw: "#!/bin/sh\n", "stale.txt": "left over from an older publish\n" });
  chmodSync(join(extra, "mvnw"), 0o755);
  const res = run("assert-mirror.sh", [source, extra]);
  assert.equal(res.status, 1, "extra file");
  assert.match(res.stdout, /^> [0-9a-f]{64} - stale\.txt$/m);

  const noExec = fixture({ ...starterFiles, mvnw: "#!/bin/sh\n" });
  const lost = run("assert-mirror.sh", [source, noExec]);
  assert.equal(lost.status, 1, "executable bit");
  assert.match(lost.stdout, /^< [0-9a-f]{64} x mvnw$/m);
  assert.match(lost.stdout, /^> [0-9a-f]{64} - mvnw$/m);
});

test("assert-mirror.sh refuses an empty source rather than calling an empty mirror correct", () => {
  const res = run("assert-mirror.sh", [fixture({}), fixture({})]);
  assert.equal(res.status, 1);
  assert.match(res.stdout, /the source .* has no files/);
});

// --- mirror.sh + verify-published.sh, end to end against a local bare repository ---------------------

/**
 * A bare repository standing in for thoryn-io/starter-<name>, empty like the real ones were. Its default
 * branch is `trunk`, deliberately not the machine's init.defaultBranch, so these tests prove mirror.sh
 * lands the first publish on the branch GitHub reports rather than on whatever the runner defaults to.
 */
const BRANCH = "trunk";
function bareTarget() {
  const dir = mkdtempSync(join(tmpdir(), "publish-e2e-"));
  const bare = join(dir, "starter-demo.git");
  assert.equal(spawnSync("git", ["init", "-q", "--bare", `--initial-branch=${BRANCH}`, bare]).status, 0);
  return { dir, bare, url: `file://${bare}` };
}
const git = (args, cwd) => spawnSync("git", args, { cwd, encoding: "utf8" }).stdout.trim();

function mirror(t, source, extraEnv = {}) {
  const out = join(t.dir, `out-${Date.now()}-${Math.random()}`);
  const res = run("mirror.sh", [source, "thoryn-io/starter-demo"], {
    cwd: t.dir,
    env: { PATH: fakeGh(t.dir, { default_branch: BRANCH, is_template: true }), TARGET_URL: t.url, SHA: "abc123", WORK_DIR: join(t.dir, `work-${Math.random()}`), GITHUB_OUTPUT: out, ...extraEnv },
  });
  const outputs = res.status === 0 ? Object.fromEntries(readFileSync(out, "utf8").trim().split("\n").map((l) => l.split("="))) : {};
  return { res, outputs };
}

test("mirror.sh publishes a starter into an EMPTY repository on its default branch, and verify-published.sh accepts the result", () => {
  const t = bareTarget();
  const source = fixture(starterFiles);
  const { res, outputs } = mirror(t, source);
  assert.equal(res.status, 0, res.stdout + res.stderr);
  assert.equal(outputs.branch, BRANCH);
  assert.match(outputs.commit, /^[0-9a-f]{40}$/);
  assert.equal(git(["rev-parse", `refs/heads/${BRANCH}`], t.bare), outputs.commit);
  assert.equal(git(["log", "-1", "--format=%s %an", BRANCH], t.bare), "Publish from thoryn-io/thoryn-starters@abc123 thoryn-starters publish");
  assert.deepEqual(git(["ls-tree", "-r", "--name-only", BRANCH], t.bare).split("\n").sort(), Object.keys(starterFiles).sort());

  const verify = run("verify-published.sh", [source, "thoryn-io/starter-demo", BRANCH, outputs.commit], {
    cwd: t.dir,
    env: { TARGET_URL: t.url, VERIFY_DIR: join(t.dir, "verify-1") },
  });
  assert.equal(verify.status, 0, verify.stdout + verify.stderr);
  assert.match(verify.stdout, /Mirror verified: 4 files/);
  assert.match(verify.stdout, new RegExp(`Published thoryn-io/starter-demo@${BRANCH} verified at ${outputs.commit}`));
});

test("mirror.sh lands a first publish on GitHub's default branch even when the clone cannot learn it (protocol v0, as older git)", () => {
  // Over protocol v2 git ≥ 2.31 copies the remote's unborn HEAD; over v0 (or with older git) the empty clone
  // sits on the runner's init.defaultBranch instead, which is exactly when the script's own branch handling
  // must take over. Forcing v0 keeps that path exercised on modern git.
  const t = bareTarget();
  const { res, outputs } = mirror(t, fixture(starterFiles), { GIT_CONFIG_COUNT: "2", GIT_CONFIG_KEY_0: "protocol.version", GIT_CONFIG_VALUE_0: "0", GIT_CONFIG_KEY_1: "init.defaultBranch", GIT_CONFIG_VALUE_1: "master" });
  assert.equal(res.status, 0, res.stdout + res.stderr);
  assert.equal(outputs.branch, BRANCH);
  assert.equal(git(["rev-parse", `refs/heads/${BRANCH}`], t.bare), outputs.commit, "the publish is on the default branch GitHub reports");
  assert.equal(git(["for-each-ref", "--format=%(refname)", "refs/heads"], t.bare), `refs/heads/${BRANCH}`, "and on no other branch");
});

test("mirror.sh takes the source as a path relative to the job workspace, like publish.yml passes it", () => {
  // publish.yml runs `mirror.sh "source/starters/$STARTER" …` from the workspace; the script cds into the
  // clone, so the relative path must be resolved first (the fixtures above are absolute and would not notice).
  const t = bareTarget();
  mkdirSync(join(t.dir, "source/starters"), { recursive: true });
  const source = join(t.dir, "source/starters/demo");
  cpSync(fixture(starterFiles), source, { recursive: true });
  const { res, outputs } = mirror(t, "source/starters/demo");
  assert.equal(res.status, 0, res.stdout + res.stderr);
  assert.deepEqual(git(["ls-tree", "-r", "--name-only", BRANCH], t.bare).split("\n").sort(), Object.keys(starterFiles).sort());
  const verify = run("verify-published.sh", ["source/starters/demo", "thoryn-io/starter-demo", BRANCH, outputs.commit], { cwd: t.dir, env: { TARGET_URL: t.url, VERIFY_DIR: "verify-rel" } });
  assert.equal(verify.status, 0, verify.stdout + verify.stderr);
});

test("mirror.sh is idempotent (no commit when up to date) and --delete removes files the starter no longer has", () => {
  const t = bareTarget();
  const source = fixture(starterFiles);
  const first = mirror(t, source);
  assert.equal(first.res.status, 0, first.res.stderr);
  const again = mirror(t, source);
  assert.equal(again.res.status, 0, again.res.stderr);
  assert.match(again.res.stdout, /already up to date/);
  assert.equal(again.outputs.commit, first.outputs.commit);

  rmSync(join(source, "src/app.js"));
  writeFileSync(join(source, "README.md"), "# v2\n");
  const third = mirror(t, source);
  assert.equal(third.res.status, 0, third.res.stderr);
  assert.notEqual(third.outputs.commit, first.outputs.commit);
  assert.deepEqual(git(["ls-tree", "-r", "--name-only", BRANCH], t.bare).split("\n").sort(), [".github/workflows/ci.yml", ".thoryn/template.json", "README.md"]);
});

test("verify-published.sh fails when the repository is still empty, at another commit, or holds a different tree", () => {
  const t = bareTarget();
  const source = fixture(starterFiles);
  const empty = run("verify-published.sh", [source, "thoryn-io/starter-demo", BRANCH, "0".repeat(40)], { cwd: t.dir, env: { TARGET_URL: t.url, VERIFY_DIR: join(t.dir, "v0") } });
  assert.equal(empty.status, 1);
  assert.match(empty.stdout, new RegExp(`has no branch ${BRANCH} to clone \\(is the repository still empty\\?\\)`));

  const { outputs } = mirror(t, source);
  const wrongCommit = run("verify-published.sh", [source, "thoryn-io/starter-demo", BRANCH, "1".repeat(40)], { cwd: t.dir, env: { TARGET_URL: t.url, VERIFY_DIR: join(t.dir, "v1") } });
  assert.equal(wrongCommit.status, 1);
  assert.match(wrongCommit.stdout, new RegExp(`is at ${outputs.commit}, not the published commit 1{40}`));

  // Someone edited the template repository by hand (or the mirror dropped a file): the tree differs.
  writeFileSync(join(source, "README.md"), "# edited after publishing\n");
  const diverged = run("verify-published.sh", [source, "thoryn-io/starter-demo", BRANCH, outputs.commit], { cwd: t.dir, env: { TARGET_URL: t.url, VERIFY_DIR: join(t.dir, "v2") } });
  assert.equal(diverged.status, 1);
  assert.match(diverged.stdout, /::error::assert-mirror: the mirror .* differs/);
  assert.match(diverged.stdout, /README\.md/);
});

test("mirror.sh honours the starter's .gitignore only for untracked junk: a file it would silently drop fails verification", () => {
  // The real bug class: starters/<name>/.gitignore ignores a path that thoryn-starters nevertheless tracks.
  // rsync copies it, `git add` in the mirror skips it, and without verification the publish is green.
  const t = bareTarget();
  const source = fixture({ ...starterFiles, ".gitignore": "config/\n", "config/needed.json": "{}\n" });
  const { res, outputs } = mirror(t, source);
  assert.equal(res.status, 0, res.stderr);
  const verify = run("verify-published.sh", [source, "thoryn-io/starter-demo", BRANCH, outputs.commit], { cwd: t.dir, env: { TARGET_URL: t.url, VERIFY_DIR: join(t.dir, "v") } });
  assert.equal(verify.status, 1);
  assert.match(verify.stdout, /^< [0-9a-f]{64} - config\/needed\.json$/m);
});

// --- assert-template-repo.sh ----------------------------------------------------------------------------

test("assert-template-repo.sh passes for a template repository and fails, with the fixing command, otherwise", () => {
  const dir = mkdtempSync(join(tmpdir(), "template-"));
  const ok = run("assert-template-repo.sh", ["thoryn-io/starter-demo"], { env: { PATH: fakeGh(dir, { is_template: true }) } });
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  const dir2 = mkdtempSync(join(tmpdir(), "template-"));
  const no = run("assert-template-repo.sh", ["thoryn-io/starter-demo"], { env: { PATH: fakeGh(dir2, { is_template: false }) } });
  assert.equal(no.status, 1);
  assert.match(no.stdout, /::error title=thoryn-io\/starter-demo is not a template repository::.*Fix: gh repo edit thoryn-io\/starter-demo --template/);
});

// --- the publish matrix equals starters/* (npm run check) ---------------------------------------------

function repoCopy() {
  const dir = mkdtempSync(join(tmpdir(), "matrix-"));
  mkdirSync(join(dir, ".github/workflows"), { recursive: true });
  cpSync(join(root, PUBLISH_WORKFLOW), join(dir, PUBLISH_WORKFLOW));
  for (const s of ["aspnet-core", "config", "express", "spring-boot"]) mkdirSync(join(dir, "starters", s), { recursive: true });
  return dir;
}

test("this repository's publish matrix names exactly the starters/* directories", () => {
  assert.deepEqual(checkPublishMatrix(root), []);
});

test("a new starter directory that the publish matrix does not name fails the check", () => {
  const dir = repoCopy();
  mkdirSync(join(dir, "starters/fastapi"));
  assert.deepEqual(checkPublishMatrix(dir), [`starters/fastapi is not in the publish matrix of ${PUBLISH_WORKFLOW}; add it or it is never published`]);
});

test("a matrix entry without a starter directory fails the check, and so does a non-literal matrix", () => {
  const dir = repoCopy();
  rmSync(join(dir, "starters/config"), { recursive: true });
  assert.deepEqual(checkPublishMatrix(dir), [`${PUBLISH_WORKFLOW} publishes "config", but starters/config does not exist`]);

  const dynamic = repoCopy();
  writeFileSync(join(dynamic, PUBLISH_WORKFLOW), readFileSync(join(dynamic, PUBLISH_WORKFLOW), "utf8").replace(/starter: \[.*\]/, "starter: ${{ fromJSON(needs.plan.outputs.starters) }}"));
  assert.match(checkPublishMatrix(dynamic).join("\n"), /must be a literal list of starter names/);
});

// --- the publish token is minted only in the main-only environment (npm run check) ------------------------

function editedWorkflow(edit) {
  const dir = repoCopy();
  const path = join(dir, PUBLISH_WORKFLOW);
  const before = readFileSync(path, "utf8");
  const after = edit(before);
  assert.notEqual(after, before, "the edit must change the workflow");
  writeFileSync(path, after);
  return dir;
}

test("this repository's publish workflow mints the App token only in the main-only environment, gated, after the policy check", () => {
  assert.equal(PUBLISH_ENVIRONMENT, "starters-publish");
  assert.deepEqual(checkPublishEnvironment(root), []);
});

test("a token-minting job that is not bound to the environment fails the check", () => {
  const dir = editedWorkflow((w) => w.replace(/^    environment: starters-publish\n/m, ""));
  assert.deepEqual(checkPublishEnvironment(dir), [`${PUBLISH_WORKFLOW}: job "publish" mints the publish App's token but is not bound to the environment starters-publish`]);
});

test("an environment name that drifts from PUBLISH_ENVIRONMENT fails the check", () => {
  const job = editedWorkflow((w) => w.replace(/^    environment: starters-publish$/m, "    environment: publish"));
  assert.match(checkPublishEnvironment(job).join("\n"), /not bound to the environment starters-publish/);
  const env = editedWorkflow((w) => w.replace(/^  PUBLISH_ENVIRONMENT: starters-publish$/m, "  PUBLISH_ENVIRONMENT: publish"));
  assert.deepEqual(checkPublishEnvironment(env), [`${PUBLISH_WORKFLOW}: the workflow-level env PUBLISH_ENVIRONMENT must be "starters-publish"`]);
});

test("a gate that runs after the token is minted, or not at all, fails the check", () => {
  const expected = [`${PUBLISH_WORKFLOW}: job "publish" must run scripts/publish/gate.sh before it mints the publish App's token`];
  const none = editedWorkflow((w) => w.replace(/        run: source\/scripts\/publish\/gate\.sh\n/, "        run: echo no gate\n"));
  assert.deepEqual(checkPublishEnvironment(none), expected);
  // Move the gate step to the end of the job, after the token step.
  const late = editedWorkflow((w) => {
    const gate = w.match(/      # Environment variables and secrets are visible only inside this bound job[\s\S]*?        run: source\/scripts\/publish\/gate\.sh\n/)[0];
    return w.replace(gate, "") + gate.split("\n").filter((l) => !l.trimStart().startsWith("#")).join("\n");
  });
  assert.deepEqual(checkPublishEnvironment(late), expected);
});

test("a token-minting job that does not wait for the unbound environment check fails the check", () => {
  const dir = editedWorkflow((w) => w.replace(/        run: scripts\/publish\/assert-environment\.sh "\$REPO" "\$PUBLISH_ENVIRONMENT"\n/, "        run: echo skipped\n"));
  assert.deepEqual(checkPublishEnvironment(dir), [`${PUBLISH_WORKFLOW}: job "publish" must need a job that is not bound to an environment and runs scripts/publish/assert-environment.sh`]);
});
