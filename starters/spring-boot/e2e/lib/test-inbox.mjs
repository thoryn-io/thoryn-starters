// Read an email the sandbox captured, through the product's own read surface (`thoryn env test-emails`).
//
// A sandbox never sends transactional email; it captures it into the environment's test inbox instead.
// Reading it back through the CLI is a genuine capture of the real email, not a fake. The CLI is the same
// binary CI signed in with (workload identity, scope tenant:environments.read). Mirrors
// thoryn-io/thoryn-examples e2e/lib/test-inbox.mjs.

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

/** Run the CLI with JSON output; null on any failure so callers can poll. */
export async function runCliJson(bin, args) {
  try {
    const { stdout } = await execFileP(bin, [...args, "--output", "json"], { timeout: 30_000, maxBuffer: 16 * 1024 * 1024 });
    return JSON.parse(stdout);
  } catch {
    return null;
  }
}

/** `list` answers an array or `{ emails: [...] }`. */
export function emailsOf(listJson) {
  if (Array.isArray(listJson)) return listJson;
  if (listJson && Array.isArray(listJson.emails)) return listJson.emails;
  return [];
}

/** The first `<base>/password-reset?token=…` URL in a text, or null. */
export function extractResetLink(text) {
  const m = String(text ?? "").match(/https?:\/\/[^\s"'<>]+\/password-reset\?token=[A-Za-z0-9_.~-]+/);
  return m ? m[0] : null;
}

const isResetLink = (s) => typeof s === "string" && /\/password-reset\?token=/.test(s);

/**
 * The newest password-reset link captured for [recipient] in sandbox [envSlug], or null if none yet.
 * Wrap it in `expect.poll`.
 */
export async function findResetLink({ bin, envSlug }, recipient) {
  if (!envSlug) throw new Error("THORYN_ENVIRONMENT is not set — the journey reads the sandbox's test inbox");
  const list = await runCliJson(bin, [
    "env", "test-emails", "list", "--env", envSlug, "--to", recipient, "--channel", "password_reset", "--limit", "20",
  ]);
  const newest = emailsOf(list)[0];
  if (!newest) return null;
  if (isResetLink(newest.actionLink)) return newest.actionLink;
  if (!newest.id) return null;
  const one = await runCliJson(bin, ["env", "test-emails", "get", String(newest.id), "--env", envSlug]);
  if (isResetLink(one?.actionLink)) return one.actionLink;
  return extractResetLink(`${one?.bodyHtml ?? ""}\n${one?.body ?? ""}`);
}
