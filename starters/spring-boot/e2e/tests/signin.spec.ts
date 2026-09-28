/**
 * The starter's end-to-end journey, in a real browser, against the real sandbox this repository
 * provisions (`.thoryn/provision.yaml`, converged by CI with workload identity).
 *
 * Every stack implements the same small contract, so this one spec runs against all of them:
 *   GET  /            public; a "Sign in with Thoryn" link when signed out
 *   GET  /login       starts authorization code + PKCE (S256), with state and nonce
 *   GET  /profile     signed-in page: "You are signed in as <email>" and the result of calling the
 *                     app's own protected API with the session's access token (#api-result)
 *   POST /logout      RP-initiated sign-out ("Sign out" button)
 *   GET  /api/me      the protected API: Bearer access token only (ES256, typ at+jwt, iss, aud, client_id)
 *   GET  /health      liveness
 *
 * Environment (CI exports all of it; see .thoryn/ci/provision.sh and .thoryn/app-env.mjs):
 *   APP_BASE_URL                 the running app (default http://127.0.0.1:8080)
 *   OIDC_ISSUER, OIDC_CLIENT_ID  resolved at run time from the provisioning
 *   THORYN_ENVIRONMENT           the sandbox slug (its test inbox is read with the CLI)
 *   THORYN_TEST_USER_EMAIL / THORYN_TEST_USER_PASSWORD   the per-run test user provision.yaml declares
 *   THORYN_BIN                   the thoryn CLI (default: `thoryn` on PATH)
 */
import { test, expect, type Page } from "@playwright/test";
import { findResetLink } from "../lib/test-inbox.mjs";

const env = (name: string): string => {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set — run the journey through the CI steps (or export it)`);
  return v;
};

const issuer = () => env("OIDC_ISSUER");
const clientId = () => env("OIDC_CLIENT_ID");
const email = () => env("THORYN_TEST_USER_EMAIL");
const cli = () => ({ bin: process.env.THORYN_BIN ?? "thoryn", envSlug: env("THORYN_ENVIRONMENT") });

/** The password changes in the reset test; later steps use the current one. */
let currentPassword = "";

test.describe.configure({ mode: "serial" });

async function signInFromLanding(page: Page, password: string): Promise<void> {
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await page.getByRole("link", { name: /sign in with thoryn/i }).click();
  await expect(page.locator("#passwordForm"), "the app hands off to the sandbox's hosted sign-in").toBeVisible({ timeout: 30_000 });
  await page.locator("#passwordEmail").fill(email());
  await page.locator("#password").fill(password);
  await page.locator("#passwordForm button[type=submit]").click();
}

test.beforeAll(async ({ playwright }) => {
  currentPassword = env("THORYN_TEST_USER_PASSWORD");
  // A sandbox's issuer can lag its creation by a few seconds; the app is useless until discovery serves.
  const request = await playwright.request.newContext();
  try {
    await expect
      .poll(async () => (await request.get(`${issuer()}/.well-known/openid-configuration`)).status(), {
        message: "the sandbox issuer serves its discovery document",
        timeout: 90_000,
      })
      .toBe(200);
  } finally {
    await request.dispose();
  }
});

test("sign in with authorization code + PKCE, call the protected API, sign out", async ({ page, request }) => {
  await test.step("GET /login redirects to the sandbox's authorize endpoint with PKCE S256, state and nonce", async () => {
    const resp = await request.get("/login", { maxRedirects: 0 });
    expect(resp.status()).toBe(302);
    const location = new URL(resp.headers()["location"] ?? "");
    const authorize = new URL(`${issuer()}/oauth2/authorize`);
    expect(`${location.origin}${location.pathname}`).toBe(`${authorize.origin}${authorize.pathname}`);
    expect(location.searchParams.get("response_type")).toBe("code");
    expect(location.searchParams.get("client_id")).toBe(clientId());
    expect(location.searchParams.get("code_challenge_method")).toBe("S256");
    expect(location.searchParams.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(location.searchParams.get("state")).toBeTruthy();
    expect(location.searchParams.get("nonce")).toBeTruthy();
    expect(location.searchParams.get("scope")?.split(" ")).toContain("openid");
  });

  await test.step("the provisioned test user signs in and lands on the protected page", async () => {
    await signInFromLanding(page, currentPassword);
    await expect(page.getByText(/you are signed in as/i)).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText(email(), { exact: false }).first()).toBeVisible();
  });

  await test.step("the page's server-side call to GET /api/me is accepted with the session's access token", async () => {
    const result = page.locator("#api-result");
    await expect(result).toContainText('"client_id"');
    await expect(result).toContainText(clientId());
    await expect(result).toContainText('"sub"');
  });

  await test.step("Sign out ends the session through the sandbox (RP-initiated logout) and returns home", async () => {
    await page.getByRole("button", { name: /sign out/i }).click();
    await expect(page.getByRole("link", { name: /sign in with thoryn/i })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText(/you are signed in as/i)).toHaveCount(0);
    expect(new URL(page.url()).origin).toBe(new URL(test.info().project.use.baseURL!).origin);
  });
});

test("forgot password: the reset email is read from the sandbox test inbox, then the new password signs in", async ({ browser }) => {
  // A fresh, session-less context: an authenticated hosted session would skip the sign-in form.
  const context = await browser.newContext({ baseURL: test.info().project.use.baseURL });
  const page = await context.newPage();
  const newPassword = `Pw2!${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  try {
    await test.step("request a reset link from the hosted sign-in page", async () => {
      await page.goto("/", { waitUntil: "domcontentloaded" });
      await page.getByRole("link", { name: /sign in with thoryn/i }).click();
      await expect(page.locator("#passwordForm")).toBeVisible({ timeout: 30_000 });
      await page.locator("#forgotPasswordLink").click();
      await page.locator("input[name=email]").fill(email());
      await page.locator("button[type=submit]").click();
      await expect(page.getByText(/you will receive a password reset link/i)).toBeVisible();
    });

    let link: string | null = null;
    await test.step("the reset email is captured in the sandbox test inbox (thoryn env test-emails)", async () => {
      await expect
        .poll(async () => (link = await findResetLink(cli(), email())), {
          message: `a password_reset email to ${email()} in the test inbox of ${cli().envSlug}`,
          timeout: 90_000,
          intervals: [1_000, 2_000, 3_000, 5_000],
        })
        .not.toBeNull();
    });

    await test.step("follow the link and set a new password", async () => {
      await page.goto(link!, { waitUntil: "domcontentloaded" });
      await page.locator("input[name=newPassword]").fill(newPassword);
      await page.locator("input[name=confirmPassword]").fill(newPassword);
      await page.locator("button[type=submit]").click();
      await expect(page.getByText(/your password has been updated/i)).toBeVisible();
      currentPassword = newPassword;
    });

    await test.step("the new password signs in to the app", async () => {
      await signInFromLanding(page, currentPassword);
      await expect(page.getByText(/you are signed in as/i)).toBeVisible({ timeout: 30_000 });
    });
  } finally {
    await context.close();
  }
});

test("error paths: the API refuses a missing or forged token, the profile needs a session", async ({ request }) => {
  const none = await request.get("/api/me");
  expect(none.status()).toBe(401);
  expect(none.headers()["www-authenticate"] ?? "").toMatch(/^Bearer/i);

  // Shaped like a JWT, signed by nobody: must fail signature / algorithm checks, never 500.
  const forged = [
    Buffer.from(JSON.stringify({ alg: "HS256", typ: "at+jwt" })).toString("base64url"),
    Buffer.from(JSON.stringify({ iss: issuer(), aud: issuer(), sub: "x", client_id: clientId(), exp: 4102444800 })).toString("base64url"),
    "c2lnbmF0dXJl",
  ].join(".");
  const bad = await request.get("/api/me", { headers: { Authorization: `Bearer ${forged}` } });
  expect(bad.status()).toBe(401);

  const profile = await request.get("/profile", { maxRedirects: 0 });
  expect([302, 303]).toContain(profile.status());
});
