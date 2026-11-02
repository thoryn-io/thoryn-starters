#!/usr/bin/env bash
# Remove what this run created, under `if: always()`: the test identity provision.sh minted (revoked now rather
# than left to its expiry, so a red run never fills the sandbox's cap of live identities), then the application
# client, ONLY when this run's apply created it. Each part runs even when the other fails.
#
# What this run created is read from this run's `thoryn provision apply --output json` result (THORYN_APPLY_RESULT,
# saved by provision.sh; the CLI keeps no receipt, thoryn-cli SSO-3715). `thoryn provision destroy` reads live state and
# removes every declared resource this identity OWNS, so it cannot tell a client this run created from one an earlier
# run (or the application's own apply) created and this run only converged. Destroy therefore runs only when the
# result shows every declared resource with action `create`. Anything else (`noop`, `update`, no result because the
# apply did not finish) leaves the client in place: the next run converges the same client by its name.
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

result="${THORYN_APPLY_RESULT:-.thoryn/last-apply.json}"
if [ ! -s "$result" ]; then
  echo "Nothing to destroy: no apply result at $result (this run's apply did not finish)."
else
  # Exit 0: this run created every declared resource. 1: something existed before (kept). 2: not an apply result.
  # shellcheck disable=SC2016 # a JavaScript program: $ and ` are JavaScript's, not the shell's
  node -e '
    let doc;
    try { doc = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); } catch (e) { console.log(`${process.argv[1]} is not JSON (${e.message}).`); process.exit(2); }
    const resources = (doc && doc.apply && typeof doc.apply === "object" ? doc.apply : doc)?.resources;
    if (!Array.isArray(resources) || resources.length === 0) { console.log(`${process.argv[1]} lists no resources.`); process.exit(2); }
    const kept = resources.filter((r) => r.action !== "create");
    if (kept.length === 0) { console.log(`This run created ${resources.map((r) => `${r.kind} ${r.name} (${r.id})`).join(", ")}.`); process.exit(0); }
    console.log(`Kept: ${kept.map((r) => `${r.kind} ${r.name} (${r.id}) was ${r.action === "noop" ? "already there" : r.action}`).join(", ")}; this run created only what shows action create.`);
    process.exit(1);
  ' "$result"
  verdict=$?
  case "$verdict" in
    0) thoryn provision destroy --file .thoryn/provision.yaml --yes || status=$? ;;
    1) echo "Nothing destroyed: this run did not create the application, so it is not this run's to remove." ;;
    *) echo "Nothing destroyed: the apply result could not be read."; [ "$status" -ne 0 ] || status=1 ;;
  esac
fi
exit "$status"
