import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RenderError, parseManifest, renderTemplate, renderText, validateValues } from "./render.mjs";

const manifest = parseManifest({
  apiVersion: "thoryn.io/starter-template/v1",
  kind: "application",
  variables: {
    workspace: { description: "ws", pattern: "^[a-z0-9-]+$", example: "acme" },
    appName: { description: "name", pattern: "^[A-Za-z0-9 ]+$", example: "My App" },
  },
  files: ["a.json", "b.yaml"],
});

function template(files) {
  const dir = mkdtempSync(join(tmpdir(), "tpl-"));
  mkdirSync(join(dir, ".thoryn"), { recursive: true });
  writeFileSync(join(dir, ".thoryn/template.json"), JSON.stringify(manifest));
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(join(dir, name, ".."), { recursive: true });
    writeFileSync(join(dir, name), text);
  }
  return dir;
}

const out = () => join(mkdtempSync(join(tmpdir(), "out-")), "repo");

test("renderText substitutes declared placeholders, with or without inner spaces", () => {
  const values = { workspace: "acme", appName: "My App" };
  assert.equal(renderText('{"s":"{{thoryn.workspace}}","n":"{{ thoryn.appName }}"}', manifest, values), '{"s":"acme","n":"My App"}');
});

test("renderText refuses an undeclared placeholder", () => {
  assert.throws(() => renderText("{{thoryn.secret}}", manifest, {}), RenderError);
});

test("validateValues refuses missing, unknown and pattern-breaking values", () => {
  assert.throws(() => validateValues(manifest, { workspace: "acme" }), /missing value for "appName"/);
  assert.throws(() => validateValues(manifest, { workspace: "acme", appName: "x", extra: "y" }), /unknown variable "extra"/);
  // A quote would break out of the JSON / YAML string it lands in.
  assert.throws(() => validateValues(manifest, { workspace: 'acme", "x": "', appName: "x" }), /does not match/);
});

test("renderTemplate renders the listed files, drops the manifest and copies the rest", () => {
  const dir = template({ "a.json": '{"w":"{{thoryn.workspace}}"}', "b.yaml": 'name: "{{thoryn.appName}}"\n', "src/app.js": "console.log(1)\n" });
  const dest = out();
  renderTemplate({ templateDir: dir, outDir: dest, values: { workspace: "acme", appName: "My App" } });
  assert.equal(readFileSync(join(dest, "a.json"), "utf8"), '{"w":"acme"}');
  assert.equal(readFileSync(join(dest, "b.yaml"), "utf8"), 'name: "My App"\n');
  assert.equal(readFileSync(join(dest, "src/app.js"), "utf8"), "console.log(1)\n");
  assert.equal(existsSync(join(dest, ".thoryn/template.json")), false, "a rendered repository is not a template");
});

test("renderTemplate fails when an unlisted file carries a placeholder, and leaves no output", () => {
  const dir = template({ "a.json": "{}", "b.yaml": "x: 1\n", "README.md": "# {{thoryn.workspace}}\n" });
  const dest = out();
  assert.throws(() => renderTemplate({ templateDir: dir, outDir: dest, values: { workspace: "acme", appName: "A" } }), /README.md still contains/);
  assert.equal(existsSync(dest), false);
});

test("renderTemplate never copies local state (.env, receipts, node_modules)", () => {
  const dir = template({ "a.json": "{}", "b.yaml": "x: 1\n", ".env": "OIDC_CLIENT_ID=x\n", ".thoryn/provision.receipt.json": "{}", "node_modules/x/index.js": "" });
  const dest = out();
  renderTemplate({ templateDir: dir, outDir: dest, values: { workspace: "acme", appName: "A" } });
  assert.equal(existsSync(join(dest, ".env")), false);
  assert.equal(existsSync(join(dest, ".thoryn/provision.receipt.json")), false);
  assert.equal(existsSync(join(dest, "node_modules")), false);
});

test("parseManifest insists on anchored patterns and self-consistent examples", () => {
  const base = { apiVersion: "thoryn.io/starter-template/v1", kind: "application", files: ["a"] };
  assert.throws(() => parseManifest({ ...base, variables: { a: { description: "d", pattern: "[a-z]+", example: "a" } } }), /anchored/);
  assert.throws(() => parseManifest({ ...base, variables: { a: { description: "d", pattern: "^[a-z]+$", example: "A" } } }), /example/);
  assert.throws(() => parseManifest({ ...base, kind: "other", variables: {} }), /kind/);
});
