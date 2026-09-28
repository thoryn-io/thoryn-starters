import { test } from "node:test";
import assert from "node:assert/strict";
import { emailsOf, extractResetLink } from "./test-inbox.mjs";

test("emailsOf accepts both list shapes", () => {
  assert.deepEqual(emailsOf([{ id: 1 }]), [{ id: 1 }]);
  assert.deepEqual(emailsOf({ emails: [{ id: 2 }] }), [{ id: 2 }]);
  assert.deepEqual(emailsOf(null), []);
});

test("extractResetLink finds the reset URL in an HTML body", () => {
  const body = '<p>Reset: <a href="https://acme.auth.thoryn.io/id/password-reset?token=abc_DEF-123">here</a></p>';
  assert.equal(extractResetLink(body), "https://acme.auth.thoryn.io/id/password-reset?token=abc_DEF-123");
});

test("extractResetLink ignores other links", () => {
  assert.equal(extractResetLink("https://acme.auth.thoryn.io/id/verify-email?token=x"), null);
});
