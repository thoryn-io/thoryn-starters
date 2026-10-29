#!/usr/bin/env node
// SSO-3428 — check every starter is what a generated repository needs, AS IS: nothing is rendered, so the
// files this repository publishes are exactly the files a customer's repository starts with. A template
// that fails here is never published.
//
//  - no render placeholder is left anywhere in this repository (the starters are not rendered any more);
//  - `.thoryn/template.json` validates against schemas/template.schema.json, and declares EXACTLY the
//    Actions variables of its kind (the fixed contract the starter orchestrator sets), at the right level;
//  - every connection's variables are declared, its provisioning file exists and validates against the
//    CLI's provisioning schema, and every `{{env.NAME}}` in it is a declared variable or a run-time value;
//  - an APPLICATION project declares only application and user resources, all in the sandbox its
//    connection names, and its client accepts the app's default local callbacks (SSO-3445); plain-http
//    redirect URIs are loopback-only and only ever on a sandbox client, never on production; a CONFIG project's production section declares every sandbox, and each sandbox
//    section converges only its own sandbox;
//  - an APPLICATION project's workflows read only declared variables (plus THORYN_CLI_VERSION and the production
//    client id the workspace's config project publishes), read every one of them, request `id-token: write`, read
//    no secret, and run the shared CI steps;
//  - SSO-3971: a CONFIG project is TENANT provisioning — every section declares `apiVersion: thoryn.io/tenant/v1` —
//    and ships NO workflow, CI script, `.thoryn/workflow.yaml` or `connection.json`: the creation flow (`thoryn
//    project init config`, or the Thoryn GitHub App) seeds the provisioning stub, its run-time configuration and each
//    connection's contract. A template workflow would win over the App's seeded stub (it writes only where no file
//    exists) and would converge the workspace a second time next to the stub;
//  - SSO-3993: a CONFIG template changes nothing that already exists. Its sections declare ONLY the environment the setup
//    creates, by slug only — the production section owns it (not read-only), each sandbox section anchors on its own sandbox read-only,
//    exactly as the orchestrator's seeded fallback and `thoryn project init config` (cli-v0.50.0) write them — and every
//    other tenant kind only as a commented example: the workspace's live configuration arrives through the import pull
//    request (thoryn-provisioning ADR 2026-09-30 §13.1 / §13.10, SSO-3995). Every connection requests read and write for
//    every tenant kind (TENANT_SCOPE_AREAS), so the import can read, and a plan profile read, the whole tenant;
//  - an APPLICATION project's production deploy job (SSO-3666) reads vars.THORYN_PRODUCTION_CLIENT_ID in the
//    GitHub environment `production`, resolves its settings with `app-env.mjs --production`, and has NO
//    Thoryn identity: no `id-token: write`, no sign-in, no provisioning — the app repository never converges
//    production (oauthy ADR 2026-10-13-production-clients-declared-in-the-config-project);
//  - SSO-3675: the publish matrix in .github/workflows/publish.yml names exactly the directories under
//    starters/, so a starter cannot be added (or renamed) without being published to its template repository;
//  - SSO-3675 (hardening): every publish.yml job that mints the publish App's token is bound to the GitHub
//    environment PUBLISH_ENVIRONMENT (main-only), runs the configuration gate before minting, and needs a job
//    that is NOT bound to it and asserts the environment's branch policy first.

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import YAML from "yaml";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/** The render placeholder token, built so this file does not contain it. */
export const PLACEHOLDER_TOKEN = "{{" + "thoryn.";
const PLACEHOLDER = new RegExp("\\{\\{\\s*" + "thoryn\\.");
const SKIP_DIRS = new Set(["node_modules", ".git", "target", "bin", "obj", "test-results", "playwright-report"]);

/**
 * The variable contract, per template kind. FIXED: the starter orchestrator (oathy) sets exactly these.
 * `environment` level means a variable of the production GitHub environment (github.productionEnvironment).
 */
export const VARIABLE_CONTRACT = {
  application: {
    THORYN_ISSUER: "repository",
    THORYN_WORKSPACE: "repository",
    THORYN_ENVIRONMENT: "repository",
    THORYN_WIF_CLIENT_ID: "repository",
  },
  config: {
    THORYN_ISSUER: "repository",
    THORYN_WORKSPACE: "repository",
    THORYN_SANDBOX_ENVIRONMENT: "repository",
    THORYN_SANDBOX_WIF_CLIENT_ID: "repository",
    THORYN_PRODUCTION_WIF_CLIENT_ID: "environment",
  },
};

/** `{{env.NAME}}` values a provisioning file may read that are not Actions variables (set per run). */
const RUNTIME_ENV = new Set(["THORYN_APP_NAME", "THORYN_TEST_USER_EMAIL", "THORYN_TEST_USER_PASSWORD"]);
/** The variable the production deploy job reads (set by the config project, never by the creation flow). */
export const PRODUCTION_CLIENT_ID_VARIABLE = "THORYN_PRODUCTION_CLIENT_ID";
/** The GitHub environment the production deploy job runs in and that variable lives in. */
export const PRODUCTION_GITHUB_ENVIRONMENT = "production";
/**
 * Variables a workflow may read without declaring them: the creation flow does not set them, so they are not
 * part of the contract template.json declares. THORYN_PRODUCTION_CLIENT_ID is published into the application
 * repository's GitHub environment `production` by the workspace's CONFIG project when its production run
 * converges the app's production client (SSO-3666; oauthy ADR 2026-10-13). The manifest schema has no way to
 * declare a variable another project publishes — a known gap, reported under SSO-3666 — so it is read, not
 * declared.
 */
const OPTIONAL_VARS = new Set(["THORYN_CLI_VERSION", PRODUCTION_CLIENT_ID_VARIABLE]);
/** SSO-3971 — the part a config project's sections declare (thoryn-cli SSO-3962, oauthy ADR 2026-10-25). */
export const TENANT_API_VERSION = "thoryn.io/tenant/v1";
const APP_KINDS = new Set(["application", "user"]);
/**
 * SSO-3993 — the scope areas of every tenant kind, `tenant:<area>.read` and `.write` each: thoryn-cli
 * `ScopeRequirements.AREAS` (the product-api gate of each provisioning kind) plus `access` (the ownership check and
 * `grants:` blocks). The same list the `starters` sign-in client holds and the wizard's web flow requests
 * (thoryn-provisioning `.thoryn/provision.yaml` and `StarterWebProperties` TENANT_KIND_AREAS, SSO-3992) — a config
 * connection asking for a scope outside the wizard token is refused `scope_not_grantable` before anything is created.
 *
 * SSO-4058 — `compliance`: the workspace's terms of use and privacy policy (product-api
 * `/api/v1/login-experience/legal-documents`, oauthy SSO-4047), which the `legalDocument` kind manages (thoryn-cli
 * SSO-4057). Listed here ahead of that CLI release so a config project created from now on can carry it; a project
 * created before holds a narrower set, which the wizard's Your setups names (thoryn-provisioning SSO-4058).
 */
export const TENANT_SCOPE_AREAS = ["workload-identity", "access", "environments", "applications", "users", "idp", "federation", "email", "domains", "roles", "compliance"];
export const TENANT_SCOPES = TENANT_SCOPE_AREAS.flatMap((a) => [`tenant:${a}.read`, `tenant:${a}.write`]);
/** Every application starter listens on 127.0.0.1:8080 by default (PORT / APP_BASE_URL override it). */
export const LOCAL_PORT = 8080;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "[::1]", "localhost"]);
const ENV_REF = /\{\{\s*env\.([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;

function walk(dir, visit) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (!SKIP_DIRS.has(name)) walk(p, visit);
    } else {
      visit(p);
    }
  }
}

/** Every file under [dir] that still carries a render placeholder (relative paths). */
export function findPlaceholders(dir, skip = new Set()) {
  const hits = [];
  walk(dir, (p) => {
    if (skip.has(p)) return;
    if (PLACEHOLDER.test(readFileSync(p).toString("utf8"))) hits.push(relative(dir, p));
  });
  return hits;
}

const envRef = (name) => new RegExp(`^\\{\\{\\s*env\\.${name}\\s*\\}\\}$`);

/**
 * Check one starter directory. Returns a list of problems (empty ⇒ valid). [schemas] holds the compiled
 * `template` and `provision` validators.
 */
export function checkStarter(dir, schemas) {
  const problems = [];
  const fail = (msg) => problems.push(msg);
  const manifestPath = join(dir, ".thoryn/template.json");
  if (!existsSync(manifestPath)) return [".thoryn/template.json is missing"];
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (e) {
    return [`.thoryn/template.json is not JSON: ${e.message}`];
  }
  if (!schemas.template(manifest)) return [`.thoryn/template.json: ${schemas.ajv.errorsText(schemas.template.errors)}`];

  // The fixed variable contract.
  const contract = VARIABLE_CONTRACT[manifest.kind];
  const declared = manifest.variables;
  const productionEnv = manifest.github?.productionEnvironment;
  for (const [name, level] of Object.entries(contract)) {
    if (!declared[name]) fail(`template.json does not declare ${name} (the ${manifest.kind} contract)`);
    else if (declared[name].level !== level) fail(`template.json: ${name} must be a ${level}-level variable`);
    else if (level === "environment" && declared[name].environment !== productionEnv) {
      fail(`template.json: ${name} must live in the production GitHub environment "${productionEnv}"`);
    }
  }
  for (const name of Object.keys(declared)) {
    if (!(name in contract)) fail(`template.json declares ${name}, which is not in the ${manifest.kind} contract`);
  }

  // Connections: declared variables, and their provisioning files.
  const connections = Object.entries(manifest.connections);
  const production = connections.filter(([, c]) => c.production);
  if (manifest.kind === "application" && production.length) fail("an application project has no production connection");
  if (manifest.kind === "config" && production.length !== 1) fail("a config project has exactly one production connection");
  const usedVariables = new Set(["THORYN_ISSUER", "THORYN_WORKSPACE"]);
  const sandboxVars = [];
  for (const [name, c] of connections) {
    for (const v of [c.clientIdVariable, c.environmentVariable].filter(Boolean)) {
      usedVariables.add(v);
      if (!declared[v]) fail(`connection ${name}: ${v} is not a declared variable`);
    }
    if (c.production) {
      if (declared[c.clientIdVariable]?.level !== "environment") fail(`connection ${name}: the production client id must be an environment-level variable`);
    } else {
      sandboxVars.push(c.environmentVariable);
      if (declared[c.clientIdVariable]?.level !== "repository") fail(`connection ${name}: a sandbox client id is a repository variable`);
    }
    if (manifest.kind === "config" && c.provisionFile !== `.thoryn/environments/${name}/provision.yaml`) {
      fail(`connection ${name}: a config section lives at .thoryn/environments/${name}/provision.yaml`);
    }
    const file = join(dir, c.provisionFile);
    if (!existsSync(file)) {
      fail(`connection ${name}: ${c.provisionFile} does not exist`);
      continue;
    }
    const text = readFileSync(file, "utf8");
    const doc = YAML.parse(text);
    if (!schemas.provision(doc)) fail(`${c.provisionFile}: ${schemas.ajv.errorsText(schemas.provision.errors)}`);
    // Only values: a comment may mention the grammar.
    for (const m of JSON.stringify(doc ?? null).matchAll(ENV_REF)) {
      if (!declared[m[1]] && !RUNTIME_ENV.has(m[1])) fail(`${c.provisionFile}: {{env.${m[1]}}} is neither a declared variable nor a run-time value`);
    }
    const resources = doc?.resources ?? [];
    if (manifest.kind === "config" && doc?.apiVersion !== TENANT_API_VERSION) {
      fail(`${c.provisionFile}: a config section is tenant provisioning — apiVersion must be ${TENANT_API_VERSION}, not ${doc?.apiVersion}`);
    }
    if (manifest.kind === "config" && existsSync(join(dir, dirname(c.provisionFile), "connection.json"))) {
      fail(`${dirname(c.provisionFile)}/connection.json is seeded by the creation flow (it names the repository's own trust); the template must not carry one`);
    }
    if (manifest.kind === "config") {
      // SSO-3993 — nothing but the environment the setup creates: a declared value the template cannot know would
      // change an existing workspace when the setup pull request merges (login methods, until this rule).
      for (const r of resources) {
        if (r.kind !== "environment") {
          fail(`${c.provisionFile}: a config template declares only the environment the setup creates — ${r.kind}/${r.name ?? r.kind} would change an existing workspace when the setup pull request merges; keep it a commented example (the import pull request brings what the workspace already has)`);
        } else {
          // By slug only: any other field is compared with the live sandbox — an owned one would be renamed by the first
          // apply, a read-only one would fail the plan (`access_read_only`) when the person chose an existing sandbox.
          const extra = Object.keys(r.spec ?? {}).filter((k) => k !== "slug");
          if (extra.length) fail(`${c.provisionFile}: environment/${r.name} is declared by its slug only — ${extra.join(", ")} would be compared with the live sandbox, which the template cannot know`);
        }
      }
      const missing = TENANT_SCOPES.filter((s) => !c.scopes.includes(s));
      if (missing.length) {
        fail(`connection ${name}: a config connection requests read and write for every tenant kind — missing ${missing.join(", ")} (the import reads the whole tenant with them; the plan profile is every .read)`);
      }
    }
    if (!c.production) {
      for (const r of resources) {
        if (r.kind === "environment") {
          if (manifest.kind !== "config") {
            fail(`${c.provisionFile}: a sandbox connection must not declare an environment (production does)`);
          } else {
            // The anchor of a sandbox section: its own sandbox, a dependency (the production section owns it), so plan
            // reads it and apply never writes it — the shape the orchestrator's seeded fallback and cli-v0.50.0 write.
            if (!envRef(c.environmentVariable).test(r.spec?.slug ?? "")) {
              fail(`${c.provisionFile}: environment/${r.name} must be {{env.${c.environmentVariable}}}, the sandbox this section configures`);
            }
            if (r.readOnly !== true) fail(`${c.provisionFile}: environment/${r.name} must be readOnly: true — the production section declares the sandbox; this section only depends on it`);
          }
        } else if (!envRef(c.environmentVariable).test(r.environment ?? "")) {
          fail(`${c.provisionFile}: ${r.kind}/${r.name ?? r.kind} must live in {{env.${c.environmentVariable}}}, the sandbox its connection names`);
        }
      }
    } else {
      for (const r of resources) if (r.environment) fail(`${c.provisionFile}: the production section converges the production plane; ${r.kind} names an environment`);
      if (manifest.kind === "config") {
        for (const r of resources) {
          if (r.kind === "environment" && r.readOnly === true) fail(`${c.provisionFile}: environment/${r.name} must not be readOnly — the production section owns the sandboxes it declares`);
        }
      }
    }
    if (manifest.kind === "application") {
      for (const r of resources) {
        if (!APP_KINDS.has(r.kind)) fail(`${c.provisionFile}: an application project must not declare a '${r.kind}' (that belongs to the workspace config project)`);
      }
      // SSO-3445 — works out of the box locally: the sandbox client accepts the app's default local
      // callbacks, on 127.0.0.1 (any port, RFC 8252) and on localhost at the default port (matched exactly).
      const web = resources.find((r) => r.kind === "application" && r.name === "web");
      for (const [field, path] of [["redirectUris", "/callback"], ["postLogoutRedirectUris", "/signed-out"]]) {
        for (const uri of [`http://127.0.0.1${path}`, `http://localhost:${LOCAL_PORT}${path}`]) {
          if (!(web?.spec?.[field] ?? []).includes(uri)) fail(`${c.provisionFile}: application/web ${field} must include ${uri} (local development)`);
        }
      }
    }
    // Plain-http redirect URIs are local-development only: loopback hosts, and only on a sandbox client.
    for (const r of resources.filter((x) => x.kind === "application")) {
      for (const uri of [...(r.spec?.redirectUris ?? []), ...(r.spec?.postLogoutRedirectUris ?? [])]) {
        let u;
        try {
          u = new URL(uri);
        } catch {
          fail(`${c.provisionFile}: application/${r.name} has an unparseable redirect URI ${uri}`);
          continue;
        }
        if (u.protocol !== "http:") continue;
        if (!LOOPBACK_HOSTS.has(u.hostname)) fail(`${c.provisionFile}: application/${r.name} ${uri}: plain http is for loopback development only`);
        if (!r.environment) fail(`${c.provisionFile}: application/${r.name} ${uri}: a local-development redirect URI belongs on a sandbox client, never on production`);
        if (u.hostname === "localhost" && !u.port) fail(`${c.provisionFile}: application/${r.name} ${uri}: the platform matches localhost exactly, so name the port`);
      }
    }
  }
  if (manifest.kind === "config") {
    const prod = production[0]?.[1];
    const doc = prod && existsSync(join(dir, prod.provisionFile)) ? YAML.parse(readFileSync(join(dir, prod.provisionFile), "utf8")) : null;
    const slugs = (doc?.resources ?? []).filter((r) => r.kind === "environment").map((r) => r.spec?.slug ?? "");
    for (const v of sandboxVars) {
      if (!slugs.some((s) => envRef(v).test(s))) fail(`the production section does not declare the sandbox {{env.${v}}}`);
    }
    // SSO-3993 — and no environment the setup did not create: a literal one would be created by the first apply.
    for (const r of (doc?.resources ?? []).filter((x) => x.kind === "environment")) {
      if (!sandboxVars.some((v) => envRef(v).test(r.spec?.slug ?? ""))) {
        fail(`${prod.provisionFile}: environment/${r.name} is not a sandbox the setup creates — the template declares only ${sandboxVars.map((v) => `{{env.${v}}}`).join(", ")}; keep another sandbox a commented example`);
      }
    }
    const sections = existsSync(join(dir, ".thoryn/environments")) ? readdirSync(join(dir, ".thoryn/environments")) : [];
    for (const s of sections) if (!manifest.connections[s]) fail(`section .thoryn/environments/${s} has no connection in template.json`);
  }
  for (const name of Object.keys(declared)) if (!usedVariables.has(name)) fail(`template.json declares ${name}, but no connection uses it`);

  // Workflows.
  const wfDir = join(dir, ".github/workflows");
  const workflows = existsSync(wfDir) ? readdirSync(wfDir).filter((f) => /\.ya?ml$/.test(f)) : [];
  if (manifest.kind === "config") {
    // SSO-3971 — the creation flow seeds the provisioning stub and its configuration; the template carries no CI of its own.
    for (const wf of workflows) fail(`.github/workflows/${wf}: a config template ships no workflow — the creation flow seeds the provisioning stub (.github/workflows/thoryn-provisioning.yml), which calls thoryn-cli's reusable workflow`);
    if (existsSync(join(dir, ".thoryn/workflow.yaml"))) fail(".thoryn/workflow.yaml is seeded by the creation flow (it names each section with its seeded connection.json); the template must not carry one");
    if (existsSync(join(dir, ".thoryn/ci"))) fail(".thoryn/ci/ is gone from the config template: its provisioning runs in thoryn-cli's reusable workflow, not in scripts");
  } else {
    if (!workflows.length) fail("no GitHub Actions workflow");
    const read = new Set();
    let text = "";
    for (const wf of workflows) {
      const t = readFileSync(join(wfDir, wf), "utf8");
      text += t;
      for (const m of t.matchAll(/\bvars\.([A-Za-z_][A-Za-z0-9_]*)/g)) {
        read.add(m[1]);
        if (!declared[m[1]] && !OPTIONAL_VARS.has(m[1])) fail(`${wf} reads vars.${m[1]}, which template.json does not declare`);
      }
      if (/secrets\./.test(t)) fail(`${wf} reads a repository secret; the starters are secret-less`);
    }
    for (const name of Object.keys(declared)) if (!read.has(name)) fail(`no workflow reads vars.${name}`);
    if (workflows.length && !/id-token:\s*write/.test(text)) fail("the workflow never requests id-token: write");
    if (workflows.length && !text.includes(".thoryn/ci/gate.sh")) fail("the workflow does not gate on .thoryn/ci/gate.sh");
    if (manifest.kind === "application") {
      for (const step of ["install-cli.sh", "provision.sh", "start-app.sh", "teardown.sh"]) {
        if (!text.includes(`.thoryn/ci/${step}`)) fail(`the workflow does not run .thoryn/ci/${step}`);
      }
      // SSO-3666 — the production deploy skeleton: reads the published client id in the `production` GitHub
      // environment, resolves its settings in production mode, and holds no Thoryn identity.
      if (!read.has(PRODUCTION_CLIENT_ID_VARIABLE)) fail(`no workflow reads vars.${PRODUCTION_CLIENT_ID_VARIABLE} (the production deploy job)`);
      if (!text.includes("app-env.mjs --production")) fail("no workflow runs .thoryn/app-env.mjs --production (the production deploy job)");
      let productionJobs = 0;
      for (const wf of workflows) {
        const doc = YAML.parse(readFileSync(join(wfDir, wf), "utf8"));
        for (const [jobName, job] of Object.entries(doc?.jobs ?? {})) {
          const environment = typeof job?.environment === "string" ? job.environment : job?.environment?.name;
          if (environment !== PRODUCTION_GITHUB_ENVIRONMENT) continue;
          productionJobs++;
          const permissions = { ...(doc.permissions ?? {}), ...(job.permissions ?? {}) };
          if (permissions["id-token"] === "write") fail(`${wf}: job ${jobName} runs in GitHub environment ${PRODUCTION_GITHUB_ENVIRONMENT} and requests id-token: write; an application repository has no production identity`);
          for (const step of job.steps ?? []) {
            const run = typeof step?.run === "string" ? step.run : "";
            if (/login\.sh|thoryn login|provision\.sh|thoryn provision/.test(run)) {
              fail(`${wf}: job ${jobName} runs in GitHub environment ${PRODUCTION_GITHUB_ENVIRONMENT} and signs in to or provisions Thoryn; production is converged by the config project only`);
            }
          }
        }
      }
      if (!productionJobs) fail(`no workflow job runs in GitHub environment ${PRODUCTION_GITHUB_ENVIRONMENT} (the production deploy job)`);
    }
  }
  // SSO-3445 — the generated local test user (.thoryn/local.env) must never be committed.
  const gitignore = existsSync(join(dir, ".gitignore")) ? readFileSync(join(dir, ".gitignore"), "utf8").split("\n") : [];
  if (!gitignore.includes(".thoryn/local.env")) fail(".gitignore must list .thoryn/local.env (the local sandbox test user)");
  if (existsSync(join(dir, ".thoryn/connection.json"))) fail(".thoryn/connection.json is gone: sign-in is declared by template.json connections");
  return problems;
}

/** The workflow that mirrors the starters to their template repositories, relative to the repository root. */
export const PUBLISH_WORKFLOW = ".github/workflows/publish.yml";

/**
 * SSO-3675 — the set of starters/* must equal the publish matrix (`jobs.publish.strategy.matrix.starter` in
 * publish.yml). The matrix is a literal list on purpose: a reviewed declaration of what gets published,
 * checked here against the directories, rather than a `find` at publish time that nobody reads. Returns a
 * list of problems (empty ⇒ in sync).
 */
export function checkPublishMatrix(repoRoot) {
  const workflowPath = join(repoRoot, PUBLISH_WORKFLOW);
  if (!existsSync(workflowPath)) return [`${PUBLISH_WORKFLOW} is missing: nothing publishes the starters`];
  const doc = YAML.parse(readFileSync(workflowPath, "utf8"));
  const matrix = doc?.jobs?.publish?.strategy?.matrix?.starter;
  if (!Array.isArray(matrix) || !matrix.every((s) => typeof s === "string")) {
    return [`${PUBLISH_WORKFLOW}: jobs.publish.strategy.matrix.starter must be a literal list of starter names`];
  }
  const startersDir = join(repoRoot, "starters");
  const starters = existsSync(startersDir) ? readdirSync(startersDir).filter((n) => statSync(join(startersDir, n)).isDirectory()).sort() : [];
  const problems = [];
  if (!starters.length) problems.push("starters/ has no starter directory");
  for (const s of starters) if (!matrix.includes(s)) problems.push(`starters/${s} is not in the publish matrix of ${PUBLISH_WORKFLOW}; add it or it is never published`);
  for (const s of matrix) if (!starters.includes(s)) problems.push(`${PUBLISH_WORKFLOW} publishes "${s}", but starters/${s} does not exist`);
  const dupes = matrix.filter((s, i) => matrix.indexOf(s) !== i);
  for (const s of new Set(dupes)) problems.push(`${PUBLISH_WORKFLOW} lists "${s}" twice in the publish matrix`);
  return problems;
}

/** The GitHub environment (deployment-branch policy: main only) that holds the publish App's id and key. */
export const PUBLISH_ENVIRONMENT = "starters-publish";

const usesTokenAction = (step) => typeof step?.uses === "string" && step.uses.startsWith("actions/create-github-app-token@");
const runs = (step, script) => typeof step?.run === "string" && step.run.includes(script);
const environmentName = (job) => (typeof job?.environment === "string" ? job.environment : job?.environment?.name);

/**
 * SSO-3675 (hardening) — the publish App's key may only ever reach a job running for main. GitHub guarantees
 * that for a job bound to an environment whose deployment-branch policy is `main` (the policy itself is an
 * operator setting, asserted at run time by scripts/publish/assert-environment.sh). This pins the workflow
 * half: the environment name is declared once (workflow-level env PUBLISH_ENVIRONMENT) and equals the
 * constant; every job that mints the App token is bound to it and runs gate.sh BEFORE minting (environment
 * secrets are invisible to unbound jobs, so the gate cannot live anywhere else); and each such job needs an
 * unbound job that runs assert-environment.sh, so a missing or unprotected environment fails the run before
 * a bound job could create it or read from it. Returns a list of problems (empty ⇒ in order).
 */
export function checkPublishEnvironment(repoRoot) {
  const workflowPath = join(repoRoot, PUBLISH_WORKFLOW);
  if (!existsSync(workflowPath)) return [`${PUBLISH_WORKFLOW} is missing: nothing publishes the starters`];
  const doc = YAML.parse(readFileSync(workflowPath, "utf8"));
  const jobs = doc?.jobs ?? {};
  const problems = [];
  if (doc?.env?.PUBLISH_ENVIRONMENT !== PUBLISH_ENVIRONMENT) {
    problems.push(`${PUBLISH_WORKFLOW}: the workflow-level env PUBLISH_ENVIRONMENT must be "${PUBLISH_ENVIRONMENT}"`);
  }
  const asserting = Object.entries(jobs)
    .filter(([, job]) => !environmentName(job) && (job.steps ?? []).some((s) => runs(s, "assert-environment.sh")))
    .map(([id]) => id);
  const minting = Object.entries(jobs).filter(([, job]) => (job.steps ?? []).some(usesTokenAction));
  if (!minting.length) problems.push(`${PUBLISH_WORKFLOW}: no job mints the publish App's token`);
  for (const [id, job] of minting) {
    if (environmentName(job) !== PUBLISH_ENVIRONMENT) {
      problems.push(`${PUBLISH_WORKFLOW}: job "${id}" mints the publish App's token but is not bound to the environment ${PUBLISH_ENVIRONMENT}`);
    }
    const steps = job.steps ?? [];
    const gate = steps.findIndex((s) => runs(s, "gate.sh"));
    if (gate < 0 || gate > steps.findIndex(usesTokenAction)) {
      problems.push(`${PUBLISH_WORKFLOW}: job "${id}" must run scripts/publish/gate.sh before it mints the publish App's token`);
    }
    const needs = [job.needs ?? []].flat();
    if (!asserting.some((a) => needs.includes(a))) {
      problems.push(`${PUBLISH_WORKFLOW}: job "${id}" must need a job that is not bound to an environment and runs scripts/publish/assert-environment.sh`);
    }
  }
  return problems;
}

export function compileSchemas() {
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  const load = (f) => JSON.parse(readFileSync(join(root, "schemas", f), "utf8"));
  return { ajv, template: ajv.compile(load("template.schema.json")), provision: ajv.compile(load("provision.schema.json")) };
}

function main() {
  const problems = [];
  const self = fileURLToPath(import.meta.url);
  for (const hit of findPlaceholders(root, new Set([self]))) {
    problems.push(`${hit}: contains a render placeholder (${PLACEHOLDER_TOKEN}…); starters are not rendered — read the value from a THORYN_* variable at run time`);
  }
  const schemas = compileSchemas();
  for (const starter of readdirSync(join(root, "starters")).sort()) {
    const found = checkStarter(join(root, "starters", starter), schemas);
    for (const p of found) problems.push(`${starter}: ${p}`);
    if (!found.length) console.log(`✔ ${starter} validates as is (${JSON.parse(readFileSync(join(root, "starters", starter, ".thoryn/template.json"), "utf8")).kind})`);
  }
  const matrixProblems = checkPublishMatrix(root);
  problems.push(...matrixProblems);
  if (!matrixProblems.length) console.log(`✔ ${PUBLISH_WORKFLOW} publishes exactly the starters/* directories`);
  const environmentProblems = checkPublishEnvironment(root);
  problems.push(...environmentProblems);
  if (!environmentProblems.length) console.log(`✔ ${PUBLISH_WORKFLOW} mints the publish token only in the main-only environment ${PUBLISH_ENVIRONMENT}`);
  if (problems.length) {
    console.error(`\n✖ ${problems.length} problem(s):\n  ${problems.join("\n  ")}`);
    process.exit(1);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main();
