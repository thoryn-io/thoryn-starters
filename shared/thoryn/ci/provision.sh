#!/usr/bin/env bash
# Sign in and converge .thoryn/provision.yaml into the sandbox, then export the application's run-time
# settings (OIDC_ISSUER, OIDC_CLIENT_ID, …). Run from the repository root.
#
# The wiring comes from the environment, never from a file in the repository:
#   THORYN_ISSUER         platform base issuer, e.g. https://auth.stg.thoryn.org
#   THORYN_WORKSPACE      the workspace
#   THORYN_ENVIRONMENT    the sandbox the app's client and test user live in
#   THORYN_WIF_CLIENT_ID  the workload identity trust (GitHub Actions only)
#
# In GitHub Actions these are Actions variables and the job signs in with workload identity (it needs
# `permissions: id-token: write`); a fresh test user is created per run and teardown.sh deletes it.
#
# Locally, sign in yourself first (`thoryn login --issuer <platform> --workspace <workspace>`). Whatever is
# not exported comes from that session: the workspace and platform you signed in to, and the sandbox
# `thoryn env use` selected. The sandbox test user is THORYN_TEST_USER_EMAIL / THORYN_TEST_USER_PASSWORD when
# exported, else the one in .thoryn/local.env (generated on the first local run, then reused). The app's
# settings go to .env.
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
# An application project runs against a sandbox; its client and test user never live on production.
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

# The test user: provision.yaml reads both values from the environment at apply time
# (`{{env.THORYN_TEST_USER_EMAIL}}`, `passwordEnv: THORYN_TEST_USER_PASSWORD`).
if $in_actions; then
  # A fresh one per run; teardown.sh deletes it.
  if [ -z "${THORYN_TEST_USER_EMAIL:-}" ]; then
    THORYN_TEST_USER_EMAIL="e2e-${GITHUB_RUN_ID:-ci}-${GITHUB_RUN_ATTEMPT:-1}-$(openssl rand -hex 3)@example.com"
  fi
  if [ -z "${THORYN_TEST_USER_PASSWORD:-}" ]; then
    THORYN_TEST_USER_PASSWORD="Pw1!$(openssl rand -hex 16)"
  fi
  echo "::add-mask::$THORYN_TEST_USER_PASSWORD"
else
  # Locally: an exported value wins; otherwise .thoryn/local.env (written on the first local run, reused
  # after that, gitignored, owner-only); otherwise generate one now and write it there. The password comes
  # from a CSPRNG (openssl rand) and meets the sandbox password policy; it is never printed.
  local_env=".thoryn/local.env"
  if [ -f "$local_env" ]; then
    while IFS='=' read -r key value; do
      case "$key" in
        THORYN_TEST_USER_EMAIL|THORYN_TEST_USER_PASSWORD)
          if [ -z "${!key:-}" ] && [ -n "$value" ]; then printf -v "$key" '%s' "$value"; fi ;;
      esac
    done < "$local_env"
  fi
  if [ -z "${THORYN_TEST_USER_EMAIL:-}" ] || [ -z "${THORYN_TEST_USER_PASSWORD:-}" ]; then
    user="$(printf '%s' "${USER:-dev}" | tr -c 'A-Za-z0-9' '-' | tr '[:upper:]' '[:lower:]' | cut -c1-20)"
    : "${THORYN_TEST_USER_EMAIL:=dev-${user}-$(openssl rand -hex 3)@example.com}"
    : "${THORYN_TEST_USER_PASSWORD:=Pw1!$(openssl rand -hex 16)}"
    (
      umask 077
      {
        echo "# The local sandbox test user (.thoryn/ci/provision.sh). Owner-only and gitignored: never commit it."
        echo "THORYN_TEST_USER_EMAIL=$THORYN_TEST_USER_EMAIL"
        echo "THORYN_TEST_USER_PASSWORD=$THORYN_TEST_USER_PASSWORD"
      } > "$local_env"
    )
    chmod 600 "$local_env"
  fi
  echo "Test user: $THORYN_TEST_USER_EMAIL (its password is in $local_env)"
fi
export THORYN_TEST_USER_EMAIL THORYN_TEST_USER_PASSWORD
if [ -n "${GITHUB_ENV:-}" ]; then
  {
    echo "THORYN_TEST_USER_EMAIL=$THORYN_TEST_USER_EMAIL"
    echo "THORYN_TEST_USER_PASSWORD=$THORYN_TEST_USER_PASSWORD"
    echo "THORYN_APP_NAME=$THORYN_APP_NAME"
  } >> "$GITHUB_ENV"
fi

if $in_actions; then
  "$here/login.sh" sandbox
else
  echo "Local run: workspace $THORYN_WORKSPACE, sandbox $THORYN_ENVIRONMENT, client '$THORYN_APP_NAME', as your own thoryn session."
fi
thoryn provision plan --file .thoryn/provision.yaml
thoryn provision apply --file .thoryn/provision.yaml --yes

if [ -n "${GITHUB_ENV:-}" ]; then
  node .thoryn/app-env.mjs --github-env
else
  node .thoryn/app-env.mjs --write .env
fi
