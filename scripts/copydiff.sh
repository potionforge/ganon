#!/usr/bin/env bash
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

{
  git diff HEAD
  git ls-files --others --exclude-standard -z | while IFS= read -r -d "" f; do
    printf "\n=== new file: %s ===\n\n" "$f"
    cat "$f"
  done
} | pbcopy
