import { test } from "node:test";
import assert from "node:assert/strict";
import { canonicalLocalHost } from "../src/canonical-host.js";

function run(mw, { host, method = "GET", url = "/x?y=1" }) {
  const out = { next: false };
  const res = {
    status(c) { out.status = c; return this; },
    type() { return this; },
    send(b) { out.body = b; return this; },
    redirect(c, l) { out.status = c; out.location = l; },
  };
  mw({ headers: { host }, method, originalUrl: url }, res, () => { out.next = true; });
  return out;
}

test("a deployed (non-loopback) base URL never redirects, whatever the Host header says", () => {
  const mw = canonicalLocalHost("https://app.example.com");
  assert.equal(run(mw, { host: "localhost:8080" }).next, true);
  assert.equal(run(mw, { host: "internal-svc:8080" }).next, true);
});

test("a loopback base URL redirects another loopback host and passes anything else through", () => {
  const mw = canonicalLocalHost("http://127.0.0.1:8080");
  assert.deepEqual(run(mw, { host: "localhost:8080" }), { next: false, status: 302, location: "http://127.0.0.1:8080/x?y=1" });
  assert.equal(run(mw, { host: "127.0.0.1:8080" }).next, true);
  assert.equal(run(mw, { host: "evil.example" }).next, true, "not loopback: not ours to canonicalise");
  assert.equal(run(mw, { host: undefined }).next, true);
  assert.equal(run(mw, { host: "localhost:8080", method: "POST" }).status, 400);
});
