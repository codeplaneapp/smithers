#!/bin/bash
# Prints how this image runs the repository's own Python.
#
#   interpreter.sh <container>
#
# The official images do not put the project's interpreter on a bare `PATH`.
# They activate it from the login profile — a conda environment under
# /opt/miniconda3, a virtualenv, a rewritten `PATH` — so `python` means the
# project's Python only inside a login shell, and `sys.executable` is that
# answer as an absolute path.
#
# This is a fact the harness can read off the container at setup, and r91
# measured what not stating it costs. That wave routed `interpreter: "python3"`
# straight at the container, which resolves to a Python without the
# repository's dependencies; 30 of 45 instances then spent 138 cells scanning
# /opt for `/opt/miniconda3/envs/testbed/bin/python3.10`, and the traces filled
# with `ModuleNotFoundError: No module named 'numpy'`.
#
# Like lib/test-command.py, what is printed is environment teaching and not an
# answer: it says how to run this repository's Python and nothing about the
# task. It reads no dataset row, so it cannot leak one.
#
# Prints nothing and exits 1 when the image answers nothing usable. A fact the
# harness could not measure is simply not stated; the run discovers it the
# ordinary way.
set -uo pipefail
CONTAINER="${1:-}"
if [ -z "$CONTAINER" ]; then
  echo "interpreter.sh: no container given" >&2
  exit 2
fi

PROBE='for p in python python3; do command -v "$p" >/dev/null 2>&1 && exec "$p" -c "import sys; print(sys.executable)"; done; exit 1'
FOUND="$(docker exec "$CONTAINER" bash -lc "$PROBE" 2>/dev/null | tail -n 1 | tr -d '\r')"

case "$FOUND" in
  /*) printf '%s\n' "$FOUND" ;;
  *)
    echo "interpreter.sh: $CONTAINER reported no absolute interpreter path" >&2
    exit 1
    ;;
esac
