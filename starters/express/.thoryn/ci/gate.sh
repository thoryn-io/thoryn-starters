#!/usr/bin/env bash
# gate.sh NAME... — decide whether this run's Thoryn jobs run, and write ready=true|false to $GITHUB_OUTPUT.
# The NAMEs are the Actions variables the Thoryn jobs need (the workflow maps them into the environment).
#
#   the template repository itself (IS_TEMPLATE=true)          → skip with a notice
#   a pull request from a fork (FORK=true; it gets no OIDC token) → skip with a notice
#   every variable set                                         → ready
#   none set, on the first push of a just-created repository   → skip with a notice: the creation flow sets
#     (FIRST_PUSH=true)                                           the variables right after it creates the
#                                                                 repository, and that first run can start first
#   otherwise                                                  → FAIL, naming each missing variable
set -euo pipefail
here="$(dirname "$0")"
out="${GITHUB_OUTPUT:-/dev/stdout}"

if [ "${IS_TEMPLATE:-false}" = "true" ]; then
  echo "::notice::This is the starter template repository; the Thoryn jobs run in the repositories created from it."
  echo "ready=false" >> "$out"; exit 0
fi
if [ "${FORK:-false}" = "true" ]; then
  echo "::notice::Pull requests from forks get no GitHub OIDC token; the Thoryn jobs are skipped."
  echo "ready=false" >> "$out"; exit 0
fi

set_count=0
for name in "$@"; do
  if [ -n "${!name:-}" ]; then set_count=$((set_count + 1)); fi
done
if [ "$set_count" -eq 0 ] && [ "${FIRST_PUSH:-false}" = "true" ]; then
  echo "::notice::None of $* is set yet. This is the repository's first run; the Thoryn jobs run once the variables exist (re-run this workflow, or push)."
  echo "ready=false" >> "$out"; exit 0
fi
"$here/require-vars.sh" "$@"
echo "ready=true" >> "$out"
