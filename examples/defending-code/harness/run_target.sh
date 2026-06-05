#!/bin/sh
# Run a target binary against one input file and report whether it crashed.
#
# This wrapper ALWAYS exits 0. A find agent runs the target through its bash
# tool, and Smithers' bash tool throws on a non-zero exit code, but an ASAN
# crash *is* a non-zero exit. Swallowing the exit code here lets the agent read
# the AddressSanitizer report (the actual signal) instead of an opaque failure.
#
# Output: the program's own output, then a final machine-readable STATUS line:
#   STATUS=CRASH KIND=<asan-class> EXIT=<code>   reproducible memory error
#   STATUS=NONZERO EXIT=<code>                   exited non-zero, no ASAN report
#   STATUS=OK EXIT=0                             clean run
#
# Usage: harness/run_target.sh <binary> <input-file>
bin=$1
input=$2

out=$("$bin" "$input" 2>&1)
code=$?

printf '%s\n' "$out"

if printf '%s' "$out" | grep -q 'AddressSanitizer'; then
	kind=$(printf '%s' "$out" \
		| grep -oE 'ERROR: AddressSanitizer: [a-zA-Z-]+' \
		| head -1 \
		| sed 's/ERROR: AddressSanitizer: //')
	printf 'STATUS=CRASH KIND=%s EXIT=%s\n' "${kind:-unknown}" "$code"
elif [ "$code" -ne 0 ]; then
	printf 'STATUS=NONZERO EXIT=%s\n' "$code"
else
	printf 'STATUS=OK EXIT=%s\n' "$code"
fi

exit 0
