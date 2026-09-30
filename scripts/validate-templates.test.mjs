// SSO-3428 — the validator is the gate that keeps the starters unrendered and on the variable contract.
import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PLACEHOLDER_TOKEN, checkStarter, compileSchemas, findPlaceholders } from "./validate-templates.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const schemas = compileSchemas();

function copy(starter) {
  const dir = join(mkdtempSync(join(tmpdir(), "validate-")), starter);
  cpSync(join(root, "starters", starter), dir, { recursive: true, filter: (p) => !p.includes("node_modules") });
  return dir;
}
const edit = (dir, rel, fn) => writeFileSync(join(dir, rel), fn(readFileSync(join(dir, rel), "utf8")));
const editJson = (dir, rel, fn) => edit(dir, rel, (t) => JSON.stringify(fn(JSON.parse(t)), null, 2));

test("every starter in this repository validates as is", () => {
  for (const s of ["express", "spring-boot", "aspnet-core", "config"]) assert.deepEqual(checkStarter(join(root, "starters", s), schemas), [], s);
});

test("a render placeholder anywhere fails, in any file", () => {
  const dir = copy("express");
  assert.deepEqual(findPlaceholders(dir), []);
  edit(dir, "README.md", (t) => `${t}\nWorkspace: ${PLACEHOLDER_TOKEN}workspace}}\n`);
  edit(dir, "src/app.js", (t) => `// {{ ${"thoryn"}.x }}\n${t}`);
  assert.deepEqual(findPlaceholders(dir).sort(), ["README.md", "src/app.js"]);
});

test("the application declaration must carry exactly the fixed variable contract", () => {
  const dir = copy("express");
  editJson(dir, ".thoryn/template.json", (m) => {
    delete m.variables.THORYN_WIF_CLIENT_ID;
    m.variables.THORYN_APP_NAME = { level: "repository", description: "x" };
    return m;
  });
  const problems = checkStarter(dir, schemas).join("\n");
  assert.match(problems, /does not declare THORYN_WIF_CLIENT_ID/);
  assert.match(problems, /declares THORYN_APP_NAME, which is not in the application contract/);
});

test("the production client id must be a variable of the production GitHub environment", () => {
  const dir = copy("config");
  editJson(dir, ".thoryn/template.json", (m) => {
    m.variables.THORYN_PRODUCTION_WIF_CLIENT_ID.environment = "prod";
    return m;
  });
  assert.match(checkStarter(dir, schemas).join("\n"), /THORYN_PRODUCTION_WIF_CLIENT_ID must live in the production GitHub environment "thoryn-production"/);
});

test("an application resource must live in the sandbox its connection names, not a literal slug", () => {
  const dir = copy("spring-boot");
  edit(dir, ".thoryn/provision.yaml", (t) => t.replace('environment: "{{env.THORYN_ENVIRONMENT}}"', "environment: dev"));
  assert.match(checkStarter(dir, schemas).join("\n"), /application\/web must live in \{\{env\.THORYN_ENVIRONMENT\}\}/);
});

test("a workflow may read only declared variables, and must read every one", () => {
  const dir = copy("aspnet-core");
  edit(dir, ".github/workflows/ci.yml", (t) => t.replaceAll("vars.THORYN_WIF_CLIENT_ID", "vars.THORYN_WIF"));
  const problems = checkStarter(dir, schemas).join("\n");
  assert.match(problems, /reads vars\.THORYN_WIF, which template\.json does not declare/);
  assert.match(problems, /no workflow reads vars\.THORYN_WIF_CLIENT_ID/);
});

test("an unknown {{env.NAME}} in a provisioning value fails; a comment may mention the grammar", () => {
  const dir = copy("config");
  edit(dir, ".thoryn/environments/production/provision.yaml", (t) => t.replace('displayName: "Sandbox {{env.THORYN_SANDBOX_ENVIRONMENT}}"', 'displayName: "{{env.SANDBOX_NAME}}"'));
  assert.match(checkStarter(dir, schemas).join("\n"), /\{\{env\.SANDBOX_NAME\}\} is neither a declared variable nor a run-time value/);
});

test("the config production section must declare every sandbox connection's environment", () => {
  const dir = copy("config");
  edit(dir, ".thoryn/environments/production/provision.yaml", (t) => t.replace('slug: "{{env.THORYN_SANDBOX_ENVIRONMENT}}"', 'slug: "dev"'));
  assert.match(checkStarter(dir, schemas).join("\n"), /does not declare the sandbox \{\{env\.THORYN_SANDBOX_ENVIRONMENT\}\}/);
});
