import { defineConfig, devices } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { fillFromEnvFile } from "./lib/local-env.mjs";

// A local run (not CI) reads the app's settings .thoryn/ci/provision.sh wrote to ../.env. The test account is
// never in a file: `eval "$(thoryn env test-identity create --lifetime PT24H --output env)"` exports
// THORYN_TEST_USER_EMAIL / THORYN_TEST_USER_PASSWORD into your shell (an ephemeral sandbox test identity,
// oauthy ADR 2026-10-30; see the README). An exported value always wins.
if (!process.env.CI) fillFromEnvFile(fileURLToPath(new URL("../.env", import.meta.url)));

// The journey signs a real test user in to the running app against the real sandbox, so it is slow-ish
// and must never run its tests in parallel (one of them changes the test user's password).
export default defineConfig({
  testDir: "./tests",
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  timeout: 120_000,
  expect: { timeout: 20_000 },
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: process.env.APP_BASE_URL ?? "http://127.0.0.1:8080",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
