#!/usr/bin/env node
// Resolve the values this application needs to talk to Thoryn — AT RUN TIME, never rendered into the repo.
//
//   OIDC_ISSUER        the issuer of the sandbox environment named in .thoryn/connection.json
//   OIDC_CLIENT_ID     the clientId of the application `thoryn provision apply` converged (from its receipt)
//   THORYN_WORKSPACE   the workspace slug (for the e2e's test-inbox reads)
//   THORYN_ENVIRONMENT the environment slug (idem)
//
// Why at run time: the issuer changes when the workspace activates a custom domain, and the client id is
// whatever the provisioning converged. Keeping both out of the repository means a later custom domain or a
// re-created client needs no commit here.
//
// How the issuer is resolved: compose `https://<workspace>.<platform host>/<environment>` from THORYN_ISSUER
// (the platform base issuer the CLI signs in to), fetch that issuer's discovery document, and use the
// `issuer` it publishes (the platform's own answer, which names the custom domain once one is active).
// NOTE: this is the interim for a `thoryn` command that prints the resolved application settings; replace
// the call with that command once the CLI ships it.
//
// Usage (Node 22+, no dependencies):
//   node .thoryn/app-env.mjs                 # print KEY=value lines
//   node .thoryn/app-env.mjs --write .env    # write them to .env (the one-command local run reads it)
//   node .thoryn/app-env.mjs --github-env    # append them to $GITHUB_ENV (CI)
//   options: --connection <path> --receipt <path> --application <name>

import { appendFileSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

export class AppEnvError extends Error {}

/** The workspace (and, for a sandbox, environment) issuer composed on the platform's host. */
export function composeIssuer(platformIssuer, workspace, environment) {
  let base;
  try {
    base = new URL(platformIssuer);
  } catch {
    throw new AppEnvError(`THORYN_ISSUER is not a URL: ${JSON.stringify(platformIssuer)}`);
  }
  if (base.protocol !== "https:" && !["127.0.0.1", "localhost", "[::1]"].includes(base.hostname)) {
    throw new AppEnvError("THORYN_ISSUER must be https (http is accepted for a loopback platform only)");
  }
  return `${base.protocol}//${workspace}.${base.host}${environment ? `/${environment}` : ""}`;
}

/** Read the clientId of application [name] from a provisioning receipt object. */
export function clientIdFromReceipt(receipt, name) {
  const apps = (receipt?.resources ?? []).filter((r) => r.kind === "application");
  const app = name ? apps.find((r) => r.name === name) : apps[0];
  if (!app?.id) {
    throw new AppEnvError(
      `the provisioning receipt has no application${name ? ` named "${name}"` : ""} — run \`thoryn provision apply --file .thoryn/provision.yaml\` first`,
    );
  }
  return app.id;
}

/**
 * Ask the composed issuer for its discovery document and return the `issuer` it publishes. A path-based
 * sandbox issuer serves its discovery at `<issuer>/.well-known/openid-configuration` (OIDC Discovery §4).
 */
export async function discoverIssuer(composed, fetchImpl = fetch) {
  const url = `${composed}/.well-known/openid-configuration`;
  let resp;
  try {
    resp = await fetchImpl(url, { headers: { Accept: "application/json" }, redirect: "follow" });
  } catch (e) {
    throw new AppEnvError(`could not reach ${url}: ${e?.message ?? e}`);
  }
  if (!resp.ok) throw new AppEnvError(`${url} answered HTTP ${resp.status} — check the workspace and environment in .thoryn/connection.json`);
  const doc = await resp.json().catch(() => null);
  if (typeof doc?.issuer !== "string" || !doc.issuer) throw new AppEnvError(`${url} did not return an issuer`);
  return doc.issuer.replace(/\/+$/, "");
}

export async function resolveAppEnv({ connection, receipt, platformIssuer, application, fetchImpl = fetch }) {
  const workspace = connection?.workspace?.slug;
  if (!workspace) throw new AppEnvError("connection.json has no workspace.slug");
  const environment = connection?.auth?.environment ?? null;
  if (!platformIssuer) {
    throw new AppEnvError("set THORYN_ISSUER to the platform base issuer (e.g. https://auth.stg.thoryn.org), as for `thoryn login`");
  }
  const composed = composeIssuer(platformIssuer, workspace, environment);
  const issuer = await discoverIssuer(composed, fetchImpl);
  return {
    OIDC_ISSUER: issuer,
    OIDC_CLIENT_ID: clientIdFromReceipt(receipt, application),
    THORYN_WORKSPACE: workspace,
    ...(environment ? { THORYN_ENVIRONMENT: environment } : {}),
  };
}

export function toDotenv(vars) {
  return Object.entries(vars).map(([k, v]) => `${k}=${v}`).join("\n") + "\n";
}

async function main(argv) {
  const opt = { connection: join(here, "connection.json"), receipt: join(here, "provision.receipt.json"), application: "web" };
  let mode = "print";
  let writePath;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--write") { mode = "write"; writePath = argv[++i]; }
    else if (a === "--github-env") mode = "github";
    else if (a === "--connection") opt.connection = argv[++i];
    else if (a === "--receipt") opt.receipt = argv[++i];
    else if (a === "--application") opt.application = argv[++i];
    else throw new AppEnvError(`unknown argument ${a}`);
  }
  if (!existsSync(opt.receipt)) throw new AppEnvError(`${opt.receipt} not found — run \`thoryn provision apply --file .thoryn/provision.yaml\` first`);
  const vars = await resolveAppEnv({
    connection: JSON.parse(readFileSync(opt.connection, "utf8")),
    receipt: JSON.parse(readFileSync(opt.receipt, "utf8")),
    platformIssuer: process.env.THORYN_ISSUER ?? process.env.THORYN_HUB,
    application: opt.application,
  });
  const text = toDotenv(vars);
  if (mode === "write") {
    writeFileSync(writePath, text);
    console.log(`wrote ${Object.keys(vars).join(", ")} to ${writePath}`);
  } else if (mode === "github") {
    if (!process.env.GITHUB_ENV) throw new AppEnvError("--github-env needs $GITHUB_ENV (run it inside GitHub Actions)");
    appendFileSync(process.env.GITHUB_ENV, text);
    console.log(`exported ${Object.entries(vars).map(([k, v]) => `${k}=${v}`).join(" ")}`);
  } else {
    process.stdout.write(text);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main(process.argv.slice(2)).catch((e) => {
    console.error(`app-env: ${e instanceof AppEnvError ? e.message : e?.stack ?? e}`);
    process.exit(1);
  });
}
