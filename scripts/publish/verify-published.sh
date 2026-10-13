#!/usr/bin/env bash
# SSO-3675 — verify a publish the way a reader sees it: a FRESH clone of the template repository must sit
# at the commit mirror.sh reported, and its tree must equal the starter directory (assert-mirror.sh).
#
# Usage: verify-published.sh <source-dir> <owner/repo> <branch> <expected-commit>
# Env:   TARGET_URL  clone URL (default: https://x-access-token:$GH_TOKEN@github.com/<owner/repo>.git)
#        VERIFY_DIR  where to clone (default: ./verify)
set -euo pipefail

source_dir=${1:?usage: verify-published.sh <source-dir> <owner/repo> <branch> <expected-commit>}
target=${2:?usage: verify-published.sh <source-dir> <owner/repo> <branch> <expected-commit>}
branch=${3:?usage: verify-published.sh <source-dir> <owner/repo> <branch> <expected-commit>}
expected=${4:?usage: verify-published.sh <source-dir> <owner/repo> <branch> <expected-commit>}
verify=${VERIFY_DIR:-verify}
url=${TARGET_URL:-"https://x-access-token:${GH_TOKEN:?GH_TOKEN or TARGET_URL is required}@github.com/${target}.git"}
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)

if ! git clone -q --depth 1 --branch "$branch" "$url" "$verify" 2>/dev/null; then
  echo "::error::verify-published: ${target} has no branch ${branch} to clone (is the repository still empty?)"
  exit 1
fi
actual=$(git -C "$verify" rev-parse HEAD)
if [ "$actual" != "$expected" ]; then
  echo "::error::verify-published: ${target}@${branch} is at ${actual}, not the published commit ${expected}"
  exit 1
fi
"$here/assert-mirror.sh" "$source_dir" "$verify"
echo "Published ${target}@${branch} verified at ${actual}."
