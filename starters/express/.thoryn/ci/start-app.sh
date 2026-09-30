#!/usr/bin/env bash
# Build-free start of the app for the e2e journey (npm ci already ran). Needs OIDC_ISSUER / OIDC_CLIENT_ID.
set -euo pipefail
PORT="${PORT:-8080}" nohup npm start > app.log 2>&1 &
echo $! > app.pid
"$(dirname "$0")/wait-for.sh" "http://127.0.0.1:${PORT:-8080}/health" 60
