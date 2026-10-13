// SSO-3428 — the validator is the gate that keeps the starters unrendered and on the variable contract.
import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PLACEHOLDER_TOKEN, checkStarter, compileSchemas, findPlaceholders } from "./validate-templates.mjs";
import { rmSync } from "node:fs";

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

test("the application's sandbox client must accept the default local callbacks on 127.0.0.1 and localhost:8080", () => {
  const dir = copy("express");
  edit(dir, ".thoryn/provision.yaml", (t) => t.replace('        - "http://localhost:8080/callback"\n', ""));
  assert.match(checkStarter(dir, schemas).join("\n"), /redirectUris must include http:\/\/localhost:8080\/callback/);
});

test("a plain-http redirect URI is loopback-only, names the localhost port, and never sits on a production client", () => {
  const dir = copy("express");
  edit(dir, ".thoryn/provision.yaml", (t) =>
    t.replace('"http://localhost:8080/signed-out"', '"http://localhost/signed-out"').replace('"http://127.0.0.1/signed-out"', '"http://app.example.com/signed-out"'));
  const problems = checkStarter(dir, schemas).join("\n");
  assert.match(problems, /http:\/\/app\.example\.com\/signed-out: plain http is for loopback development only/);
  assert.match(problems, /http:\/\/localhost\/signed-out: the platform matches localhost exactly, so name the port/);

  const config = copy("config");
  edit(config, ".thoryn/environments/production/provision.yaml", (t) => t.replace("resources:\n", `resources:
  - kind: application
    name: local
    spec: { displayName: "x", redirectUris: ["http://localhost:8080/callback"] }
`));
  assert.match(checkStarter(config, schemas).join("\n"), /belongs on a sandbox client, never on production/);
});

test("every starter's .gitignore keeps the generated local test user out of git", () => {
  const dir = copy("aspnet-core");
  edit(dir, ".gitignore", (t) => t.replace(".thoryn/local.env", ""));
  assert.match(checkStarter(dir, schemas).join("\n"), /\.gitignore must list \.thoryn\/local\.env/);
});

// SSO-3666 — the production deploy skeleton of an application starter.
test("an application starter must read the published production client id and resolve its settings in production mode", () => {
  const dir = copy("express");
  rmSync(join(dir, ".github/workflows/deploy.yml"));
  const problems = checkStarter(dir, schemas).join("\n");
  assert.match(problems, /no workflow reads vars\.THORYN_PRODUCTION_CLIENT_ID/);
  assert.match(problems, /no workflow runs \.thoryn\/app-env\.mjs --production/);
  assert.match(problems, /no workflow job runs in GitHub environment production/);
});

test("the production deploy job holds no Thoryn identity: no id-token: write, no sign-in, no provisioning", () => {
  const dir = copy("spring-boot");
  edit(dir, ".github/workflows/deploy.yml", (t) => t.replace("    permissions:\n      contents: read", "    permissions:\n      contents: read\n      id-token: write"));
  assert.match(checkStarter(dir, schemas).join("\n"), /deploy\.yml: job deploy-production runs in GitHub environment production and requests id-token: write/);

  const dir2 = copy("aspnet-core");
  edit(dir2, ".github/workflows/deploy.yml", (t) => t.replace("        run: node .thoryn/app-env.mjs --production --github-env", "        run: |\n          .thoryn/ci/login.sh sandbox\n          node .thoryn/app-env.mjs --production --github-env"));
  assert.match(checkStarter(dir2, schemas).join("\n"), /deploy\.yml: job deploy-production runs in GitHub environment production and signs in to or provisions Thoryn/);
});

test("the published production client id is read without being declared: the creation flow does not set it", () => {
  const dir = copy("express");
  // Declaring it would make the orchestrator refuse the template (fixed contract); the validator says so.
  editJson(dir, ".thoryn/template.json", (m) => {
    m.variables.THORYN_PRODUCTION_CLIENT_ID = { level: "environment", environment: "production", description: "x" };
    return m;
  });
  assert.match(checkStarter(dir, schemas).join("\n"), /declares THORYN_PRODUCTION_CLIENT_ID, which is not in the application contract/);
});
