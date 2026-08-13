#!/usr/bin/env bash
# provision-linux-host.sh — turn a fresh nested-virt Linux box into a stereOS
# execution host for Smithers.
#
# Run on the host itself (Debian 12 / Ubuntu, x86_64, /dev/kvm present):
#   scp real/provision-linux-host.sh box: && ssh box 'bash provision-linux-host.sh'
#
# Installs QEMU/KVM, Nix, and Bun, then builds the x86_64 coder-dev mixtape
# from source. A source build is required because the Paper Compute registry
# publishes no x86_64 mixtape: `mb mixtapes list coder-x86` returns no tags.
#
# The build bakes ~/.config/stereos/ssh-key.pub into the image (profiles/dev.nix),
# so generate or copy that key before running this.

set -euo pipefail
log() { printf '\n=== %s ===\n' "$*"; }

[ -e /dev/kvm ] || { echo "no /dev/kvm: this host has no hardware virtualization" >&2; exit 1; }

log "packages"
sudo apt-get update -qq
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq \
  qemu-system-x86 qemu-utils git curl xz-utils unzip jq make nodejs npm >/dev/null
sudo adduser "$USER" kvm >/dev/null 2>&1 || true

if [ ! -r /dev/kvm ] || [ ! -w /dev/kvm ]; then
  if [ "${STEREOS_KVM_REEXEC:-0}" != 1 ]; then
    echo "re-entering this script with the new kvm group" >&2
    exec sg kvm -c "STEREOS_KVM_REEXEC=1 bash $(printf '%q' "$0")"
  fi
  echo "current shell still cannot read and write /dev/kvm" >&2
  exit 1
fi

log "stereos ssh key"
mkdir -p ~/.config/stereos
[ -f ~/.config/stereos/ssh-key ] || ssh-keygen -t ed25519 -f ~/.config/stereos/ssh-key -N "" -q
cat ~/.config/stereos/ssh-key.pub

log "nix"
if ! command -v nix >/dev/null 2>&1; then
  # Keep the systemd init: the multi-user store needs a running nix-daemon, and
  # `--init none` leaves builds failing on /nix/var/nix/db/big-lock.
  curl -fsSL https://install.determinate.systems/nix \
    | sh -s -- install linux --no-confirm --extra-conf "max-jobs = auto"
fi
export PATH=/nix/var/nix/profiles/default/bin:$PATH
nix --version

log "bun"
command -v bun >/dev/null 2>&1 || curl -fsSL https://bun.sh/install | bash
export PATH="$HOME/.bun/bin:$PATH"
bun --version

log "pnpm"
command -v pnpm >/dev/null 2>&1 || sudo npm install -g pnpm@10.15.0 >/dev/null
pnpm --version

log "stereOS source"
[ -d ~/stereOS ] || git clone --depth 1 https://github.com/papercomputeco/stereOS ~/stereOS

log "build the x86_64 coder-dev mixtape (long; ~gigabytes of Nix closure)"
cd ~/stereOS
time make build-qcow2 MIXTAPE=coder-dev ARCH=x86_64-linux

log "built"
ls -l result/ || true
