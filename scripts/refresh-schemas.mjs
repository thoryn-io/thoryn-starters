#!/usr/bin/env node
// Refresh the vendored CLI schemas from thoryn-io/thoryn-cli (see schemas/README.md).
//   npm run schemas:refresh -- cli-v0.49.0     # a release tag (preferred: the schema the released CLI enforces)
//   npm run schemas:refresh                    # main
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const ref = process.argv[2] ?? "main";
// The provisioning schema moved into the engine module (thoryn-cli SSO-3962 era): engine/src/main/resources.
const base = `https://raw.githubusercontent.com/thoryn-io/thoryn-cli/${ref}/engine/src/main/resources`;
for (const [from, to] of [
  ["provision/provision.schema.json", "provision.schema.json"],
]) {
  const resp = await fetch(`${base}/${from}`);
  if (!resp.ok) throw new Error(`${from}: HTTP ${resp.status}`);
  writeFileSync(join(root, "schemas", to), await resp.text());
  console.log(`refreshed schemas/${to}`);
}
console.log(`Update the source (${ref}) in schemas/README.md.`);
