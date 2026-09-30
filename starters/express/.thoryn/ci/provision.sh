#!/usr/bin/env bash
# Sign in and converge .thoryn/provision.yaml into the sandbox, then export the application's run-time
# settings (OIDC_ISSUER, OIDC_CLIENT_ID, …). Run from the repository root.
#
# The wiring comes from the environment, never from a file in the repository:
#   THORYN_ISSUER         platform base issuer, e.g. https://auth.stg.thoryn.org
#   THORYN_WORKSPACE      the workspace
#   THORYN_ENVIRONMENT    the sandbox the app's client and test user live in
#   THORYN_WIF_CLIENT_ID  the workload identity trust (GitHub Actions only)
# In GitHub Actions these are Actions variables and the job signs in with workload identity (it needs
# `permissions: id-token: write`). Locally, export the first three and sign in yourself first:
# `thoryn login --workspace "$THORYN_WORKSPACE"`.
set -euo pipefail
here="$(dirname "$0")"

"$here/require-vars.sh" THORYN_ISSUER THORYN_WORKSPACE THORYN_ENVIRONMENT

# The client's display name is its converge key in the sandbox: the repository's name, unless set.
if [ -z "${THORYN_APP_NAME:-}" ]; then
  if [ -n "${GITHUB_REPOSITORY:-}" ]; then THORYN_APP_NAME="${GITHUB_REPOSITORY##*/}"; else THORYN_APP_NAME="$(basename "$PWD")"; fi
fi
export THORYN_APP_NAME

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
    echo "THORYN_APP_NAME=$THORYN_APP_NAME"
  } >> "$GITHUB_ENV"
fi

if [ "${GITHUB_ACTIONS:-}" = "true" ]; then
  "$here/login.sh" sandbox
else
  echo "Local run: using your own thoryn session (thoryn login --workspace $THORYN_WORKSPACE)."
fi
thoryn provision plan --file .thoryn/provision.yaml
thoryn provision apply --file .thoryn/provision.yaml --yes

if [ -n "${GITHUB_ENV:-}" ]; then
  node .thoryn/app-env.mjs --github-env
else
  node .thoryn/app-env.mjs --write .env
fi
