import { defineConfig, devices } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { fillFromEnvFile } from "./lib/local-env.mjs";

// A local run (not CI) reads what .thoryn/ci/provision.sh wrote: the app's settings from ../.env and the
// generated sandbox test user from ../.thoryn/local.env. An exported value always wins.
if (!process.env.CI) {
  fillFromEnvFile(fileURLToPath(new URL("../.env", import.meta.url)));
  const localEnv = fileURLToPath(new URL("../.thoryn/local.env", import.meta.url));
  if (fillFromEnvFile(localEnv).includes("THORYN_TEST_USER_PASSWORD")) process.env.THORYN_LOCAL_ENV_FILE = localEnv;
}

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
