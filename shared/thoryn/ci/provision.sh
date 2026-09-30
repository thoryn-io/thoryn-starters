#!/usr/bin/env bash
# Sign in with workload identity (no secret) and converge .thoryn/provision.yaml into the sandbox, then
# export the application's run-time settings (OIDC_ISSUER, OIDC_CLIENT_ID, …) to the job.
# Run from the repository root, inside a job with `permissions: id-token: write`.
#   THORYN_ISSUER   platform base issuer (repository variable), e.g. https://auth.stg.thoryn.org
set -euo pipefail

: "${THORYN_ISSUER:?set the THORYN_ISSUER repository variable to the platform base issuer, e.g. https://auth.stg.thoryn.org}"

# A fresh test user for this run: provision.yaml reads both values from the environment at apply time
# (`{{env.THORYN_TEST_USER_EMAIL}}`, `passwordEnv: THORYN_TEST_USER_PASSWORD`). teardown.sh deletes it.
if [ -z "${THORYN_TEST_USER_EMAIL:-}" ]; then
  THORYN_TEST_USER_EMAIL="e2e-${GITHUB_RUN_ID:-local}-${GITHUB_RUN_ATTEMPT:-1}-$(openssl rand -hex 3)@example.com"
fi
if [ -z "${THORYN_TEST_USER_PASSWORD:-}" ]; then
  THORYN_TEST_USER_PASSWORD="Pw1!$(openssl rand -hex 16)"
fi
echo "::add-mask::$THORYN_TEST_USER_PASSWORD"
export THORYN_TEST_USER_EMAIL THORYN_TEST_USER_PASSWORD
if [ -n "${GITHUB_ENV:-}" ]; then
  {
    echo "THORYN_TEST_USER_EMAIL=$THORYN_TEST_USER_EMAIL"
    echo "THORYN_TEST_USER_PASSWORD=$THORYN_TEST_USER_PASSWORD"
  } >> "$GITHUB_ENV"
fi

thoryn login --connection .thoryn/connection.json
thoryn provision plan --file .thoryn/provision.yaml
thoryn provision apply --file .thoryn/provision.yaml --yes

if [ -n "${GITHUB_ENV:-}" ]; then
  node .thoryn/app-env.mjs --github-env
else
  node .thoryn/app-env.mjs --write .env
fi
