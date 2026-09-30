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
//  - the workflows read only declared variables (plus THORYN_CLI_VERSION), read every one of them, request
//    `id-token: write`, read no secret, and run the shared CI steps.

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
/** Optional variables a workflow may read without declaring them. */
const OPTIONAL_VARS = new Set(["THORYN_CLI_VERSION"]);
const APP_KINDS = new Set(["application", "user"]);
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
    if (!c.production) {
      for (const r of resources) {
        if (r.kind === "environment") fail(`${c.provisionFile}: a sandbox connection must not declare an environment (production does)`);
        else if (!envRef(c.environmentVariable).test(r.environment ?? "")) {
          fail(`${c.provisionFile}: ${r.kind}/${r.name ?? r.kind} must live in {{env.${c.environmentVariable}}}, the sandbox its connection names`);
        }
      }
    } else {
      for (const r of resources) if (r.environment) fail(`${c.provisionFile}: the production section converges the production plane; ${r.kind} names an environment`);
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
    const sections = existsSync(join(dir, ".thoryn/environments")) ? readdirSync(join(dir, ".thoryn/environments")) : [];
    for (const s of sections) if (!manifest.connections[s]) fail(`section .thoryn/environments/${s} has no connection in template.json`);
  }
  for (const name of Object.keys(declared)) if (!usedVariables.has(name)) fail(`template.json declares ${name}, but no connection uses it`);

  // Workflows.
  const wfDir = join(dir, ".github/workflows");
  const workflows = existsSync(wfDir) ? readdirSync(wfDir).filter((f) => /\.ya?ml$/.test(f)) : [];
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
  for (const [name] of connections) {
    if (workflows.length && !text.includes(`.thoryn/ci/login.sh ${name}`) && manifest.kind === "config") fail(`the workflow never signs in as connection ${name}`);
  }
  if (manifest.kind === "application") {
    for (const step of ["install-cli.sh", "provision.sh", "start-app.sh", "teardown.sh"]) {
      if (!text.includes(`.thoryn/ci/${step}`)) fail(`the workflow does not run .thoryn/ci/${step}`);
    }
  }
  if (existsSync(join(dir, ".thoryn/connection.json"))) fail(".thoryn/connection.json is gone: sign-in is declared by template.json connections");
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
  if (problems.length) {
    console.error(`\n✖ ${problems.length} problem(s):\n  ${problems.join("\n  ")}`);
    process.exit(1);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main();
