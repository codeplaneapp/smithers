#!/bin/sh
# Compile a target with AddressSanitizer (ASAN), the memory-error detector the
# harness uses as its crash signal.
#
# Usage: harness/build.sh [source.c] [output-binary]
#   defaults: targets/card-parser/src/card_parser.c -> targets/card-parser/build/card_parser
set -eu

SRC=${1:-targets/card-parser/src/card_parser.c}
OUT=${2:-targets/card-parser/build/card_parser}
mkdir -p "$(dirname "$OUT")"

# -O0 keeps every planted write in place; the optimizer would otherwise
# dead-strip overflows whose results are never read, hiding real bugs.
clang -g -O0 -fsanitize=address -fno-omit-frame-pointer -o "$OUT" "$SRC"

echo "built $OUT"
