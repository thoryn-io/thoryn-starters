#!/usr/bin/env bash
# SSO-3675 — assert that a mirror directory IS the source: same files, same content, same executable bits,
# and not empty. `.git` and `node_modules` are outside the comparison (the mirror excludes them).
# A publish that "succeeds" with an empty or diverging template repository is the false-green this
# repository shipped for two weeks; this check is what makes the publish job's green mean something.
#
# Usage: assert-mirror.sh <source-dir> <mirror-dir>
set -euo pipefail

source_dir=${1:?usage: assert-mirror.sh <source-dir> <mirror-dir>}
mirror_dir=${2:?usage: assert-mirror.sh <source-dir> <mirror-dir>}
for d in "$source_dir" "$mirror_dir"; do
  [ -d "$d" ] || { echo "::error::assert-mirror: $d is not a directory"; exit 1; }
done

if command -v sha256sum >/dev/null 2>&1; then hash_cmd=(sha256sum); else hash_cmd=(shasum -a 256); fi

# One line per file: "<sha256> <x|-> <path>", sorted bytewise so the two listings line up.
listing() {
  (
    cd "$1"
    find . -type f ! -path './.git/*' ! -path '*/node_modules/*' -print0 | LC_ALL=C sort -z |
      while IFS= read -r -d '' f; do
        h=$("${hash_cmd[@]}" "$f" | cut -d' ' -f1)
        if [ -x "$f" ]; then x=x; else x=-; fi
        printf '%s %s %s\n' "$h" "$x" "${f#./}"
      done
  )
}

expected=$(listing "$source_dir")
actual=$(listing "$mirror_dir")
source_count=$(printf '%s' "$expected" | grep -c . || true)
mirror_count=$(printf '%s' "$actual" | grep -c . || true)

if [ "$source_count" -eq 0 ]; then
  echo "::error::assert-mirror: the source $source_dir has no files; refusing to call an empty mirror correct"
  exit 1
fi
if [ "$mirror_count" -eq 0 ]; then
  echo "::error::assert-mirror: the mirror $mirror_dir is EMPTY (expected ${source_count} files from $source_dir)"
  exit 1
fi
if [ "$expected" != "$actual" ]; then
  echo "::error::assert-mirror: the mirror $mirror_dir differs from $source_dir (${mirror_count} files, expected ${source_count})"
  echo "--- lines only in the source (<) / only in the mirror (>): sha256, executable bit, path"
  diff <(printf '%s\n' "$expected") <(printf '%s\n' "$actual") | grep '^[<>]' || true
  exit 1
fi
echo "Mirror verified: ${mirror_count} files in $mirror_dir match $source_dir (content and executable bits)."
