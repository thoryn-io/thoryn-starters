#!/usr/bin/env bash
# Remove what this run created, under `if: always()`: the test identity provision.sh minted (revoked now rather
# than left to its expiry, so a red run never fills the sandbox's cap of live identities), then what this run's
# `provision apply` created (the application client, when this run created it; resources that already existed
# were adopted and are never deleted). Each part runs even when the other fails.
set -uo pipefail
status=0
if [ -n "${THORYN_TEST_IDENTITY_ID:-}" ]; then
  if [ -n "${THORYN_ENVIRONMENT:-}" ]; then
    thoryn env test-identity revoke "$THORYN_TEST_IDENTITY_ID" --env "$THORYN_ENVIRONMENT" || status=$?
  else
    thoryn env test-identity revoke "$THORYN_TEST_IDENTITY_ID" || status=$?
  fi
else
  echo "No test identity to revoke (THORYN_TEST_IDENTITY_ID is not set)."
fi
if [ -f .thoryn/provision.receipt.json ]; then
  thoryn provision destroy --file .thoryn/provision.yaml --yes || status=$?
else
  echo "Nothing to destroy (no provisioning receipt)."
fi
exit "$status"
