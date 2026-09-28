#!/usr/bin/env bash
# Remove what this run's `provision apply` created (the per-run test user; the application client too when
# this run created it). Resources that already existed were adopted and are never deleted.
set -uo pipefail
if [ ! -f .thoryn/provision.receipt.json ]; then
  echo "Nothing to tear down (no provisioning receipt)."
  exit 0
fi
thoryn provision destroy --file .thoryn/provision.yaml --yes
