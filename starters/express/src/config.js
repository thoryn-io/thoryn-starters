// Everything the app needs comes from the environment. Locally, `npm start` also reads .env (written by
// `node .thoryn/app-env.mjs --write .env`); in CI the workflow exports the same names.
import { randomBytes } from "node:crypto";

export class ConfigError extends Error {}

export function loadConfig(env = process.env) {
  const required = (name) => {
    const v = env[name]?.trim();
    if (!v) {
      throw new ConfigError(
        `${name} is not set. Provision the sandbox and write .env first:\n` +
          "  thoryn provision apply --file .thoryn/provision.yaml && node .thoryn/app-env.mjs --write .env",
      );
    }
    return v;
  };
  const issuer = required("OIDC_ISSUER").replace(/\/+$/, "");
  const port = Number(env.PORT ?? 8080);
  const host = env.HOST ?? "127.0.0.1";
  const baseUrl = (env.APP_BASE_URL ?? `http://127.0.0.1:${port}`).replace(/\/+$/, "");
  return {
    issuer,
    clientId: required("OIDC_CLIENT_ID"),
    // The hub lists its issuer in every access token's `aud` (RFC 9068 §2.2). Override when your API is
    // registered as its own resource.
    audience: env.OIDC_AUDIENCE?.trim() || issuer,
    scope: env.OIDC_SCOPE?.trim() || "openid profile email",
    port,
    host,
    baseUrl,
    // Secure cookies whenever the app is served over https; plain http is only for loopback development.
    cookieSecure: env.COOKIE_SECURE ? env.COOKIE_SECURE === "true" : baseUrl.startsWith("https://"),
    // Sessions live in memory, so a per-process random secret is enough. Set SESSION_SECRET when you move
    // sessions to a shared store behind several instances.
    sessionSecret: env.SESSION_SECRET || randomBytes(32).toString("hex"),
  };
}
