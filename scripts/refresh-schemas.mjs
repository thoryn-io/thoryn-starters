#!/usr/bin/env node
// Refresh the vendored CLI schemas from thoryn-io/thoryn-cli main (see schemas/README.md).
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const base = "https://raw.githubusercontent.com/thoryn-io/thoryn-cli/main/src/main/resources";
for (const [from, to] of [
  ["examples/connection.schema.json", "connection.schema.json"],
  ["provision/provision.schema.json", "provision.schema.json"],
]) {
  const resp = await fetch(`${base}/${from}`);
  if (!resp.ok) throw new Error(`${from}: HTTP ${resp.status}`);
  writeFileSync(join(root, "schemas", to), await resp.text());
  console.log(`refreshed schemas/${to}`);
}
console.log("Update the commit in schemas/README.md.");
