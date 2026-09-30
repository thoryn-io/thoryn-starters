import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fillFromEnvFile, updateEnvFile } from "./local-env.mjs";

const file = (text) => {
  const p = join(mkdtempSync(join(tmpdir(), "local-env-")), "local.env");
  writeFileSync(p, text, { mode: 0o600 });
  return p;
};

test("fillFromEnvFile fills only what is not exported, and ignores a missing file", () => {
  const p = file("# local\nTHORYN_TEST_USER_EMAIL=dev@example.com\nTHORYN_TEST_USER_PASSWORD=Pw1!abc\n");
  const env = { THORYN_TEST_USER_EMAIL: "exported@example.com" };
  assert.deepEqual(fillFromEnvFile(p, env), ["THORYN_TEST_USER_PASSWORD"]);
  assert.deepEqual(env, { THORYN_TEST_USER_EMAIL: "exported@example.com", THORYN_TEST_USER_PASSWORD: "Pw1!abc" });
  assert.deepEqual(fillFromEnvFile(join(tmpdir(), "no-such-file.env"), env), []);
});

test("updateEnvFile replaces the value in place and keeps the file owner-only", () => {
  const p = file("# local\nTHORYN_TEST_USER_EMAIL=dev@example.com\nTHORYN_TEST_USER_PASSWORD=old\n");
  updateEnvFile(p, "THORYN_TEST_USER_PASSWORD", "Pw2!new-1");
  assert.equal(readFileSync(p, "utf8"), "# local\nTHORYN_TEST_USER_EMAIL=dev@example.com\nTHORYN_TEST_USER_PASSWORD=Pw2!new-1\n");
  assert.equal(statSync(p).mode & 0o777, 0o600);
  assert.throws(() => updateEnvFile(p, "THORYN_TEST_USER_PASSWORD", "a\nEVIL=1"), /refusing/);
});
