#!/usr/bin/env bash
# SSO-3675 — publish.yml's gate. On a run for main (CI green on a push to main, or a manual dispatch) an
# unconfigured publisher is a FAILURE, never a notice: the four starter-* template repositories stayed
# empty for two weeks while every publish run was green and said "skipped".
#
# Reads (set by the workflow step's `env:`, never interpolated into the script):
#   APP_ID            the repository variable STARTERS_PUBLISH_APP_ID
#   HAS_PRIVATE_KEY   "true" when the repository secret STARTERS_PUBLISH_APP_PRIVATE_KEY is non-empty
#                     (the workflow evaluates `secrets.X != ''`; the key itself never reaches this script)
set -euo pipefail

missing=()
[ -n "${APP_ID:-}" ] || missing+=("the repository variable STARTERS_PUBLISH_APP_ID")
[ "${HAS_PRIVATE_KEY:-false}" = "true" ] || missing+=("the repository secret STARTERS_PUBLISH_APP_PRIVATE_KEY")

if [ ${#missing[@]} -gt 0 ]; then
  what=$(printf '%s and ' "${missing[@]}")
  what=${what% and }
  echo "::error title=The template publisher is not configured::Publishing to the starter-* template repositories needs ${what}. Nothing was published; the template repositories are stale or empty. One-time setup: docs/publishing.md."
  exit 1
fi
echo "Publisher configured: STARTERS_PUBLISH_APP_ID is set and STARTERS_PUBLISH_APP_PRIVATE_KEY is present."
