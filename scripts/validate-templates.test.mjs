// SSO-3428 — the validator is the gate that keeps the starters unrendered and on the variable contract.
import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PLACEHOLDER_TOKEN, TENANT_SCOPES, checkStarter, compileSchemas, findPlaceholders } from "./validate-templates.mjs";
import { rmSync } from "node:fs";
import YAML from "yaml";

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
  edit(dir, ".thoryn/environments/production/provision.yaml", (t) => t.replace('slug: "{{env.THORYN_SANDBOX_ENVIRONMENT}}"', 'slug: "{{env.SANDBOX_NAME}}"'));
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

// SSO-3971 — the config starter is TENANT provisioning in the stub shape: the creation flow seeds the stub, its
// configuration and each connection's contract, so the template carries none of them.
test("a config section must declare apiVersion thoryn.io/tenant/v1", () => {
  const dir = copy("config");
  edit(dir, ".thoryn/environments/sandbox/provision.yaml", (t) => t.replace("apiVersion: thoryn.io/tenant/v1", "apiVersion: thoryn.io/provision/v1"));
  assert.match(checkStarter(dir, schemas).join("\n"), /sandbox\/provision\.yaml: a config section is tenant provisioning — apiVersion must be thoryn\.io\/tenant\/v1, not thoryn\.io\/provision\/v1/);
});

test("a config template ships no workflow, no CI script, no workflow.yaml and no connection.json — the creation flow seeds them", () => {
  const dir = copy("config");
  mkdirSync(join(dir, ".github/workflows"), { recursive: true });
  writeFileSync(join(dir, ".github/workflows/thoryn.yml"), "name: Thoryn configuration\non: push\njobs: {}\n");
  writeFileSync(join(dir, ".github/workflows/thoryn-provisioning.yml"), "name: Thoryn provisioning\n");
  mkdirSync(join(dir, ".thoryn/ci"));
  writeFileSync(join(dir, ".thoryn/ci/login.sh"), "#!/usr/bin/env bash\n");
  writeFileSync(join(dir, ".thoryn/workflow.yaml"), "apiVersion: thoryn.io/workflow/v1\n");
  writeFileSync(join(dir, ".thoryn/environments/production/connection.json"), "{}\n");
  const problems = checkStarter(dir, schemas).join("\n");
  assert.match(problems, /\.github\/workflows\/thoryn\.yml: a config template ships no workflow/);
  assert.match(problems, /\.github\/workflows\/thoryn-provisioning\.yml: a config template ships no workflow/);
  assert.match(problems, /\.thoryn\/ci\/ is gone from the config template/);
  assert.match(problems, /\.thoryn\/workflow\.yaml is seeded by the creation flow/);
  assert.match(problems, /\.thoryn\/environments\/production\/connection\.json is seeded by the creation flow/);
});

test("the pre-split config template (variable-driven thoryn.yml, .thoryn/ci, provision/v1) fails the check", () => {
  // The shape thoryn-starters published until SSO-3971 (commit eb4a2f6): the control for the two tests above.
  const dir = copy("config");
  for (const section of ["production", "sandbox"]) {
    edit(dir, `.thoryn/environments/${section}/provision.yaml`, (t) => t.replace("apiVersion: thoryn.io/tenant/v1", "apiVersion: thoryn.io/provision/v1"));
  }
  mkdirSync(join(dir, ".github/workflows"), { recursive: true });
  writeFileSync(join(dir, ".github/workflows/thoryn.yml"), "name: Thoryn configuration\non: push\npermissions:\n  id-token: write\njobs: {}\n");
  mkdirSync(join(dir, ".thoryn/ci"));
  cpSync(join(root, "shared/thoryn/ci/login.sh"), join(dir, ".thoryn/ci/login.sh"));
  const problems = checkStarter(dir, schemas);
  assert.equal(problems.filter((p) => /apiVersion must be thoryn\.io\/tenant\/v1/.test(p)).length, 2);
  assert.ok(problems.some((p) => /thoryn\.yml: a config template ships no workflow/.test(p)), problems.join("\n"));
  assert.ok(problems.some((p) => /\.thoryn\/ci\/ is gone/.test(p)), problems.join("\n"));
});

// SSO-3993 — the config template changes nothing that already exists: its sections declare only the sandbox the setup
// creates (everything else is a commented example; the import pull request, SSO-3995, brings the live configuration),
// and its connections request read and write for every tenant kind, so the import can read the whole tenant.
const PRODUCTION = ".thoryn/environments/production/provision.yaml";
const SANDBOX = ".thoryn/environments/sandbox/provision.yaml";

test("a config section declares only the environment the setup creates — any other tenant kind fails", () => {
  const dir = copy("config");
  edit(dir, PRODUCTION, (t) => `${t}\n  - kind: loginMethods\n    spec:\n      methods: ["password", "passkey"]\n`);
  edit(dir, SANDBOX, (t) => `${t}\n  - kind: user\n    name: test-user\n    environment: "{{env.THORYN_SANDBOX_ENVIRONMENT}}"\n    spec:\n      email: "t@example.com"\n      passwordEnv: THORYN_TEST_USER_PASSWORD\n`);
  const problems = checkStarter(dir, schemas).join("\n");
  assert.match(problems, /production\/provision\.yaml: a config template declares only the environment the setup creates — loginMethods\/loginMethods would change an existing workspace/);
  assert.match(problems, /sandbox\/provision\.yaml: a config template declares only the environment the setup creates — user\/test-user would change an existing workspace/);
});

test("a commented example is not a declaration: the shipped sections carry them and validate", () => {
  for (const f of [PRODUCTION, SANDBOX]) {
    const text = readFileSync(join(root, "starters/config", f), "utf8");
    assert.match(text, /^ {2}# - kind: (loginMethods|user)$/m, `${f} keeps its commented examples`);
  }
  assert.deepEqual(checkStarter(join(root, "starters/config"), schemas), []);
});

/** The commented `# - kind:` examples of a section, uncommented, as the `resources` of a tenant file. */
function commentedExamples(text) {
  const entries = [];
  for (const line of text.split("\n")) {
    if (/^ {2}# - kind: /.test(line)) entries.push([line.replace(/^ {2}# /, "  ")]);
    else if (entries.length && /^ {2}# {3}/.test(line) && !entries.at(-1).done) entries.at(-1).push(line.replace(/^ {2}# /, "  "));
    else if (entries.length) entries.at(-1).done = true;
  }
  return YAML.parse(`apiVersion: thoryn.io/tenant/v1\nresources:\n${entries.map((e) => e.join("\n")).join("\n")}\n`).resources;
}

/**
 * SSO-4052 — identity-service's `{{variable}}` allowlist per email template type (oauthy
 * servers/federation-members/identity-service/.../emailtemplates/EmailTemplateType.kt): a body naming any other variable is
 * refused at apply with `400 unknown_template_variable`.
 */
const EMAIL_TEMPLATE_VARIABLES = { magic_link: ["magicLinkUrl", "displayName", "expiryMinutes"] };

test("every commented example, uncommented, validates against the provisioning schema — and its email bodies exist and use only allowed variables", () => {
  for (const f of [PRODUCTION, SANDBOX]) {
    const examples = commentedExamples(readFileSync(join(root, "starters/config", f), "utf8"));
    assert.ok(examples.length >= 3, `${f}: found its commented examples`);
    const doc = { apiVersion: "thoryn.io/tenant/v1", resources: examples };
    assert.ok(schemas.provision(doc), `${f}: ${schemas.ajv.errorsText(schemas.provision.errors)}`);
  }
  const examples = commentedExamples(readFileSync(join(root, "starters/config", PRODUCTION), "utf8"));
  // SSO-4041 — the branding example shows the whole record (an undeclared field is cleared on apply).
  const theme = examples.find((r) => r.kind === "loginTheme");
  // SSO-4048 (cli-v0.53.0) — plus the workspace name, browser title, favicon and support link. The terms and privacy
  // links stay commented inside the example (left unset, the hosted page keeps its default footer).
  assert.deepEqual(Object.keys(theme.spec).sort(), [
    "backgroundColor", "borderRadiusPx", "cssVariables", "displayName", "faviconUrl", "logoUrl", "pageTitle", "primaryColor",
    "supportUrl", "theme",
  ]);
  assert.equal(Object.keys(theme.spec.cssVariables).length, 4);
  const production = readFileSync(join(root, "starters/config", PRODUCTION), "utf8");
  const legal = Object.fromEntries(
    [...production.matchAll(/^ {2}# {5}# (termsUrl|privacyUrl): (".*")$/gm)].map((m) => [m[1], JSON.parse(m[2])]),
  );
  assert.deepEqual(Object.keys(legal).sort(), ["privacyUrl", "termsUrl"], "the legal links are shown, commented, in the loginTheme example");
  const withLegal = { apiVersion: "thoryn.io/tenant/v1", resources: [{ ...theme, spec: { ...theme.spec, ...legal } }] };
  assert.ok(schemas.provision(withLegal), `loginTheme with the legal links: ${schemas.ajv.errorsText(schemas.provision.errors)}`);
  // SSO-4042 — the email template example: magic_link in English and Dutch, each body a file beside the section.
  const templates = examples.filter((r) => r.kind === "emailTemplate");
  assert.deepEqual(templates.map((r) => `${r.spec.type}/${r.spec.locale}`).sort(), ["magic_link/en", "magic_link/nl"]);
  for (const r of templates) {
    const allowed = EMAIL_TEMPLATE_VARIABLES[r.spec.type];
    assert.ok(allowed, `${r.name}: add the allowlist of ${r.spec.type}`);
    const body = join(root, "starters/config", dirname(PRODUCTION), r.spec.bodyFile);
    assert.ok(existsSync(body), `${r.name}: ${r.spec.bodyFile} exists beside the section`);
    const used = [...`${r.spec.subject}\n${readFileSync(body, "utf8")}`.matchAll(/\{\{\s*([A-Za-z][A-Za-z0-9]*)\s*}}/g)].map((m) => m[1]);
    assert.deepEqual(used.filter((v) => !allowed.includes(v)), [], `${r.name}: only ${allowed.join(", ")}`);
    assert.ok(used.includes("magicLinkUrl"), `${r.name}: the body carries the sign-in link`);
  }
  // SSO-4054 (cli-v0.54.0) — templates are per environment. The examples are production's (no `environment:`), and the
  // sandbox section's note holds: the same template declared in the sandbox, with its environment, validates.
  assert.deepEqual(templates.filter((r) => "environment" in r).map((r) => r.name), [], "the email template examples are production's");
  const sandboxCopy = { ...templates[0], name: "magic-link-sandbox", environment: "{{env.THORYN_SANDBOX_ENVIRONMENT}}" };
  assert.ok(
    schemas.provision({ apiVersion: "thoryn.io/tenant/v1", resources: [sandboxCopy] }),
    `a sandbox's own emailTemplate: ${schemas.ajv.errorsText(schemas.provision.errors)}`,
  );
  assert.match(readFileSync(join(root, "starters/config", SANDBOX), "utf8"), /^ {2}# .*emailTemplate.*\n {2}# `environment: "\{\{env\.THORYN_SANDBOX_ENVIRONMENT\}\}"`/m, "the sandbox section says how it declares its own email template");
  // SSO-4058 (cli-v0.55.0, thoryn-cli SSO-4057) — the legal-document examples: production's two types without `environment:`,
  // the sandbox's own copy with it; Markdown bodies next to the section where the import writes the active version.
  const legalDocs = examples.filter((r) => r.kind === "legalDocument");
  assert.deepEqual(legalDocs.map((r) => r.spec.type).sort(), ["privacy-policy", "terms-of-use"]);
  for (const r of legalDocs) {
    assert.deepEqual(Object.keys(r.spec).sort(), ["bodyFile", "format", "title", "type", "version"], `${r.name}: the shape thoryn-cli #194 shipped`);
    assert.equal(r.spec.format, "markdown");
    assert.equal(r.spec.bodyFile, `legal/${r.spec.type}.md`, `${r.name}: the path the import writes the active version to`);
    assert.ok(!("environment" in r), `${r.name}: production's`);
  }
  assert.match(production, /legal-documents\.\*[\s\S]*PER ENVIRONMENT[\s\S]*no fallback[\s\S]*no HTML/, "the example says: per environment, no fallback, HTML refused");
  const sandboxLegal = commentedExamples(readFileSync(join(root, "starters/config", SANDBOX), "utf8")).filter((r) => r.kind === "legalDocument");
  assert.deepEqual(sandboxLegal.map((r) => [r.spec.type, r.environment, r.spec.bodyFile]), [["terms-of-use", "{{env.THORYN_SANDBOX_ENVIRONMENT}}", "legal/{{env.THORYN_SANDBOX_ENVIRONMENT}}/terms-of-use.md"]]);
  // An HTML body is what the kind refuses: the schema's inline-body pattern says so (the file rule is the CLI's at load time).
  const html = { ...legalDocs[0], spec: { ...legalDocs[0].spec, bodyFile: undefined, body: "<p>Terms</p>" } };
  delete html.spec.bodyFile;
  assert.ok(!schemas.provision({ apiVersion: "thoryn.io/tenant/v1", resources: [html] }), "an inline HTML body does not validate");
  const autolink = { ...html, spec: { ...html.spec, body: "See <https://example.com/terms>." } };
  assert.ok(schemas.provision({ apiVersion: "thoryn.io/tenant/v1", resources: [autolink] }), `a Markdown autolink validates: ${schemas.ajv.errorsText(schemas.provision.errors)}`);
});

test("a config sandbox section declares its own sandbox, read-only", () => {
  const dir = copy("config");
  edit(dir, SANDBOX, (t) => t.replace("    readOnly: true\n", ""));
  assert.match(checkStarter(dir, schemas).join("\n"), /sandbox\/provision\.yaml: environment\/sandbox must be readOnly: true/);

  const other = copy("config");
  edit(other, SANDBOX, (t) => t.replace('      slug: "{{env.THORYN_SANDBOX_ENVIRONMENT}}"', '      slug: "dev"'));
  assert.match(checkStarter(other, schemas).join("\n"), /sandbox\/provision\.yaml: environment\/sandbox must be \{\{env\.THORYN_SANDBOX_ENVIRONMENT\}\}, the sandbox this section configures/);
});

test("the production section owns the sandbox it declares, and declares no environment the setup did not create", () => {
  const dir = copy("config");
  edit(dir, PRODUCTION, (t) => t.replace("    retain: true\n", "    readOnly: true\n"));
  assert.match(checkStarter(dir, schemas).join("\n"), /production\/provision\.yaml: environment\/sandbox must not be readOnly/);

  const extra = copy("config");
  edit(extra, PRODUCTION, (t) => `${t}\n  - kind: environment\n    name: staging\n    spec:\n      slug: staging\n`);
  assert.match(checkStarter(extra, schemas).join("\n"), /production\/provision\.yaml: environment\/staging is not a sandbox the setup creates/);
});

test("a config section declares the sandbox by its slug only: a display name would be compared with the live one", () => {
  const dir = copy("config");
  edit(dir, PRODUCTION, (t) => t.replace('      slug: "{{env.THORYN_SANDBOX_ENVIRONMENT}}"\n', '      slug: "{{env.THORYN_SANDBOX_ENVIRONMENT}}"\n      displayName: "Sandbox {{env.THORYN_SANDBOX_ENVIRONMENT}}"\n'));
  assert.match(checkStarter(dir, schemas).join("\n"), /production\/provision\.yaml: environment\/sandbox is declared by its slug only — displayName would be compared with the live sandbox/);
});

test("every config connection requests read and write for every tenant kind", () => {
  const dir = copy("config");
  editJson(dir, ".thoryn/template.json", (m) => {
    m.connections.production.scopes = m.connections.production.scopes.filter((s) => s !== "tenant:email.read");
    m.connections.sandbox.scopes = m.connections.sandbox.scopes.filter((s) => !s.startsWith("tenant:roles."));
    return m;
  });
  const problems = checkStarter(dir, schemas).join("\n");
  assert.match(problems, /connection production: a config connection requests read and write for every tenant kind — missing tenant:email\.read/);
  assert.match(problems, /connection sandbox: a config connection requests read and write for every tenant kind — missing tenant:roles\.read, tenant:roles\.write/);
});

test("every config connection requests the legal-documents scopes, which the legalDocument kind needs (SSO-4058)", () => {
  const pair = ["tenant:legal-documents.read", "tenant:legal-documents.write"];
  assert.ok(pair.every((s) => TENANT_SCOPES.includes(s)), TENANT_SCOPES.join(" "));
  const published = JSON.parse(readFileSync(join(root, "starters/config/.thoryn/template.json"), "utf8"));
  for (const [name, c] of Object.entries(published.connections)) {
    assert.ok(pair.every((s) => c.scopes.includes(s)), `${name}: ${c.scopes.join(" ")}`);
    // Product owner 2026-10-29: a config project's CI identity never gets tenant:compliance.* (erasure, DSAR, SCIM
    // deprovision, SSF, consent purposes and retention ride compliance.write).
    assert.ok(!c.scopes.some((s) => s.startsWith("tenant:compliance.")), `${name}: ${c.scopes.join(" ")}`);
  }
  // A config template from before SSO-4058 (every other tenant kind, no legal-documents) fails the check, naming both scopes.
  const dir = copy("config");
  editJson(dir, ".thoryn/template.json", (m) => {
    for (const c of Object.values(m.connections)) c.scopes = c.scopes.filter((s) => !s.startsWith("tenant:legal-documents."));
    return m;
  });
  const problems = checkStarter(dir, schemas).join("\n");
  assert.match(problems, /connection production: a config connection requests read and write for every tenant kind — missing tenant:legal-documents\.read, tenant:legal-documents\.write/);
  assert.match(problems, /connection sandbox: a config connection requests read and write for every tenant kind — missing tenant:legal-documents\.read, tenant:legal-documents\.write/);
});

test("the pre-SSO-3993 config template (login methods declared, idp and environments scopes only) fails the check", () => {
  // The shape thoryn-starters published until SSO-3993 (commit dbea3ef): the control for the tests above.
  const dir = copy("config");
  writeFileSync(join(dir, PRODUCTION), `apiVersion: thoryn.io/tenant/v1
resources:
  - kind: environment
    name: sandbox
    spec:
      slug: "{{env.THORYN_SANDBOX_ENVIRONMENT}}"
      displayName: "Sandbox {{env.THORYN_SANDBOX_ENVIRONMENT}}"
  - kind: loginMethods
    spec:
      methods: ["password", "passkey"]
`);
  writeFileSync(join(dir, SANDBOX), `apiVersion: thoryn.io/tenant/v1
resources:
  - kind: loginMethods
    environment: "{{env.THORYN_SANDBOX_ENVIRONMENT}}"
    spec:
      methods: ["password", "passkey", "magic_code", "magic_link"]
`);
  editJson(dir, ".thoryn/template.json", (m) => {
    m.connections.production.scopes = ["tenant:environments.read", "tenant:environments.write", "tenant:idp.read", "tenant:idp.write", "tenant:access.read"];
    m.connections.sandbox.scopes = ["tenant:environments.read", "tenant:idp.read", "tenant:idp.write", "tenant:access.read"];
    return m;
  });
  const problems = checkStarter(dir, schemas);
  assert.equal(problems.filter((p) => /declares only the environment the setup creates — loginMethods/.test(p)).length, 2, problems.join("\n"));
  assert.equal(problems.filter((p) => /requests read and write for every tenant kind/.test(p)).length, 2, problems.join("\n"));
  assert.ok(problems.some((p) => /environment\/sandbox is declared by its slug only — displayName/.test(p)), problems.join("\n"));
});
