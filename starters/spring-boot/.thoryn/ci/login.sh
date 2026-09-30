#!/usr/bin/env bash
# login.sh <connection> — sign in to Thoryn with workload identity (no secret) as connection <connection>
# of .thoryn/template.json. Run inside a GitHub Actions job with `permissions: id-token: write`.
#
# Everything comes from the environment at run time (the workflow maps the Actions variables into it):
#   THORYN_ISSUER, THORYN_WORKSPACE, and the variables the connection names (clientIdVariable, and
#   environmentVariable for a sandbox connection). The scopes are the connection's `scopes`.
# The trust's audience is the workspace issuer on the platform's host, plus /<sandbox> for a sandbox
# trust: https://<workspace>.<host of THORYN_ISSUER>[/<sandbox>]. THORYN_AUDIENCE overrides it (for
# example once a custom domain is active, until the CLI resolves the audience itself, SSO-3413).
set -euo pipefail
here="$(dirname "$0")"
connection="${1:?usage: login.sh <connection>}"
manifest="${THORYN_TEMPLATE_FILE:-$here/../template.json}"

# Line 1: client id variable, line 2: environment variable (empty for production), line 3: scopes.
# shellcheck disable=SC2016 # a JavaScript program: $ and ` are JavaScript's, not the shell's
spec="$(node -e '
  const [file, name] = process.argv.slice(1);
  const c = JSON.parse(require("fs").readFileSync(file, "utf8")).connections?.[name];
  if (!c) { console.error(`${file} declares no connection "${name}"`); process.exit(1); }
  console.log(c.clientIdVariable); console.log(c.environmentVariable ?? ""); console.log(c.scopes.join(" "));
' "$manifest" "$connection")"
client_var="$(sed -n 1p <<< "$spec")"
env_var="$(sed -n 2p <<< "$spec")"
scopes="$(sed -n 3p <<< "$spec")"

required=(THORYN_ISSUER THORYN_WORKSPACE "$client_var")
[ -n "$env_var" ] && required+=("$env_var")
"$here/require-vars.sh" "${required[@]}"

slug='^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$'
if [[ ! "$THORYN_WORKSPACE" =~ $slug ]]; then echo "::error::THORYN_WORKSPACE '$THORYN_WORKSPACE' is not a workspace slug"; exit 1; fi
sandbox=""
if [ -n "$env_var" ]; then
  sandbox="${!env_var}"
  if [[ ! "$sandbox" =~ $slug ]]; then echo "::error::$env_var '$sandbox' is not an environment slug"; exit 1; fi
fi

audience="${THORYN_AUDIENCE:-}"
if [ -z "$audience" ]; then
  base="${THORYN_ISSUER%/}"
  scheme="${base%%://*}"
  rest="${base#*://}"
  host="${rest%%/*}"
  if [ "$scheme" = "$base" ] || [ -z "$host" ]; then echo "::error::THORYN_ISSUER '$THORYN_ISSUER' is not a URL"; exit 1; fi
  audience="$scheme://$THORYN_WORKSPACE.$host${sandbox:+/$sandbox}"
fi

echo "Signing in as connection '$connection' (${!client_var}) at $audience"
thoryn login --workload-identity \
  --issuer "$THORYN_ISSUER" \
  --workspace "$THORYN_WORKSPACE" \
  --client-id "${!client_var}" \
  --audience "$audience" \
  --scope "$scopes"
