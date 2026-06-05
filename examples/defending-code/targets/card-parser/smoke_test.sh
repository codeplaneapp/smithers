#!/bin/sh
# Smoke test: the parser must handle every well-formed card without crashing.
#
# The patch stage's grader runs this after applying a fix to confirm the fix
# did not break valid input (a patch that makes the program reject everything
# would "fix" the crash but fail here). Run from the example root (cwd).
#
# Usage: smoke_test.sh [binary]   (default: targets/card-parser/build/card_parser)
set -u

BIN=${1:-targets/card-parser/build/card_parser}
fail=0

set -- targets/card-parser/inputs/valid-*.card
if [ ! -e "$1" ]; then
	echo "no input cards found at targets/card-parser/inputs/valid-*.card"
	exit 1
fi

for input in "$@"; do
	out=$("$BIN" "$input" 2>&1)
	code=$?
	if [ "$code" -ne 0 ]; then
		echo "FAIL (exit $code): $input"
		echo "$out"
		fail=1
		continue
	fi
	case "$out" in
		Parsed:*) echo "ok: $input -> $out" ;;
		*) echo "FAIL (unexpected output): $input"; echo "$out"; fail=1 ;;
	esac
done

if [ "$fail" -eq 0 ]; then
	echo "SMOKE_OK"
	exit 0
fi
echo "SMOKE_FAIL"
exit 1
