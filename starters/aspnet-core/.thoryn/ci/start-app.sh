#!/usr/bin/env bash
# Publish and start the app for the e2e journey. Needs OIDC_ISSUER / OIDC_CLIENT_ID in the environment.
set -euo pipefail
dotnet publish src/StarterApp -c Release -o out --nologo -v quiet
# Started from out/ so its content root (wwwroot) is the published one.
cd out
PORT="${PORT:-8080}" nohup dotnet StarterApp.dll > ../app.log 2>&1 &
echo $! > ../app.pid
cd ..
"$(dirname "$0")/wait-for.sh" "http://127.0.0.1:${PORT:-8080}/health" 120
