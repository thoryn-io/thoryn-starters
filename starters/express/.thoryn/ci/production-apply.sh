#!/usr/bin/env bash
# Sign in as this repository's PRODUCTION identity and converge .thoryn/production/provision.yaml (the application's
# production OAuth client) on the workspace's production plane. Run by deploy.yml's job `deploy-production` only:
# on `main`, in the reviewed GitHub environment `production`, with `permissions: id-token: write` (SSO-4120).
#
# The wiring comes from the environment, never from a file in the repository:
#   THORYN_ISSUER                     repository variable: the platform base issuer
#   THORYN_WORKSPACE                  repository variable: the workspace
#   THORYN_PRODUCTION_WIF_CLIENT_ID   variable of the GitHub environment `production`: the production trust
#   THORYN_PRODUCTION_URL             variable of the GitHub environment `production`: the deployed https base URL
# What each one is and where it is set: .thoryn/production/declaration.json.
#
# The first run plans the client's creation and is refused: creating on the production plane needs a CREATION SLOT for
# exactly this clientId (oauthy ADR 2026-10-17). The CLI names it (`thoryn access reserve client:<wi_…>
# application:<repository>-production --environment production`) in the log and writes the fix request to
# THORYN_FIX_REQUEST, which deploy.yml uploads as the artifact `thoryn-provision-request`. A workspace admin runs that
# command once; the next run creates the client and this repository owns it from then on.
#
# The apply's `--output json` result is the run's only record of the client id (the CLI keeps no receipt, thoryn-cli
# SSO-3715). It is saved OUTSIDE the committed tree, at THORYN_PRODUCTION_APPLY_RESULT
# ($RUNNER_TEMP/thoryn-production-apply.json, exported to the next steps), where `app-env.mjs --production` reads it.
# Nothing is ever destroyed: the production client outlives every run.
set -euo pipefail
here="$(dirname "$0")"
declaration="$here/../production/declaration.json"
file=".thoryn/production/provision.yaml"

if [ "${GITHUB_ACTIONS:-}" != "true" ]; then
  echo "error: production-apply.sh runs in GitHub Actions only (deploy.yml's job deploy-production): production is converged from the reviewed environment, never from a workstation." >&2
  exit 1
fi
THORYN_TEMPLATE_FILE="$declaration" "$here/require-vars.sh" THORYN_ISSUER THORYN_WORKSPACE THORYN_PRODUCTION_WIF_CLIENT_ID THORYN_PRODUCTION_URL

# The deployed base URL: https, an origin plus an optional path, no query or fragment; a trailing slash is dropped.
THORYN_PRODUCTION_URL="${THORYN_PRODUCTION_URL%/}"
if [[ ! "$THORYN_PRODUCTION_URL" =~ ^https://[A-Za-z0-9.-]+(:[0-9]+)?(/[A-Za-z0-9._~/-]*)?$ ]]; then
  echo "::error title=THORYN_PRODUCTION_URL is not an https URL::THORYN_PRODUCTION_URL '$THORYN_PRODUCTION_URL' must be the deployed application's https base URL, e.g. https://shop.example.com (a production client never registers http or loopback redirect URIs)."
  exit 1
fi
export THORYN_PRODUCTION_URL

# The client's name and its fixed clientId `<name>-production`: the repository's name unless THORYN_APP_NAME is set.
if [ -z "${THORYN_APP_NAME:-}" ]; then
  THORYN_APP_NAME="${GITHUB_REPOSITORY##*/}"
fi
export THORYN_APP_NAME

THORYN_PRODUCTION_APPLY_RESULT="${THORYN_PRODUCTION_APPLY_RESULT:-${RUNNER_TEMP:?}/thoryn-production-apply.json}"
export THORYN_FIX_REQUEST="${THORYN_FIX_REQUEST:-${RUNNER_TEMP:?}/thoryn-provision-request.json}"
if [ -n "${GITHUB_ENV:-}" ]; then
  echo "THORYN_PRODUCTION_APPLY_RESULT=$THORYN_PRODUCTION_APPLY_RESULT" >> "$GITHUB_ENV"
fi
rm -f "$THORYN_PRODUCTION_APPLY_RESULT"

THORYN_TEMPLATE_FILE="$declaration" "$here/login.sh" production
echo "Production client '$THORYN_APP_NAME-production' of workspace $THORYN_WORKSPACE, redirecting to $THORYN_PRODUCTION_URL."
thoryn provision plan --file "$file"
# Written to a temporary name and moved into place only when the apply succeeded, so a result file means a finished apply.
thoryn provision apply --file "$file" --yes --output json > "$THORYN_PRODUCTION_APPLY_RESULT.partial"
mv "$THORYN_PRODUCTION_APPLY_RESULT.partial" "$THORYN_PRODUCTION_APPLY_RESULT"
# shellcheck disable=SC2016 # a JavaScript program: $ and ` are JavaScript's, not the shell's
node -e '
  const doc = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
  const resources = (doc && doc.apply && typeof doc.apply === "object" ? doc.apply : doc)?.resources ?? [];
  for (const r of resources) console.log(`Applied ${r.kind} ${r.name}: ${r.id} (${r.action})`);
' "$THORYN_PRODUCTION_APPLY_RESULT"
