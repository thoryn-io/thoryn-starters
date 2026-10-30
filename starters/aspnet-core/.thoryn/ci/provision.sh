#!/usr/bin/env bash
# Sign in and converge .thoryn/provision.yaml into the sandbox, then export the application's run-time
# settings (OIDC_ISSUER, OIDC_CLIENT_ID, …). Run from the repository root.
#
# The wiring comes from the environment, never from a file in the repository:
#   THORYN_ISSUER         platform base issuer, e.g. https://auth.stg.thoryn.org
#   THORYN_WORKSPACE      the workspace
#   THORYN_ENVIRONMENT    the sandbox the app's client lives in (and where its test identity is minted)
#   THORYN_WIF_CLIENT_ID  the workload identity trust (GitHub Actions only)
#
# In GitHub Actions these are Actions variables and the job signs in with workload identity (it needs
# `permissions: id-token: write`). The account the e2e journey signs in with is an EPHEMERAL SANDBOX TEST
# IDENTITY (oauthy ADR 2026-10-30): minted here, once per run, with `thoryn env test-identity create --output
# github-env`, which masks the password and appends THORYN_TEST_IDENTITY_ID / THORYN_TEST_USER_EMAIL /
# THORYN_TEST_USER_PASSWORD to $GITHUB_ENV for the next steps; teardown.sh revokes it. It is never declared in
# provision.yaml (an application defines no user of the tenant) and never written to a file.
#
# Locally, sign in yourself first (`thoryn login --issuer <platform> --workspace <workspace>`). Whatever is
# not exported comes from that session: the workspace and platform you signed in to, and the sandbox
# `thoryn env use` selected. The app's settings go to .env. The test identity is minted into YOUR SHELL, by you
# (a script cannot export into its parent shell): this script prints the one `eval` line, 24 hours, nothing
# on disk. An exported THORYN_TEST_USER_EMAIL / THORYN_TEST_USER_PASSWORD (a sandbox user of your own) wins.
set -euo pipefail
here="$(dirname "$0")"
in_actions=false
[ "${GITHUB_ACTIONS:-}" = "true" ] && in_actions=true

if ! $in_actions; then
  # Fill what is not exported from the `thoryn login` session (never overrides an exported value).
  while IFS='=' read -r key value; do
    case "$key" in
      THORYN_ISSUER|THORYN_WORKSPACE|THORYN_ENVIRONMENT)
        if [ -z "${!key:-}" ] && [ -n "$value" ]; then export "$key=$value"; fi ;;
    esac
  done < <(node .thoryn/app-env.mjs --wiring 2>/dev/null || true)
fi
"$here/require-vars.sh" THORYN_ISSUER THORYN_WORKSPACE THORYN_ENVIRONMENT
# An application project runs against a sandbox; its client never lives on production, and a test identity can
# only be minted in a sandbox (the API refuses production with not_a_sandbox).
if [ "$THORYN_ENVIRONMENT" = "production" ]; then
  echo "error: THORYN_ENVIRONMENT is 'production'. An application project provisions into a sandbox only; pick one with thoryn env use <sandbox>." >&2
  exit 1
fi

# The client's display name is its converge key in the sandbox. CI uses the repository's name; a local run
# gets its own client (so a CI run's teardown never deletes the one your local app uses).
if [ -z "${THORYN_APP_NAME:-}" ]; then
  if $in_actions && [ -n "${GITHUB_REPOSITORY:-}" ]; then
    THORYN_APP_NAME="${GITHUB_REPOSITORY##*/}"
  else
    THORYN_APP_NAME="$(basename "$PWD")-local-${USER:-dev}"
    THORYN_APP_NAME="$(printf '%s' "$THORYN_APP_NAME" | tr -c 'A-Za-z0-9._-' '-' | cut -c1-63)"
  fi
fi
export THORYN_APP_NAME
if [ -n "${GITHUB_ENV:-}" ]; then
  echo "THORYN_APP_NAME=$THORYN_APP_NAME" >> "$GITHUB_ENV"
fi

if $in_actions; then
  "$here/login.sh" sandbox
else
  echo "Local run: workspace $THORYN_WORKSPACE, sandbox $THORYN_ENVIRONMENT, client '$THORYN_APP_NAME', as your own thoryn session."
fi
thoryn provision plan --file .thoryn/provision.yaml
thoryn provision apply --file .thoryn/provision.yaml --yes

# The test identity (see the header). In Actions: one per run, minted after the apply (no account for a run
# that has no client), labelled with the client's name and the run, so `thoryn env test-identity list` and the
# audit row say which run minted it. The label grammar is 1-64 characters of letters, digits, '.', '_' or '-'.
if $in_actions; then
  label="$(printf '%s' "$THORYN_APP_NAME" | tr -c 'A-Za-z0-9._-' '-' | cut -c1-40)-${GITHUB_RUN_ID:-ci}-${GITHUB_RUN_ATTEMPT:-1}"
  thoryn env test-identity create --env "$THORYN_ENVIRONMENT" --label "$(printf '%s' "$label" | cut -c1-64)" --output github-env
elif [ -n "${THORYN_TEST_USER_EMAIL:-}" ] && [ -n "${THORYN_TEST_USER_PASSWORD:-}" ]; then
  echo "Test user: $THORYN_TEST_USER_EMAIL (exported)"
else
  cat <<MSG
Test user: mint a disposable sandbox test identity into your shell (it lives 24 hours; nothing is written to a file):
  eval "\$(thoryn env test-identity create --env $THORYN_ENVIRONMENT --lifetime PT24H --output env)"
That exports THORYN_TEST_USER_EMAIL and THORYN_TEST_USER_PASSWORD (sign in with them; the e2e journey reads them)
and THORYN_TEST_IDENTITY_ID (erase it early: thoryn env test-identity revoke "\$THORYN_TEST_IDENTITY_ID" --env $THORYN_ENVIRONMENT).
The journey's forgot-password test changes the password, so mint again before you run it a second time.
MSG
fi

if [ -n "${GITHUB_ENV:-}" ]; then
  node .thoryn/app-env.mjs --github-env
else
  node .thoryn/app-env.mjs --write .env
fi
