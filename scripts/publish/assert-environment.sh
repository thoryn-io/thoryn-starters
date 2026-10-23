#!/usr/bin/env bash
# SSO-3675 (hardening) — the publish App's private key may be readable ONLY by a job running for main.
#
# GitHub enforces that through a deployment environment with a deployment-branch policy of exactly `main`:
# its secrets reach a job only when the job is bound to it AND the run's ref passes the policy. A repository
# secret has no such boundary — any workflow on any branch a writer pushes can read it — and an environment
# without a branch policy is no better. Both settings are operator steps (docs/publishing.md), so this script
# CHECKS them on every run, from a job that is not bound to the environment, before any job that is:
#
#   1. the key is not visible outside the environment (no repository or organisation secret of that name);
#   2. the environment exists — if it did not, the first bound job would CREATE it, with no protection;
#   3. its deployment-branch policy is "selected branches" with exactly one rule: the branch `main`.
#
# Usage: assert-environment.sh <owner/repo> <environment>
#   gh on PATH, GH_TOKEN with `actions: read` (the permission GitHub lists for both environment reads).
#   KEY_OUTSIDE_ENVIRONMENT  "true" when secrets.STARTERS_PUBLISH_APP_PRIVATE_KEY is non-empty in a job that
#                            is NOT bound to the environment (the workflow evaluates `!= ''`; no value here).
set -euo pipefail

repo=${1:?usage: assert-environment.sh <owner/repo> <environment>}
environment=${2:?usage: assert-environment.sh <owner/repo> <environment>}
problems=()

if [ "${KEY_OUTSIDE_ENVIRONMENT:-false}" = "true" ]; then
  problems+=("STARTERS_PUBLISH_APP_PRIVATE_KEY is readable outside the environment ${environment}: it is a repository or organisation secret, which a workflow on any branch can read. Set it on the environment only, then delete the other one (gh secret delete STARTERS_PUBLISH_APP_PRIVATE_KEY -R ${repo}).")
fi

err=$(mktemp)
trap 'rm -f "$err"' EXIT
if policy=$(gh api "repos/${repo}/environments/${environment}" \
    --jq '.deployment_branch_policy | if . == null then "all" elif .custom_branch_policies then "custom" elif .protected_branches then "protected" else "all" end' 2>"$err"); then
  case "$policy" in
    custom)
      if rules=$(gh api "repos/${repo}/environments/${environment}/deployment-branch-policies" \
          --jq '[.branch_policies[] | "\(.type // "branch") \(.name)"] | join(", ")' 2>"$err"); then
        if [ "$rules" != "branch main" ]; then
          problems+=("the environment ${environment} may be deployed from [${rules:-nothing}]; it must allow exactly the branch main. Fix its deployment-branch rules (docs/publishing.md).")
        fi
      else
        cat "$err" >&2
        problems+=("could not read the deployment-branch rules of the environment ${environment} (the job needs permissions: actions: read).")
      fi
      ;;
    protected)
      problems+=("the environment ${environment} may be deployed from any protected branch; it must allow exactly the branch main. Choose \"Selected branches and tags\" with the single rule main (docs/publishing.md).")
      ;;
    *)
      problems+=("the environment ${environment} has no deployment-branch policy, so a job on any branch can read its secrets. Choose \"Selected branches and tags\" with the single rule main (docs/publishing.md).")
      ;;
  esac
elif grep -q 'HTTP 404' "$err"; then
  problems+=("the environment ${environment} does not exist on ${repo}. Create it with a main-only deployment-branch policy before setting the publish App's id and key (docs/publishing.md).")
else
  cat "$err" >&2
  problems+=("could not read the environment ${environment} (the job needs permissions: actions: read).")
fi

if [ ${#problems[@]} -gt 0 ]; then
  for p in "${problems[@]}"; do
    echo "::error title=The publish key is not confined to main::${p}"
  done
  exit 1
fi
echo "Environment ${environment}: only the branch main can deploy, and STARTERS_PUBLISH_APP_PRIVATE_KEY is not readable outside it."
