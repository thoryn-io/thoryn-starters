#!/usr/bin/env bash
# SSO-3675 — the starter flow generates customer repositories with POST /repos/<owner/repo>/generate, which
# GitHub only serves for a repository marked as a template. A mirror into a non-template repository is a
# publish nobody can use, so it fails here, naming the one command that fixes it.
#
# Usage: assert-template-repo.sh <owner/repo>   (gh on PATH, authenticated)
set -euo pipefail

target=${1:?usage: assert-template-repo.sh <owner/repo>}
is_template=$(gh api "repos/${target}" --jq .is_template)
if [ "$is_template" != "true" ]; then
  echo "::error title=${target} is not a template repository::The starter flow cannot generate from ${target} (is_template=${is_template:-unknown}). Fix: gh repo edit ${target} --template"
  exit 1
fi
echo "${target} is a template repository."
