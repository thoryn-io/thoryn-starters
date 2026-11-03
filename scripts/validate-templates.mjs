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
//  - an APPLICATION project is APPLICATION provisioning (SSO-4087 / SSO-3966, oauthy ADR 2026-10-25): its file declares
//    `apiVersion: thoryn.io/application/v1` and only `application` resources, all in the sandbox its connection names
//    — no `user`: the account its e2e signs in with is an ephemeral sandbox test identity .thoryn/ci/provision.sh MINTS
//    per run (oauthy ADR 2026-10-30), so its connection requests exactly APPLICATION_SCOPES, with
//    `tenant:test-identities.write` and never `tenant:users.*`; its client accepts the app's default local callbacks (SSO-3445); plain-http
//    redirect URIs are loopback-only and only ever on a sandbox client, never on production; a CONFIG project's production section declares every sandbox, and each sandbox
//    section converges only its own sandbox;
//  - an APPLICATION project's workflows read only declared variables (plus THORYN_CLI_VERSION and the two production
//    variables .thoryn/production/declaration.json declares), read every one of them, request `id-token: write`, read
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
//  - SSO-4120 — an APPLICATION project owns its production client (oauthy ADR 2026-10-25 decision 1). Its production
//    connection (.thoryn/production/declaration.json: the trust's clientId variable and the deployed URL, both in the
//    GitHub environment `production`) requests EXACTLY the application ceiling PRODUCTION_SCOPES; its production file
//    declares only `application` resources on the production plane, each with the fixed clientId the creation slot binds
//    (`{{env.THORYN_APP_NAME}}-production`) and https redirect URIs on THORYN_PRODUCTION_URL only. Exactly one workflow
//    job runs in the GitHub environment `production`: on `main` only, with `id-token: write`, it runs
//    .thoryn/ci/production-apply.sh and then `app-env.mjs --production`, and runs no sandbox step (provision.sh,
//    teardown.sh, a test identity). No other job runs the production apply. vars.THORYN_PRODUCTION_CLIENT_ID is retired;
//    a workflow that reads it fails;
//  - SSO-4095: every workflow job that runs the thoryn CLI — a starter's and this repository's own — sets
//    THORYN_CI_PLAINTEXT_TOKENS: "1" at job or workflow level. A GitHub-hosted runner has no OS keychain, so without the
//    CLI's CI opt-in `thoryn login --workload-identity` fails (TokenStoreUnavailableException) before anything runs;
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

/**
 * `{{env.NAME}}` values a provisioning file may read that are not Actions variables (set per run). The test account's
 * THORYN_TEST_USER_EMAIL / THORYN_TEST_USER_PASSWORD are no longer among them (SSO-4087): a test identity is minted by
 * the CLI, never declared in a provisioning file.
 */
const RUNTIME_ENV = new Set(["THORYN_APP_NAME"]);
/**
 * SSO-4120 — retired: the hand-set production client id (SSO-3666). The app project's production apply creates and owns
 * the client, and deploy.yml reads its id from that apply's result.
 */
export const RETIRED_PRODUCTION_CLIENT_ID_VARIABLE = "THORYN_PRODUCTION_CLIENT_ID";
/** The GitHub environment the production apply-and-deploy job runs in and its variables live in. */
export const PRODUCTION_GITHUB_ENVIRONMENT = "production";
/**
 * SSO-4120 — an application project's production connection, kept OUT of template.json: template.json is what the creation
 * flow sets up, and the orchestrator refuses an application template with a production connection. The production trust
 * is the workspace's config project's to declare (oauthy ADR 2026-10-25 decision 3, SSO-4079).
 */
export const PRODUCTION_DECLARATION = ".thoryn/production/declaration.json";
export const PRODUCTION_PROVISION_FILE = ".thoryn/production/provision.yaml";
/** Its variables, each in the GitHub environment PRODUCTION_GITHUB_ENVIRONMENT. */
export const PRODUCTION_VARIABLES = ["THORYN_PRODUCTION_WIF_CLIENT_ID", "THORYN_PRODUCTION_URL"];
/** EXACTLY the application file's ceiling (oauthy ADR 2026-10-25): no sandbox tool scope on production. */
export const PRODUCTION_SCOPES = ["tenant:applications.read", "tenant:applications.write", "tenant:access.read"];
/** The fixed clientId a production application declares: the name the creation slot binds (oauthy ADR 2026-10-17). */
export const PRODUCTION_CLIENT_ID = "{{env.THORYN_APP_NAME}}-production";
/**
 * Variables a workflow may read without declaring them in template.json: the creation flow does not set them, so they
 * are not part of its contract. The production variables are declared in PRODUCTION_DECLARATION instead.
 */
const OPTIONAL_VARS = new Set(["THORYN_CLI_VERSION", ...PRODUCTION_VARIABLES]);
/** SSO-3971 — the part a config project's sections declare (thoryn-cli SSO-3962, oauthy ADR 2026-10-25). */
export const TENANT_API_VERSION = "thoryn.io/tenant/v1";
/** SSO-4087 / SSO-3966 — the part an application project's file declares (thoryn-cli SSO-3962, oauthy ADR 2026-10-25). */
export const APPLICATION_API_VERSION = "thoryn.io/application/v1";
/**
 * SSO-4087 — EXACTLY the scopes of an application project's sandbox connection (oauthy ADR 2026-10-30 §7): the application
 * file's own ceiling (`applications`, plus `access` for the ownership check — thoryn-cli `ScopeRequirements`
 * APPLICATION_FILE_SCOPES), and the two sandbox TOOL scopes a trust of an application file may hold since cli-v0.57.0:
 * `tenant:environments.read` (the test inbox, and `--env <slug>` resolution) and `tenant:test-identities.write` (the mint
 * and the revoke of the per-run test identity). Never `tenant:users.*`: an application defines no user of the tenant, and
 * the mint is what replaced that scope. The wizard grants exactly this set to a new application project's trust
 * (thoryn-provisioning SSO-4088); a connection asking for more is refused `scope_not_grantable`.
 */
export const APPLICATION_SCOPES = [
  "tenant:applications.read",
  "tenant:applications.write",
  "tenant:access.read",
  "tenant:environments.read",
  "tenant:test-identities.write",
];
/**
 * SSO-3993 — the scope areas of every tenant kind, `tenant:<area>.read` and `.write` each: thoryn-cli
 * `ScopeRequirements.AREAS` (the product-api gate of each provisioning kind) plus `access` (the ownership check and
 * `grants:` blocks). The same list the `starters` sign-in client holds and the wizard's web flow requests
 * (thoryn-provisioning `.thoryn/provision.yaml` and `StarterWebProperties` TENANT_KIND_AREAS, SSO-3992) — a config
 * connection asking for a scope outside the wizard token is refused `scope_not_grantable` before anything is created.
 *
 * SSO-4058 — `legal-documents`: the workspace's terms of use and privacy policy (product-api
 * `/api/v1/login-experience/legal-documents`, oauthy SSO-4047), which the `legalDocument` kind manages (thoryn-cli
 * SSO-4057). Its own narrow pair (product owner 2026-10-29), NOT `tenant:compliance.*`: `compliance.write` also gates
 * erasure requests, DSAR, SCIM deprovision, SSF, consent purposes and retention, which a config project's CI identity
 * must not get. Listed here ahead of that CLI release so a config project created from now on can carry it; a project
 * created before holds a narrower set, which the wizard's Your setups names (thoryn-provisioning SSO-4058).
 */
export const TENANT_SCOPE_AREAS = ["workload-identity", "access", "environments", "applications", "users", "idp", "federation", "email", "domains", "roles", "legal-documents"];
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
      if (doc?.apiVersion !== APPLICATION_API_VERSION) {
        fail(`${c.provisionFile}: an application project is application provisioning — apiVersion must be ${APPLICATION_API_VERSION}, not ${doc?.apiVersion}`);
      }
      for (const r of resources) {
        if (r.kind === "user") {
          fail(`${c.provisionFile}: an application project declares no user — the account its e2e signs in with is a test identity .thoryn/ci/provision.sh mints per run (thoryn env test-identity create); a real sandbox user is the workspace config project's`);
        } else if (r.kind !== "application") {
          fail(`${c.provisionFile}: an application project must not declare a '${r.kind}' (that belongs to the workspace config project)`);
        }
      }
      const missing = APPLICATION_SCOPES.filter((s) => !c.scopes.includes(s));
      if (missing.length) fail(`connection ${name}: an application connection requests exactly ${APPLICATION_SCOPES.join(", ")} — missing ${missing.join(", ")}`);
      for (const s of c.scopes.filter((x) => !APPLICATION_SCOPES.includes(x))) {
        if (/^tenant:users\./.test(s)) {
          fail(`connection ${name}: requests ${s} — an application identity holds no tenant:users.* scope (oauthy ADR 2026-10-30): its test account is minted with tenant:test-identities.write, and a user of the tenant is declared by the config project`);
        } else {
          fail(`connection ${name}: requests ${s}, which is not an application connection scope (exactly ${APPLICATION_SCOPES.join(", ")})`);
        }
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
        // The retired production client id has its own message below.
        if (!declared[m[1]] && !OPTIONAL_VARS.has(m[1]) && m[1] !== RETIRED_PRODUCTION_CLIENT_ID_VARIABLE) fail(`${wf} reads vars.${m[1]}, which template.json does not declare`);
      }
      if (/secrets\./.test(t)) fail(`${wf} reads a repository secret; the starters are secret-less`);
      for (const job of jobsWithoutPlaintextTokenOptIn(YAML.parse(t))) fail(plaintextTokenProblem(wf, job));
    }
    for (const name of Object.keys(declared)) if (!read.has(name)) fail(`no workflow reads vars.${name}`);
    if (workflows.length && !/id-token:\s*write/.test(text)) fail("the workflow never requests id-token: write");
    if (workflows.length && !text.includes(".thoryn/ci/gate.sh")) fail("the workflow does not gate on .thoryn/ci/gate.sh");
    if (manifest.kind === "application") {
      for (const step of ["install-cli.sh", "provision.sh", "start-app.sh", "teardown.sh"]) {
        if (!text.includes(`.thoryn/ci/${step}`)) fail(`the workflow does not run .thoryn/ci/${step}`);
      }
      // SSO-4120 — the production apply-and-deploy job (see the header).
      if (read.has(RETIRED_PRODUCTION_CLIENT_ID_VARIABLE)) {
        fail(`a workflow reads vars.${RETIRED_PRODUCTION_CLIENT_ID_VARIABLE}, which is retired (SSO-4120): deploy.yml reads the client id from its own production apply`);
      }
      for (const v of PRODUCTION_VARIABLES) if (!read.has(v)) fail(`no workflow reads vars.${v} (the production apply job)`);
      let productionJobs = 0;
      for (const wf of workflows) {
        const doc = YAML.parse(readFileSync(join(wfDir, wf), "utf8"));
        for (const [jobName, job] of Object.entries(doc?.jobs ?? {})) {
          const environment = typeof job?.environment === "string" ? job.environment : job?.environment?.name;
          const runs = (job?.steps ?? []).map((step) => (typeof step?.run === "string" ? step.run : ""));
          const at = (re) => runs.findIndex((r) => re.test(r));
          const applies = at(/\.thoryn\/ci\/production-apply\.sh/);
          if (environment !== PRODUCTION_GITHUB_ENVIRONMENT) {
            if (applies >= 0) fail(`${wf}: job ${jobName} runs .thoryn/ci/production-apply.sh outside the GitHub environment ${PRODUCTION_GITHUB_ENVIRONMENT}; the production trust is pinned to it`);
            continue;
          }
          productionJobs++;
          const where = `${wf}: job ${jobName} runs in GitHub environment ${PRODUCTION_GITHUB_ENVIRONMENT}`;
          if (!/github\.ref\s*==\s*'refs\/heads\/main'/.test(String(job.if ?? ""))) fail(`${where} and must run on main only (if: github.ref == 'refs/heads/main'), the branch the production trust pins`);
          const permissions = { ...(doc.permissions ?? {}), ...(job.permissions ?? {}) };
          if (permissions["id-token"] !== "write") fail(`${where} and does not request id-token: write; it signs in as the production trust`);
          const resolves = at(/app-env\.mjs --production/);
          if (applies < 0) fail(`${where} and does not run .thoryn/ci/production-apply.sh (the production apply)`);
          if (resolves < 0) fail(`${where} and does not run .thoryn/app-env.mjs --production`);
          else if (applies >= 0 && resolves < applies) fail(`${where} and resolves its settings before the production apply: the client id comes from that apply`);
          if (at(/provision\.sh|teardown\.sh|test-identity|login\.sh sandbox/) >= 0) {
            fail(`${where} and runs a sandbox step; production converges .thoryn/production/provision.yaml only (production-apply.sh), and a test identity exists in a sandbox only`);
          }
        }
      }
      if (productionJobs !== 1) fail(`exactly one workflow job runs in GitHub environment ${PRODUCTION_GITHUB_ENVIRONMENT} (the production apply-and-deploy job); found ${productionJobs}`);
    }
  }
  if (manifest.kind === "application") problems.push(...checkProductionConnection(dir, schemas));
  // SSO-4087 — the generated local test-user file (.thoryn/local.env, SSO-3445) is retired: the test identity is minted
  // into the developer's shell and never written to disk, so no starter may carry or read that file.
  if (existsSync(join(dir, ".thoryn/local.env"))) fail(".thoryn/local.env is retired (SSO-4087): the test identity is minted into the shell, never written to a file");
  if (existsSync(join(dir, ".thoryn/connection.json"))) fail(".thoryn/connection.json is gone: sign-in is declared by template.json connections");
  return problems;
}

/**
 * SSO-4120 — an application starter's production connection and file (see the header). Returns a list of problems.
 */
export function checkProductionConnection(dir, schemas) {
  const problems = [];
  const fail = (msg) => problems.push(msg);
  const path = join(dir, PRODUCTION_DECLARATION);
  if (!existsSync(path)) return [`${PRODUCTION_DECLARATION} is missing (the production apply job's connection)`];
  let declaration;
  try {
    declaration = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    return [`${PRODUCTION_DECLARATION} is not JSON: ${e.message}`];
  }
  const variables = declaration.variables ?? {};
  for (const name of PRODUCTION_VARIABLES) {
    const v = variables[name];
    if (!v) fail(`${PRODUCTION_DECLARATION} does not declare ${name}`);
    else if (v.level !== "environment" || v.environment !== PRODUCTION_GITHUB_ENVIRONMENT) {
      fail(`${PRODUCTION_DECLARATION}: ${name} must be a variable of the GitHub environment "${PRODUCTION_GITHUB_ENVIRONMENT}"`);
    }
  }
  for (const name of Object.keys(variables)) if (!PRODUCTION_VARIABLES.includes(name)) fail(`${PRODUCTION_DECLARATION} declares ${name}, which the production apply does not read`);
  const names = Object.keys(declaration.connections ?? {});
  if (names.join() !== "production") fail(`${PRODUCTION_DECLARATION} declares exactly one connection, production (found ${names.join(", ") || "none"})`);
  const c = declaration.connections?.production;
  if (!c) return problems;
  if (c.production !== true) fail(`${PRODUCTION_DECLARATION}: connection production must say production: true`);
  if (c.clientIdVariable !== "THORYN_PRODUCTION_WIF_CLIENT_ID") fail(`${PRODUCTION_DECLARATION}: connection production's clientIdVariable must be THORYN_PRODUCTION_WIF_CLIENT_ID`);
  if (c.environmentVariable) fail(`${PRODUCTION_DECLARATION}: connection production names no sandbox (environmentVariable): production is the workspace's own plane`);
  if (c.provisionFile !== PRODUCTION_PROVISION_FILE) fail(`${PRODUCTION_DECLARATION}: connection production's provisionFile must be ${PRODUCTION_PROVISION_FILE}`);
  const scopes = c.scopes ?? [];
  if (scopes.length !== PRODUCTION_SCOPES.length || PRODUCTION_SCOPES.some((s) => !scopes.includes(s))) {
    fail(`${PRODUCTION_DECLARATION}: connection production requests exactly ${PRODUCTION_SCOPES.join(", ")} (the application ceiling, oauthy ADR 2026-10-25) — found ${scopes.join(", ") || "none"}`);
  }

  const file = join(dir, PRODUCTION_PROVISION_FILE);
  if (!existsSync(file)) return [...problems, `${PRODUCTION_PROVISION_FILE} does not exist`];
  const doc = YAML.parse(readFileSync(file, "utf8"));
  if (!schemas.provision(doc)) fail(`${PRODUCTION_PROVISION_FILE}: ${schemas.ajv.errorsText(schemas.provision.errors)}`);
  if (doc?.apiVersion !== APPLICATION_API_VERSION) fail(`${PRODUCTION_PROVISION_FILE}: apiVersion must be ${APPLICATION_API_VERSION}, not ${doc?.apiVersion}`);
  for (const m of JSON.stringify(doc ?? null).matchAll(ENV_REF)) {
    if (!["THORYN_APP_NAME", "THORYN_PRODUCTION_URL"].includes(m[1])) fail(`${PRODUCTION_PROVISION_FILE}: {{env.${m[1]}}} is not a production value (THORYN_APP_NAME, THORYN_PRODUCTION_URL)`);
  }
  const resources = doc?.resources ?? [];
  if (!resources.length) fail(`${PRODUCTION_PROVISION_FILE} declares no application`);
  for (const r of resources) {
    const at = `${PRODUCTION_PROVISION_FILE}: ${r.kind}/${r.name ?? r.kind}`;
    if (r.kind !== "application") {
      fail(`${at}: the production file declares only the application's own client (a ${r.kind} belongs to the workspace config project)`);
      continue;
    }
    if (r.environment) fail(`${at} names an environment; the production file converges the production plane`);
    if (r.spec?.clientId !== PRODUCTION_CLIENT_ID) fail(`${at}: spec.clientId must be "${PRODUCTION_CLIENT_ID}", the fixed name a creation slot binds`);
    const uris = [...(r.spec?.redirectUris ?? []), ...(r.spec?.postLogoutRedirectUris ?? [])];
    if (!(r.spec?.redirectUris ?? []).length) fail(`${at} has no redirect URI`);
    for (const uri of uris) {
      if (!uri.startsWith("{{env.THORYN_PRODUCTION_URL}}/")) fail(`${at} ${uri}: a production redirect URI is on the deployed URL, {{env.THORYN_PRODUCTION_URL}}/… (https, checked by production-apply.sh), never a loopback or literal host`);
    }
  }
  return problems;
}

/** SSO-4095 — the thoryn CLI's CI opt-in to a plaintext token file (a GitHub-hosted runner has no OS keychain). */
export const PLAINTEXT_TOKENS_VARIABLE = "THORYN_CI_PLAINTEXT_TOKENS";
/** A step that runs the thoryn CLI: a `thoryn <command>` at command position, or a CI script that signs in / calls it. */
const RUNS_THORYN = /(?:^|[\s;&|(`])thoryn\s+[a-z]|\bci\/(?:login|provision|production-apply|teardown)\.sh\b/m;

/**
 * SSO-4095 — the jobs of a parsed workflow that run the thoryn CLI without THORYN_CI_PLAINTEXT_TOKENS: "1" in their own
 * or the workflow's env. A step-level env does not count: every thoryn step of the job reads the token the sign-in stored.
 */
export function jobsWithoutPlaintextTokenOptIn(doc) {
  const optedIn = (env) => env != null && typeof env === "object" && String(env[PLAINTEXT_TOKENS_VARIABLE]) === "1";
  const missing = [];
  for (const [id, job] of Object.entries(doc?.jobs ?? {})) {
    const runsThoryn = (job?.steps ?? []).some((s) => typeof s?.run === "string" && RUNS_THORYN.test(s.run));
    if (runsThoryn && !optedIn(job.env) && !optedIn(doc.env)) missing.push(id);
  }
  return missing;
}

const plaintextTokenProblem = (wf, job) =>
  `${wf}: job ${job} runs the thoryn CLI but does not set ${PLAINTEXT_TOKENS_VARIABLE}: "1" (job or workflow env) — a GitHub-hosted runner has no OS keychain, so \`thoryn login\` fails with TokenStoreUnavailableException`;

/** SSO-4095 — the same rule over this repository's own workflows (the staging e2e and the config plan sign in too). */
export function checkRepositoryWorkflows(repoRoot) {
  const dir = join(repoRoot, ".github/workflows");
  if (!existsSync(dir)) return [];
  const problems = [];
  for (const wf of readdirSync(dir).filter((f) => /\.ya?ml$/.test(f)).sort()) {
    const doc = YAML.parse(readFileSync(join(dir, wf), "utf8"));
    for (const job of jobsWithoutPlaintextTokenOptIn(doc)) problems.push(plaintextTokenProblem(`.github/workflows/${wf}`, job));
  }
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
  const workflowProblems = checkRepositoryWorkflows(root);
  problems.push(...workflowProblems);
  if (!workflowProblems.length) console.log(`✔ .github/workflows: every job that runs the thoryn CLI sets ${PLAINTEXT_TOKENS_VARIABLE}`);
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
