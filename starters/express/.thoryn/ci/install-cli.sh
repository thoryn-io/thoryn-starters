#!/usr/bin/env bash
# Install the released `thoryn` CLI (native binary) on a GitHub Actions runner and put it on PATH.
#   THORYN_CLI_VERSION  a cli-v* release tag; empty = the latest release.
# Needs GH_TOKEN (the job's github.token is enough: the releases are public).
set -euo pipefail

case "$(uname -s)-$(uname -m)" in
  Linux-x86_64)  asset=thoryn-linux-amd64 ;;
  Linux-aarch64) asset=thoryn-linux-arm64 ;;
  Darwin-arm64)  asset=thoryn-darwin-arm64 ;;
  *) echo "::error::no thoryn CLI build for $(uname -s)-$(uname -m)"; exit 1 ;;
esac

dir="${RUNNER_TEMP:-/tmp}/thoryn-cli"
mkdir -p "$dir"
tag="${THORYN_CLI_VERSION:-}"
if [ -z "$tag" ]; then
  tag="$(gh release list --repo thoryn-io/thoryn-cli --exclude-drafts --exclude-pre-releases --limit 50 \
    --json tagName --jq '[.[] | select(.tagName | startswith("cli-v"))][0].tagName')"
fi
echo "Installing thoryn $tag ($asset)"
gh release download "$tag" --repo thoryn-io/thoryn-cli --pattern "$asset" --dir "$dir" --clobber
mv "$dir/$asset" "$dir/thoryn"
chmod +x "$dir/thoryn"
if [ -n "${GITHUB_PATH:-}" ]; then echo "$dir" >> "$GITHUB_PATH"; fi

# Workload identity sign-in from a connection contract is SSO-3308 (thoryn-cli #94). An older release
# would fail later with a confusing schema error, so say it here.
if ! "$dir/thoryn" login --help 2>&1 | grep -q -- "--audience"; then
  echo "::error::thoryn $tag predates workload identity sign-in (SSO-3308). Use a newer cli-v* release (set THORYN_CLI_VERSION)."
  exit 1
fi
"$dir/thoryn" --version || true
