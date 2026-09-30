#!/usr/bin/env node
// Resolve the values this application needs to talk to Thoryn — AT RUN TIME, never written into the repo.
//
//   OIDC_ISSUER        the issuer of the sandbox environment THORYN_ENVIRONMENT of workspace THORYN_WORKSPACE
//   OIDC_CLIENT_ID     the clientId of the application `thoryn provision apply` converged (from its receipt)
//   THORYN_WORKSPACE   the workspace slug (for the e2e's test-inbox reads)
//   THORYN_ENVIRONMENT the environment slug (idem)
//
// Inputs, all from the environment (GitHub Actions variables in CI; exported locally) or the flags below:
//   THORYN_ISSUER (--issuer), THORYN_WORKSPACE (--workspace), THORYN_ENVIRONMENT (--environment).
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
//   options: --issuer <url> --workspace <slug> --environment <slug> --receipt <path> --application <name>

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
  if (!resp.ok) throw new AppEnvError(`${url} answered HTTP ${resp.status} — check THORYN_WORKSPACE and THORYN_ENVIRONMENT`);
  const doc = await resp.json().catch(() => null);
  if (typeof doc?.issuer !== "string" || !doc.issuer) throw new AppEnvError(`${url} did not return an issuer`);
  return doc.issuer.replace(/\/+$/, "");
}

const SLUG = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

export async function resolveAppEnv({ workspace, environment, receipt, platformIssuer, application, fetchImpl = fetch }) {
  if (!platformIssuer) {
    throw new AppEnvError("set THORYN_ISSUER to the platform base issuer (e.g. https://auth.stg.thoryn.org), as for `thoryn login`");
  }
  if (!workspace) throw new AppEnvError("set THORYN_WORKSPACE to the workspace slug (a GitHub Actions variable in CI)");
  if (!SLUG.test(workspace)) throw new AppEnvError(`THORYN_WORKSPACE ${JSON.stringify(workspace)} is not a workspace slug`);
  if (!environment) throw new AppEnvError("set THORYN_ENVIRONMENT to the sandbox slug (a GitHub Actions variable in CI)");
  if (!SLUG.test(environment)) throw new AppEnvError(`THORYN_ENVIRONMENT ${JSON.stringify(environment)} is not an environment slug`);
  const composed = composeIssuer(platformIssuer, workspace, environment);
  const issuer = await discoverIssuer(composed, fetchImpl);
  return {
    OIDC_ISSUER: issuer,
    OIDC_CLIENT_ID: clientIdFromReceipt(receipt, application),
    THORYN_WORKSPACE: workspace,
    THORYN_ENVIRONMENT: environment,
  };
}

export function toDotenv(vars) {
  return Object.entries(vars).map(([k, v]) => `${k}=${v}`).join("\n") + "\n";
}

async function main(argv) {
  const opt = {
    issuer: process.env.THORYN_ISSUER ?? process.env.THORYN_HUB,
    workspace: process.env.THORYN_WORKSPACE,
    environment: process.env.THORYN_ENVIRONMENT,
    receipt: join(here, "provision.receipt.json"),
    application: "web",
  };
  let mode = "print";
  let writePath;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--write") { mode = "write"; writePath = argv[++i]; }
    else if (a === "--github-env") mode = "github";
    else if (a === "--issuer") opt.issuer = argv[++i];
    else if (a === "--workspace") opt.workspace = argv[++i];
    else if (a === "--environment") opt.environment = argv[++i];
    else if (a === "--receipt") opt.receipt = argv[++i];
    else if (a === "--application") opt.application = argv[++i];
    else throw new AppEnvError(`unknown argument ${a}`);
  }
  if (!existsSync(opt.receipt)) throw new AppEnvError(`${opt.receipt} not found — run \`thoryn provision apply --file .thoryn/provision.yaml\` first`);
  const vars = await resolveAppEnv({
    workspace: opt.workspace,
    environment: opt.environment,
    receipt: JSON.parse(readFileSync(opt.receipt, "utf8")),
    platformIssuer: opt.issuer,
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
