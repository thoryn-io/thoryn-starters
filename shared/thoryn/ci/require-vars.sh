#!/usr/bin/env bash
# require-vars.sh NAME... — exit 1, naming every one that is missing, when a required Thoryn variable is
# unset or empty. Nothing in this repository is rendered: CI gets these values from GitHub Actions variables
# (the workflow maps `${{ vars.NAME }}` into the job's environment); a local run exports them.
# Where each one is set (repository, or a GitHub environment) comes from .thoryn/template.json.
set -uo pipefail
manifest="${THORYN_TEMPLATE_FILE:-$(dirname "$0")/../template.json}"

missing=()
for name in "$@"; do
  if [[ ! "$name" =~ ^[A-Z_][A-Z0-9_]*$ ]]; then
    echo "require-vars.sh: '$name' is not a variable name" >&2
    exit 2
  fi
  [ -n "${!name:-}" ] || missing+=("$name")
done
[ ${#missing[@]} -eq 0 ] && exit 0

for name in "${missing[@]}"; do
  # "repository variable" | "variable of the GitHub environment 'x'", plus the declared meaning.
  # shellcheck disable=SC2016 # a JavaScript program: $ and ` are JavaScript's, not the shell's
  where="$(node -e '
    const [file, name] = process.argv.slice(1);
    const v = JSON.parse(require("fs").readFileSync(file, "utf8")).variables?.[name];
    if (!v) process.exit(0);
    const level = v.level === "environment" ? `a variable of the GitHub environment "${v.environment}"` : "a repository variable";
    console.log(`${level}: ${v.description}`);
  ' "$manifest" "$name" 2>/dev/null || true)"
  msg="$name is not set. In GitHub Actions it is ${where:-a repository variable} (Settings → Secrets and variables → Actions → Variables); the workflow reads it as \${{ vars.$name }}. For a local run, export $name."
  if [ "${GITHUB_ACTIONS:-}" = "true" ]; then
    echo "::error title=Thoryn variable $name is not set::$msg"
  else
    echo "error: $msg" >&2
  fi
done
exit 1
