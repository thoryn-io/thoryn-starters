#!/usr/bin/env bash
# SSO-3675 — mirror one starter directory into its template repository: a fresh clone of the target, the
# source rsync'ed over it (--delete), one commit naming the source SHA, pushed to the target's default
# branch. Writes `branch` and `commit` (the target HEAD after the push, also when it was already up to
# date) to $GITHUB_OUTPUT so verify-published.sh can check what a reader of the template actually gets.
#
# Usage: mirror.sh <source-dir> <owner/repo>
# Env:   TARGET_URL  clone/push URL (default: https://x-access-token:$GH_TOKEN@github.com/<owner/repo>.git)
#        SHA         the thoryn-starters commit being published (commit message)
#        WORK_DIR    where to clone the target (default: ./target)
#        gh          must be on PATH and authenticated (reads the target's default branch)
set -euo pipefail

source_dir=${1:?usage: mirror.sh <source-dir> <owner/repo>}
target=${2:?usage: mirror.sh <source-dir> <owner/repo>}
work=${WORK_DIR:-target}
url=${TARGET_URL:-"https://x-access-token:${GH_TOKEN:?GH_TOKEN or TARGET_URL is required}@github.com/${target}.git"}
sha=${SHA:-unknown}

[ -d "$source_dir" ] || { echo "::error::mirror.sh: source directory $source_dir does not exist"; exit 1; }
# The workflow passes a path relative to the job workspace (source/starters/<name>); make it absolute
# before this script changes directory into the clone.
source_dir=$(cd "$source_dir" && pwd)

# An empty repository has no branch yet, and an empty clone may sit on the runner's init.defaultBranch;
# the push below therefore names the branch GitHub reports as the default, explicitly, so the first publish
# lands where the starter flow and `thoryn project init` read.
default_branch=$(gh api "repos/${target}" --jq .default_branch)
[ -n "$default_branch" ] || { echo "::error::mirror.sh: could not read the default branch of ${target}"; exit 1; }

# (git warns "You appear to have cloned an empty repository" for a first publish; that is expected.)
git clone -q --depth 1 "$url" "$work"
cd "$work"

rsync -a --delete --exclude .git --exclude node_modules "${source_dir%/}/" ./
git add -A .
if git rev-parse -q --verify HEAD >/dev/null 2>&1 && git diff --cached --quiet; then
  echo "${target} is already up to date with ${sha}."
else
  git -c user.name="thoryn-starters publish" -c user.email="noreply@thoryn.io" \
    commit -q -m "Publish from thoryn-io/thoryn-starters@${sha}"
  git push -q origin "HEAD:refs/heads/${default_branch}"
  echo "Pushed $(git rev-parse HEAD) to ${target} (${default_branch}) from ${sha}."
fi

{
  echo "branch=${default_branch}"
  echo "commit=$(git rev-parse HEAD)"
} >> "${GITHUB_OUTPUT:-/dev/null}"
