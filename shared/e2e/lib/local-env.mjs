// Local runs of the journey (SSO-3445). CI exports every value; on a developer machine the app's settings
// come from the `.env` file .thoryn/ci/provision.sh writes (OIDC_ISSUER, OIDC_CLIENT_ID, THORYN_WORKSPACE,
// THORYN_ENVIRONMENT). The test account is an ephemeral sandbox test identity exported into the shell by
// `thoryn env test-identity create --output env` (SSO-4087): no starter writes it to a file any more, so the
// journey's optional write-back of a reset password (`updateEnvFile`, THORYN_LOCAL_ENV_FILE) has nothing to
// write to and is never armed.
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { parseEnv } from "node:util";

/** Set every variable of [path] that [env] does not already have (an exported value always wins). */
export function fillFromEnvFile(path, env = process.env) {
  if (!existsSync(path)) return [];
  const filled = [];
  for (const [key, value] of Object.entries(parseEnv(readFileSync(path, "utf8")))) {
    if (!env[key]) {
      env[key] = value;
      filled.push(key);
    }
  }
  return filled;
}

/** Replace (or add) KEY=value in [path], keeping it owner-only. Used when the journey resets the password. */
export function updateEnvFile(path, key, value) {
  if (!/^[A-Z_][A-Z0-9_]*$/.test(key) || /[\r\n#"'\s]/.test(value)) throw new Error(`refusing to write ${key}`);
  const lines = readFileSync(path, "utf8").split("\n");
  const at = lines.findIndex((l) => l.startsWith(`${key}=`));
  if (at >= 0) lines[at] = `${key}=${value}`;
  else lines.splice(lines.at(-1) === "" ? lines.length - 1 : lines.length, 0, `${key}=${value}`);
  writeFileSync(path, lines.join("\n"), { mode: 0o600 });
  chmodSync(path, 0o600);
}
