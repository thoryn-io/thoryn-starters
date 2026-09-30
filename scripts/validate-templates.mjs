#!/usr/bin/env node
// Render every starter with its manifest's EXAMPLE values and check the result is what the thoryn CLI and
// the render contract expect. A template that fails here is never published.
//
//  - the manifest is valid and every listed file renders; no placeholder is left anywhere;
//  - every rendered connection file validates against the CLI's connection schema, uses workload identity
//    and names no secret;
//  - every rendered provisioning file validates against the CLI's provisioning schema;
//  - an APPLICATION project declares only application and user resources (no environment, no workspace
//    configuration), each inside the environment its connection names;
//  - the starter's own pipeline requests `id-token: write` and runs the shared CI steps.

import { mkdtempSync, readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import YAML from "yaml";
import { exampleValues, readManifest, renderTemplate } from "../render/render.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const ajv = new Ajv2020({ allErrors: true, strict: false });
const validateConnection = ajv.compile(JSON.parse(readFileSync(join(root, "schemas/connection.schema.json"), "utf8")));
const validateProvision = ajv.compile(JSON.parse(readFileSync(join(root, "schemas/provision.schema.json"), "utf8")));

const APP_KINDS = new Set(["application", "user"]);
const problems = [];
const fail = (starter, msg) => problems.push(`${starter}: ${msg}`);

function walk(dir, pred, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, pred, out);
    else if (pred(name)) out.push(p);
  }
  return out;
}

for (const starter of readdirSync(join(root, "starters")).sort()) {
  const templateDir = join(root, "starters", starter);
  let manifest;
  let outDir;
  try {
    manifest = readManifest(templateDir);
    outDir = join(mkdtempSync(join(tmpdir(), `starter-${starter}-`)), "repo");
    renderTemplate({ templateDir, outDir, values: exampleValues(manifest) });
  } catch (e) {
    fail(starter, e.message);
    continue;
  }

  const thoryn = join(outDir, ".thoryn");
  const connections = walk(thoryn, (n) => /^connection.*\.json$/.test(n));
  const provisions = walk(thoryn, (n) => /^provision.*\.ya?ml$/.test(n));
  if (connections.length === 0) fail(starter, "no .thoryn connection file");
  if (provisions.length === 0) fail(starter, "no .thoryn provisioning file");

  const connectionEnvs = new Set();
  for (const file of connections) {
    const rel = relative(outDir, file);
    const json = JSON.parse(readFileSync(file, "utf8"));
    if (!validateConnection(json)) fail(starter, `${rel}: ${ajv.errorsText(validateConnection.errors)}`);
    if (json.auth?.method !== "workload_identity") fail(starter, `${rel}: auth.method must be workload_identity`);
    if ("secretEnv" in (json.auth ?? {})) fail(starter, `${rel}: names a secret`);
    if (json.auth?.environment) connectionEnvs.add(json.auth.environment);
  }

  for (const file of provisions) {
    const rel = relative(outDir, file);
    const doc = YAML.parse(readFileSync(file, "utf8"));
    if (!validateProvision(doc)) fail(starter, `${rel}: ${ajv.errorsText(validateProvision.errors)}`);
    if (manifest.kind === "application") {
      for (const r of doc.resources ?? []) {
        if (!APP_KINDS.has(r.kind)) fail(starter, `${rel}: an application project must not declare a '${r.kind}' (that belongs to the workspace config project)`);
        if (!connectionEnvs.has(r.environment)) fail(starter, `${rel}: ${r.kind}/${r.name} must live in the environment connection.json names`);
      }
    }
  }

  if (manifest.kind === "config") {
    // One section per environment: production (no `environment` in its connection) declares the
    // environments; each sandbox section converges only its own environment's configuration.
    const sections = join(thoryn, "environments");
    const declared = new Set();
    const sandboxSlugs = [];
    for (const name of existsSync(sections) ? readdirSync(sections) : []) {
      const conn = join(sections, name, "connection.json");
      const prov = join(sections, name, "provision.yaml");
      if (!existsSync(conn) || !existsSync(prov)) {
        fail(starter, `section ${name} needs connection.json and provision.yaml`);
        continue;
      }
      const env = JSON.parse(readFileSync(conn, "utf8")).auth?.environment;
      const resources = YAML.parse(readFileSync(prov, "utf8")).resources ?? [];
      if (name === "production") {
        if (env) fail(starter, "the production section's connection must not name an environment");
        for (const r of resources) if (r.kind === "environment") declared.add(r.spec?.slug);
      } else {
        if (!env) fail(starter, `sandbox section ${name} must name its environment in connection.json`);
        sandboxSlugs.push(env);
        for (const r of resources) {
          if (r.kind === "environment") fail(starter, `sandbox section ${name} must not declare an environment (production does)`);
          if (r.environment !== env) fail(starter, `section ${name}: ${r.kind} must live in environment ${env}`);
        }
      }
    }
    if (!existsSync(join(sections, "production"))) fail(starter, "no production section");
    for (const slug of sandboxSlugs) if (!declared.has(slug)) fail(starter, `the production section does not declare sandbox ${slug}`);
  }

  const workflows = existsSync(join(outDir, ".github/workflows")) ? readdirSync(join(outDir, ".github/workflows")) : [];
  const workflow = join(outDir, ".github/workflows", workflows.includes("ci.yml") ? "ci.yml" : (workflows[0] ?? "ci.yml"));
  if (!existsSync(workflow)) {
    fail(starter, "no GitHub Actions workflow");
  } else {
    const text = readFileSync(workflow, "utf8");
    if (!/id-token:\s*write/.test(text)) fail(starter, "ci.yml never requests id-token: write");
    if (/secrets\./.test(text)) fail(starter, "the workflow reads a repository secret; the starters are secret-less");
    if (manifest.kind === "application") {
      for (const step of ["install-cli.sh", "provision.sh", "start-app.sh", "teardown.sh"]) {
        if (!text.includes(`.thoryn/ci/${step}`)) fail(starter, `ci.yml does not run .thoryn/ci/${step}`);
      }
    }
  }
  if (!problems.some((p) => p.startsWith(`${starter}:`))) console.log(`✔ ${starter} renders and validates (${manifest.kind})`);
}

if (problems.length) {
  console.error(`\n✖ ${problems.length} problem(s):\n  ${problems.join("\n  ")}`);
  process.exit(1);
}
