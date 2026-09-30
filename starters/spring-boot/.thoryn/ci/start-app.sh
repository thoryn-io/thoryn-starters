#!/usr/bin/env bash
# Package and start the app for the e2e journey. Needs OIDC_ISSUER / OIDC_CLIENT_ID in the environment.
set -euo pipefail
./mvnw -B -q -DskipTests package
PORT="${PORT:-8080}" nohup java -jar target/thoryn-starter-spring-boot-*.jar > app.log 2>&1 &
echo $! > app.pid
"$(dirname "$0")/wait-for.sh" "http://127.0.0.1:${PORT:-8080}/health" 120
