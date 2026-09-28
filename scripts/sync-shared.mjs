#!/usr/bin/env node
// The application starters share their e2e journey, the CI scripts, app-env.mjs, the template manifest and
// their .thoryn/ connection and provisioning templates.
// `shared/` is the single source; this script copies it into every application starter. The published
// templates must be self-contained, so the copies are committed — and `--check` (CI) fails on any drift.
//
//   node scripts/sync-shared.mjs          # copy shared/ into every application starter
//   node scripts/sync-shared.mjs --check  # exit 1 if a starter's copy differs from shared/

import { existsSync, readFileSync, readdirSync, statSync, mkdirSync, copyFileSync, chmodSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
export const APPLICATION_STARTERS = ["express", "spring-boot", "aspnet-core"];

/** [from (under shared/), to (under the starter)] directory or file pairs. */
const MAPPINGS = [
  ["e2e/package.json", "e2e/package.json"],
  ["e2e/package-lock.json", "e2e/package-lock.json"],
  ["e2e/playwright.config.ts", "e2e/playwright.config.ts"],
  ["e2e/tsconfig.json", "e2e/tsconfig.json"],
  ["e2e/tests", "e2e/tests"],
  ["e2e/lib", "e2e/lib"],
  ["thoryn/app-env.mjs", ".thoryn/app-env.mjs"],
  ["thoryn/template.json", ".thoryn/template.json"],
  ["thoryn/connection.json", ".thoryn/connection.json"],
  ["thoryn/provision.yaml", ".thoryn/provision.yaml"],
  ["thoryn/ci", ".thoryn/ci"],
];

function files(path) {
  if (statSync(path).isFile()) return [""];
  const out = [];
  for (const name of readdirSync(path)) {
    if (name === "node_modules") continue;
    for (const f of files(join(path, name))) out.push(f ? join(name, f) : name);
  }
  return out;
}

/** The config starter shares only the CLI installer. */
const CONFIG_MAPPINGS = [["thoryn/ci/install-cli.sh", ".thoryn/ci/install-cli.sh"]];

export function plan() {
  const pairs = [];
  const targets = [...APPLICATION_STARTERS.map((s) => [s, MAPPINGS]), ["config", CONFIG_MAPPINGS]];
  for (const [starter, mappings] of targets) {
    const dir = join(root, "starters", starter);
    if (!existsSync(dir)) continue;
    for (const [from, to] of mappings) {
      const src = join(root, "shared", from);
      for (const f of files(src)) pairs.push([f ? join(src, f) : src, f ? join(dir, to, f) : join(dir, to)]);
    }
  }
  return pairs;
}

const check = process.argv.includes("--check");
const drift = [];
for (const [src, dst] of plan()) {
  const same = existsSync(dst) && readFileSync(src).equals(readFileSync(dst));
  if (same) continue;
  if (check) {
    drift.push(relative(root, dst));
  } else {
    mkdirSync(dirname(dst), { recursive: true });
    copyFileSync(src, dst);
    if (statSync(src).mode & 0o111) chmodSync(dst, 0o755);
    console.log(`synced ${relative(root, dst)}`);
  }
}
if (check && drift.length) {
  console.error(`These starter files differ from shared/ (run \`node scripts/sync-shared.mjs\` and commit):\n  ${drift.join("\n  ")}`);
  process.exit(1);
}
if (check) console.log("shared files are in sync");
