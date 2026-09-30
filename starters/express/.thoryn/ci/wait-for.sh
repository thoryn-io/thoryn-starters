#!/usr/bin/env bash
# wait-for.sh <url> [seconds] — poll until <url> answers 2xx.
set -uo pipefail
url="$1"; timeout="${2:-120}"
for _ in $(seq "$timeout"); do
  if curl -fs -o /dev/null "$url"; then echo "$url is up"; exit 0; fi
  sleep 1
done
echo "::error::$url did not come up within ${timeout}s"
exit 1
