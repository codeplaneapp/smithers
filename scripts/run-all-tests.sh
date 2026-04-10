#!/usr/bin/env bash
set -euo pipefail

files=()
while IFS= read -r file; do
  files+=("$file")
done < <(find tests -type f \( -name '*.test.ts' -o -name '*.test.tsx' \) | sort)

if [ "${#files[@]}" -eq 0 ]; then
  echo "No root test files found under tests/" >&2
  exit 0
fi

for file in "${files[@]}"; do
  echo
  echo "==> $file"
  bun test "$file"
done

echo
echo "==> apps/cli"
(cd apps/cli && bun test)
