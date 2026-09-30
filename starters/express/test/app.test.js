import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { startFakeIssuer } from "./fake-issuer.js";

const CLIENT_ID = "app-starter-test";
let fake, server, base, fetchApp;

before(async () => {
  fake = await startFakeIssuer({ clientId: CLIENT_ID });
  // Bind first so the app knows its own base URL (it calls its own API from /profile).
  const { default: http } = await import("node:http");
  server = http.createServer();
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
  const config = loadConfig({ OIDC_ISSUER: fake.issuer, OIDC_CLIENT_ID: CLIENT_ID, APP_BASE_URL: base, PORT: "0" });
  server.on("request", createApp(config, { logger: { warn() {}, error() {} } }));
  fetchApp = (path, init = {}) => fetch(`${base}${path}`, { redirect: "manual", ...init });
});

after(async () => {
  await new Promise((r) => server.close(r));
  await fake.close();
});

const cookieOf = (resp) => resp.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");

/** Drive the whole code flow the way a browser would; returns the signed-in session cookie. */
async function signIn() {
  const login = await fetchApp("/login");
  assert.equal(login.status, 302);
  const { code, state } = fake.authorize(login.headers.get("location"));
  const cb = await fetchApp(`/callback?code=${code}&state=${state}`, { headers: { cookie: cookieOf(login) } });
  assert.equal(cb.status, 302, "the callback completes the code exchange");
  assert.equal(cb.headers.get("location"), "/profile");
  return cookieOf(cb);
}

test("GET /login redirects to the issuer's authorize endpoint with PKCE S256, state and nonce", async () => {
  const resp = await fetchApp("/login");
  assert.equal(resp.status, 302);
  const u = new URL(resp.headers.get("location"));
  assert.equal(`${u.origin}${u.pathname}`, `${fake.issuer}/oauth2/authorize`);
  assert.equal(u.searchParams.get("response_type"), "code");
  assert.equal(u.searchParams.get("client_id"), CLIENT_ID);
  assert.equal(u.searchParams.get("redirect_uri"), `${base}/callback`);
  assert.equal(u.searchParams.get("code_challenge_method"), "S256");
  assert.match(u.searchParams.get("code_challenge"), /^[A-Za-z0-9_-]{43}$/);
  assert.ok(u.searchParams.get("state"));
  assert.ok(u.searchParams.get("nonce"));
  const cookie = resp.headers.getSetCookie()[0];
  assert.match(cookie, /HttpOnly/i);
  assert.match(cookie, /SameSite=Lax/i);
});

test("the code flow signs the user in and the profile page shows the protected API result", async () => {
  const cookie = await signIn();
  const profile = await fetchApp("/profile", { headers: { cookie } });
  assert.equal(profile.status, 200);
  const html = await profile.text();
  assert.match(html, /You are signed in as <strong>ada@example.com<\/strong>/);
  assert.match(html, /id="api-result"[^>]*>[^<]*&quot;client_id&quot;: &quot;app-starter-test&quot;/);
});

test("a callback with a foreign state is refused", async () => {
  const login = await fetchApp("/login");
  const { code } = fake.authorize(login.headers.get("location"));
  const cb = await fetchApp(`/callback?code=${code}&state=forged`, { headers: { cookie: cookieOf(login) } });
  assert.equal(cb.status, 400);
});

test("an ID token signed with anything but ES256 is refused at the callback", async () => {
  fake.idTokenAlg = "RS256";
  try {
    const login = await fetchApp("/login");
    const { code, state } = fake.authorize(login.headers.get("location"));
    const cb = await fetchApp(`/callback?code=${code}&state=${state}`, { headers: { cookie: cookieOf(login) } });
    assert.equal(cb.status, 400);
  } finally {
    fake.idTokenAlg = "ES256";
  }
});

test("a callback without a sign-in in progress is refused", async () => {
  const cb = await fetchApp("/callback?code=x&state=y");
  assert.equal(cb.status, 400);
});

test("/profile without a session redirects to /login", async () => {
  const resp = await fetchApp("/profile");
  assert.equal(resp.status, 302);
  assert.equal(resp.headers.get("location"), "/login");
});

test("POST /logout ends the session and redirects to the end-session endpoint with id_token_hint", async () => {
  const cookie = await signIn();
  const resp = await fetchApp("/logout", { method: "POST", headers: { cookie, origin: base } });
  assert.equal(resp.status, 303);
  const u = new URL(resp.headers.get("location"));
  assert.equal(`${u.origin}${u.pathname}`, `${fake.issuer}/connect/logout`);
  assert.ok(u.searchParams.get("id_token_hint"));
  assert.equal(u.searchParams.get("post_logout_redirect_uri"), `${base}/signed-out`);
  const after = await fetchApp("/profile", { headers: { cookie } });
  assert.equal(after.status, 302, "the old session cookie no longer signs in");
});

test("POST /logout from a foreign origin is refused", async () => {
  const cookie = await signIn();
  const resp = await fetchApp("/logout", { method: "POST", headers: { cookie, origin: "https://evil.example" } });
  assert.equal(resp.status, 403);
});

test("GET /api/me accepts a valid ES256 at+jwt access token issued to this client", async () => {
  const resp = await fetchApp("/api/me", { headers: { authorization: `Bearer ${await fake.accessToken()}` } });
  assert.equal(resp.status, 200);
  const body = await resp.json();
  assert.equal(body.sub, "user-1");
  assert.equal(body.client_id, CLIENT_ID);
});

const refused = {
  "no Authorization header": async () => null,
  "an RS256 token (algorithm not pinned)": () => fake.accessToken({ alg: "RS256" }),
  "an ID token (typ JWT, not at+jwt)": () => fake.accessToken({ typ: "JWT" }),
  "another issuer": () => fake.accessToken({ iss: "https://evil.example" }),
  "another audience": () => fake.accessToken({ aud: ["https://other.example"] }),
  "an expired token": () => fake.accessToken({ exp: Math.floor(Date.now() / 1000) - 120 }),
  "a token issued to another client": () => fake.accessToken({ claims: { client_id: "someone-else" } }),
  "a garbage token": async () => "not.a.jwt",
};

for (const [name, token] of Object.entries(refused)) {
  test(`GET /api/me refuses ${name} with 401 and a Bearer challenge`, async () => {
    const t = await token();
    const resp = await fetchApp("/api/me", { headers: t ? { authorization: `Bearer ${t}` } : {} });
    assert.equal(resp.status, 401);
    assert.match(resp.headers.get("www-authenticate") ?? "", /^Bearer /);
  });
}

test("GET /health answers ok", async () => {
  const resp = await fetchApp("/health");
  assert.equal(resp.status, 200);
});

/** A raw request with a chosen Host header (fetch does not let a caller set Host). */
async function withHost(host, path, method = "GET") {
  const { default: http } = await import("node:http");
  const u = new URL(base);
  return new Promise((resolve, reject) => {
    const req = http.request({ host: u.hostname, port: u.port, path, method, headers: { host } }, (res) => {
      res.resume();
      res.on("end", () => resolve({ status: res.statusCode, location: res.headers.location }));
    });
    req.on("error", reject);
    req.end();
  });
}

test("a GET on another loopback host is redirected to the same path and query on the base URL", async () => {
  const port = new URL(base).port;
  const r = await withHost(`localhost:${port}`, "/profile?tab=api");
  assert.equal(r.status, 302);
  assert.equal(r.location, `${base}/profile?tab=api`);
  // The path cannot move the redirect off the base URL's origin.
  const odd = await withHost(`localhost:${port}`, "//evil.example/x");
  assert.equal(new URL(odd.location).origin, base);
  // Another port on the same name is another host, too.
  assert.equal((await withHost("127.0.0.1:1", "/")).location, `${base}/`);
});

test("the canonical-host redirect never echoes the Host header, refuses other methods, and leaves the base host alone", async () => {
  const port = new URL(base).port;
  assert.equal((await withHost(`[::1]:${port}`, "/login")).location, `${base}/login`);
  assert.equal((await withHost(`localhost:${port}`, "/logout", "POST")).status, 400);
  assert.equal((await withHost(`127.0.0.1:${port}`, "/health")).status, 200);
  // A non-loopback Host (a proxy, a deployment) is not redirected.
  assert.equal((await withHost("app.example.com", "/health")).status, 200);
});
