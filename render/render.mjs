#!/usr/bin/env node
// SSO-3309 — the REFERENCE RENDERER for the starter render contract (see README.md, "The render contract").
//
// A starter template carries `{{thoryn.<name>}}` placeholders in the files its manifest
// (`.thoryn/template.json`) lists. Rendering a starter means:
//
//   1. read the manifest; every placeholder name must be a declared variable;
//   2. check every value against its variable's `pattern` (anchored). The patterns only admit
//      characters that are safe inside a JSON string, a quoted YAML scalar and Markdown, so a value can
//      never break out of the file it is substituted into;
//   3. replace the placeholders in exactly the listed files (nothing else is touched);
//   4. fail if any `{{thoryn.` token is left anywhere in the output;
//   5. delete `.thoryn/template.json`: a rendered repository is not a template any more, and its CI
//      uses the manifest's absence as the "this repository has been rendered" signal.
//
// The starter-project creation flow (oathy SSO-3310) implements the same five steps server-side; this file
// is the executable definition it is tested against, and what this repository's own CI uses to render
// every starter before running it against staging.
//
// Zero dependencies (Node 22+).
//
//   node render/render.mjs --template starters/express --out /tmp/rendered --values values.json
//   node render/render.mjs --template starters/express --out /tmp/rendered --example
//   node render/render.mjs --template starters/express --out /tmp/rendered --set workspace=acme --set …

import { cpSync, existsSync, readFileSync, rmSync, writeFileSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

export const MANIFEST_PATH = ".thoryn/template.json";
export const MANIFEST_API_VERSION = "thoryn.io/starter-template/v1";

/** `{{thoryn.name}}`, optional inner whitespace. The name grammar is deliberately narrow. */
const PLACEHOLDER = /\{\{\s*thoryn\.([A-Za-z][A-Za-z0-9]*)\s*\}\}/g;
/** Any leftover opening token, even a malformed one (`{{ thoryn.`, `{{thoryn.9x}}`). */
const LEFTOVER = /\{\{\s*thoryn\./;

/** Directories never copied into a rendered repository (build output, installs, local state). */
const SKIP_DIRS = new Set(["node_modules", "target", "bin", "obj", "test-results", "playwright-report", ".git"]);
/** Files never copied (local-only state; the CI ignores them too). */
const SKIP_FILE = (name) => name === ".env" || name.endsWith(".receipt.json") || name.endsWith(".secret");

export class RenderError extends Error {}

/** Parse and sanity-check a manifest object. */
export function parseManifest(json) {
  if (!json || typeof json !== "object") throw new RenderError("the manifest is not a JSON object");
  if (json.apiVersion !== MANIFEST_API_VERSION) {
    throw new RenderError(`manifest apiVersion must be ${MANIFEST_API_VERSION}, got ${JSON.stringify(json.apiVersion)}`);
  }
  if (!["application", "config"].includes(json.kind)) {
    throw new RenderError(`manifest kind must be "application" or "config", got ${JSON.stringify(json.kind)}`);
  }
  const variables = json.variables;
  if (!variables || typeof variables !== "object" || Object.keys(variables).length === 0) {
    throw new RenderError("the manifest declares no variables");
  }
  for (const [name, v] of Object.entries(variables)) {
    if (!/^[A-Za-z][A-Za-z0-9]*$/.test(name)) throw new RenderError(`variable name "${name}" is not [A-Za-z][A-Za-z0-9]*`);
    if (typeof v?.pattern !== "string" || !v.pattern.startsWith("^") || !v.pattern.endsWith("$")) {
      throw new RenderError(`variable "${name}" needs an anchored "pattern" (^…$)`);
    }
    if (typeof v.description !== "string" || !v.description) throw new RenderError(`variable "${name}" needs a description`);
    if (typeof v.example !== "string" || !new RegExp(v.pattern).test(v.example)) {
      throw new RenderError(`variable "${name}" needs an "example" that matches its own pattern`);
    }
  }
  if (!Array.isArray(json.files) || json.files.length === 0) throw new RenderError("the manifest lists no files to render");
  for (const f of json.files) {
    if (typeof f !== "string" || f.startsWith("/") || f.split(/[\\/]/).includes("..")) {
      throw new RenderError(`file "${f}" must be a relative path inside the template`);
    }
  }
  return json;
}

export function readManifest(templateDir) {
  const path = join(templateDir, MANIFEST_PATH);
  if (!existsSync(path)) throw new RenderError(`${path} not found — not a starter template (or already rendered)`);
  return parseManifest(JSON.parse(readFileSync(path, "utf8")));
}

/** The example values of a manifest (what this repository's CI renders the published templates with). */
export function exampleValues(manifest) {
  return Object.fromEntries(Object.entries(manifest.variables).map(([k, v]) => [k, v.example]));
}

/** Every declared variable present, nothing undeclared, every value matching its pattern. */
export function validateValues(manifest, values) {
  const problems = [];
  for (const name of Object.keys(values)) {
    if (!(name in manifest.variables)) problems.push(`unknown variable "${name}"`);
  }
  for (const [name, v] of Object.entries(manifest.variables)) {
    const value = values[name];
    if (value === undefined || value === null || value === "") {
      problems.push(`missing value for "${name}" (${v.description})`);
    } else if (typeof value !== "string" || !new RegExp(v.pattern).test(value)) {
      problems.push(`value for "${name}" does not match ${v.pattern}`);
    }
  }
  if (problems.length) throw new RenderError(`invalid render values:\n  - ${problems.join("\n  - ")}`);
}

/** Substitute placeholders in one file's text. */
export function renderText(text, manifest, values, fileLabel = "<text>") {
  const out = text.replace(PLACEHOLDER, (_, name) => {
    if (!(name in manifest.variables)) throw new RenderError(`${fileLabel}: placeholder {{thoryn.${name}}} is not a declared variable`);
    return values[name];
  });
  if (LEFTOVER.test(out)) throw new RenderError(`${fileLabel}: a malformed {{thoryn.…}} placeholder is left after rendering`);
  return out;
}

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

/**
 * Render [templateDir] into [outDir] (created; must not exist or be empty). Returns the list of rendered
 * files. Throws [RenderError] on any contract violation, leaving no partial output behind.
 */
export function renderTemplate({ templateDir, outDir, values }) {
  const manifest = readManifest(templateDir);
  validateValues(manifest, values);
  if (existsSync(outDir) && readdirSync(outDir).length > 0) throw new RenderError(`${outDir} is not empty`);
  mkdirSync(outDir, { recursive: true });
  try {
    cpSync(templateDir, outDir, {
      recursive: true,
      filter: (src) => {
        const name = src.split(sep).pop();
        if (statSync(src).isDirectory()) return !SKIP_DIRS.has(name);
        return !SKIP_FILE(name);
      },
    });
    for (const file of manifest.files) {
      const target = join(outDir, file);
      if (!existsSync(target)) throw new RenderError(`listed file ${file} does not exist in the template`);
      writeFileSync(target, renderText(readFileSync(target, "utf8"), manifest, values, file));
    }
    rmSync(join(outDir, MANIFEST_PATH));
    // Step 4: nothing anywhere may still carry a placeholder (a file the manifest forgot to list).
    walk(outDir, (p) => {
      const text = readFileSync(p);
      if (LEFTOVER.test(text.toString("utf8"))) {
        throw new RenderError(`${relative(outDir, p)} still contains a {{thoryn.…}} placeholder but is not listed in ${MANIFEST_PATH}`);
      }
    });
    return manifest.files;
  } catch (e) {
    rmSync(outDir, { recursive: true, force: true });
    throw e;
  }
}

function parseArgs(argv) {
  const args = { set: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      if (i + 1 >= argv.length) throw new RenderError(`${a} needs a value`);
      return argv[++i];
    };
    if (a === "--template") args.template = next();
    else if (a === "--out") args.out = next();
    else if (a === "--values") args.values = next();
    else if (a === "--example") args.example = true;
    else if (a === "--set") {
      const kv = next();
      const eq = kv.indexOf("=");
      if (eq < 1) throw new RenderError(`--set expects name=value, got "${kv}"`);
      args.set[kv.slice(0, eq)] = kv.slice(eq + 1);
    } else throw new RenderError(`unknown argument ${a}`);
  }
  if (!args.template || !args.out) throw new RenderError("usage: render.mjs --template <dir> --out <dir> [--values file.json] [--example] [--set name=value]…");
  return args;
}

async function main() {
  try {
    const args = parseArgs(process.argv.slice(2));
    const templateDir = resolve(args.template);
    const manifest = readManifest(templateDir);
    const values = {
      ...(args.example ? exampleValues(manifest) : {}),
      ...(args.values ? JSON.parse(readFileSync(args.values, "utf8")) : {}),
      ...args.set,
    };
    const files = renderTemplate({ templateDir, outDir: resolve(args.out), values });
    console.log(`rendered ${args.template} → ${args.out} (${files.join(", ")})`);
  } catch (e) {
    console.error(`render failed: ${e instanceof RenderError ? e.message : e?.stack ?? e}`);
    process.exit(1);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await main();
