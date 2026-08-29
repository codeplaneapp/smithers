#!/bin/bash
# Prints the free disk, in MiB, that a benchmark instance can actually spend.
#
#   lib/disk-free.sh
#
# One instance costs an official image (2–3 GB) and an extracted testbed
# (1–3 GB), and those two land in different places on this host: the testbed is
# a directory under the rig, on the host filesystem, and the image is a layer
# inside the docker VM. So neither number alone bounds an instance, and this
# prints the **smaller of the two** — the one that runs out first.
#
# The docker side is read by running `df` inside a container, because no docker
# command reports free space. The probe image is one that is **already local**;
# this never pulls, because a disk check that needs the network to answer
# "is there room to pull" is the wrong shape. When no probe image is present the
# answer is the host figure alone, and `--explain` says so.
#
#   SWB_DISK_PROBE_IMAGE   the probe image (default `alpine:latest`)
#   SWB_DISK_FREE_MIB      overrides the whole answer — for the rig's own tests,
#                          which need a disk gate that can be made to fail
#
# Spends nothing, needs no dataset, and never pulls.
set -eu
S="$(cd "$(dirname "$0")/.." && pwd)"
PROBE="${SWB_DISK_PROBE_IMAGE:-alpine:latest}"
EXPLAIN=0
if [ "${1:-}" = "--explain" ]; then EXPLAIN=1; fi

if [ -n "${SWB_DISK_FREE_MIB:-}" ]; then
  case "$SWB_DISK_FREE_MIB" in
    ''|*[!0-9]*) echo "disk-free.sh: SWB_DISK_FREE_MIB must be a non-negative integer" >&2; exit 2 ;;
  esac
  if [ "$EXPLAIN" = "1" ]; then
    printf '%s MiB free (overridden by SWB_DISK_FREE_MIB)\n' "$SWB_DISK_FREE_MIB"
  else
    printf '%s\n' "$SWB_DISK_FREE_MIB"
  fi
  exit 0
fi

# The host filesystem the extracted testbeds live on.
HOST_MIB="$(df -k "$S" | tail -1 | awk '{ printf "%d", $4 / 1024 }')"

# The docker VM's filesystem, when a probe image is already here to read it
# with. `docker run` writes its platform warning to stderr, which is discarded.
DOCKER_MIB=""
if command -v docker >/dev/null 2>&1 && docker image inspect "$PROBE" >/dev/null 2>&1; then
  RUN="docker"
  if command -v timeout >/dev/null 2>&1; then RUN="timeout 60 docker"; fi
  DOCKER_MIB="$($RUN run --rm "$PROBE" df -k / 2>/dev/null | tail -1 | awk '{ printf "%d", $4 / 1024 }' || true)"
  case "$DOCKER_MIB" in
    ''|*[!0-9]*) DOCKER_MIB="" ;;
  esac
fi

FREE="$HOST_MIB"
SOURCE="host filesystem only; no local probe image ($PROBE)"
if [ -n "$DOCKER_MIB" ]; then
  SOURCE="host ${HOST_MIB} MiB, docker VM ${DOCKER_MIB} MiB"
  if [ "$DOCKER_MIB" -lt "$FREE" ]; then FREE="$DOCKER_MIB"; fi
fi

if [ "$EXPLAIN" = "1" ]; then
  printf '%s MiB free (%s)\n' "$FREE" "$SOURCE"
else
  printf '%s\n' "$FREE"
fi
