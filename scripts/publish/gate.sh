#!/usr/bin/env bash
# SSO-3675 — publish.yml's gate, the first step of the job that mints the publish App's token. On a run for
# main (CI green on a push to main, or a manual dispatch) an unconfigured publisher is a FAILURE, never a
# notice: the four starter-* template repositories stayed empty for two weeks while every publish run was
# green and said "skipped".
#
# SSO-3675 (hardening) — the App id and key live in the GitHub environment $PUBLISH_ENVIRONMENT, which only
# main can deploy to. Environment variables and secrets are visible ONLY to a job bound to that environment,
# so this gate runs inside the bound job: a gate in an unbound job would see nothing and could not tell
# "configured" from "missing".
#
# Reads (set by the workflow step's `env:`, never interpolated into the script):
#   PUBLISH_ENVIRONMENT  the environment's name (publish.yml's workflow-level env)
#   APP_ID               vars.STARTERS_PUBLISH_APP_ID as the bound job sees it
#   HAS_PRIVATE_KEY      "true" when secrets.STARTERS_PUBLISH_APP_PRIVATE_KEY is non-empty in the bound job
#                        (the workflow evaluates `secrets.X != ''`; the key itself never reaches this script)
set -euo pipefail

environment=${PUBLISH_ENVIRONMENT:?PUBLISH_ENVIRONMENT must name the publish environment}
missing=()
[ -n "${APP_ID:-}" ] || missing+=("the variable STARTERS_PUBLISH_APP_ID")
[ "${HAS_PRIVATE_KEY:-false}" = "true" ] || missing+=("the secret STARTERS_PUBLISH_APP_PRIVATE_KEY")

if [ ${#missing[@]} -gt 0 ]; then
  what=$(printf '%s and ' "${missing[@]}")
  what=${what% and }
  echo "::error title=The template publisher is not configured::Publishing to the starter-* template repositories needs ${what} in the GitHub environment ${environment}. Nothing was published; the template repositories are stale or empty. One-time setup: docs/publishing.md."
  exit 1
fi
echo "Publisher configured: STARTERS_PUBLISH_APP_ID is set and STARTERS_PUBLISH_APP_PRIVATE_KEY is present in the environment ${environment}."
