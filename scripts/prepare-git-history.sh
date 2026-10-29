#!/usr/bin/env bash
# Build-time preparation only. Fetch history without changing branches or files.
set -euo pipefail
for repo in "$@"; do
  if [ "$(git -C "$repo" rev-parse --is-shallow-repository)" = true ]; then
    git -C "$repo" fetch --unshallow origin
  fi
done
