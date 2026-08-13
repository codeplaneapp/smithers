#!/usr/bin/env bash
# run-on-linux-host.sh — boot the locally built mixtape under QEMU/KVM and run
# the Smithers workflow against it.
#
# Run on a host already prepared by provision-linux-host.sh, from the directory
# holding stereos-real.tsx and its siblings.
#
# Unlike the macOS path this does not use masterblaster: the image was built
# from the -dev profile, which bakes ~/.config/stereos/ssh-key.pub in for both
# admin and agent, so no key injection step is needed.

set -euo pipefail

SSH_PORT="${STEREOS_SSH_PORT:-2222}"
KEY="${STEREOS_SSH_KEY:-$HOME/.config/stereos/ssh-key}"
IMAGE="${STEREOS_IMAGE:-$HOME/stereOS/result/stereos.qcow2}"
BUN_VERSION="${STEREOS_BUN_VERSION:-1.2.21}"
ALPINE_VERSION="3.24.1"
ALPINE_ROOTFS_SHA256="41f73e3cf5fa919b8aa5ca6b30dc48f0da2720776d7423e2a7748211456fe081"
ALPINE_GCC_VERSION="15.2.0-r5"
export PATH="$HOME/.bun/bin:/nix/var/nix/profiles/default/bin:$PATH"

if [ ! -r /dev/kvm ] || [ ! -w /dev/kvm ]; then
  if [ "${STEREOS_KVM_REEXEC:-0}" != 1 ]; then
    echo "re-entering with the kvm group so QEMU can open /dev/kvm" >&2
    exec sg kvm -c "STEREOS_KVM_REEXEC=1 bash $(printf '%q' "$0")"
  fi
  echo "current shell cannot read and write /dev/kvm; log out and back in" >&2
  exit 1
fi

ssh_guest() {
  ssh -p "$SSH_PORT" -i "$KEY" -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
    -o LogLevel=ERROR -o IdentitiesOnly=yes -o ConnectTimeout=5 agent@127.0.0.1 "$@"
}

if ! ssh_guest true 2>/dev/null; then
  # The Nix store image is read-only, so boot a copy-on-write overlay over it.
  OVERLAY="${STEREOS_OVERLAY:-$HOME/stereos-overlay.qcow2}"
  [ -f "$OVERLAY" ] || qemu-img create -f qcow2 -F qcow2 -b "$IMAGE" "$OVERLAY" >/dev/null

  # Mixtape images boot through GRUB under UEFI, so the VM needs OVMF. With
  # SeaBIOS the firmware never hands off and the serial log stays empty.
  OVMF_CODE="${STEREOS_OVMF_CODE:-/usr/share/OVMF/OVMF_CODE_4M.fd}"
  OVMF_VARS="${STEREOS_OVMF_VARS:-$HOME/stereos-efi-vars.fd}"
  [ -f "$OVMF_VARS" ] || cp /usr/share/OVMF/OVMF_VARS_4M.fd "$OVMF_VARS"

  echo "== booting $OVERLAY under QEMU/KVM =="
  # No -nographic: it conflicts with -daemonize. -display none plus a serial
  # log file gives the same console capture for a detached VM.
  qemu-system-x86_64 \
    -machine q35,accel=kvm -cpu host -smp 2 -m 3072 \
    -drive "if=pflash,format=raw,unit=0,readonly=on,file=$OVMF_CODE" \
    -drive "if=pflash,format=raw,unit=1,file=$OVMF_VARS" \
    -drive "file=$OVERLAY,if=virtio,format=qcow2" \
    -netdev "user,id=net0,hostfwd=tcp:127.0.0.1:$SSH_PORT-:22" \
    -device virtio-net-pci,netdev=net0 \
    -serial file:"$HOME/vm-console.log" -display none -daemonize
  for _ in $(seq 1 90); do
    ssh_guest true 2>/dev/null && break
    sleep 2
  done
fi

echo "== install official Bun v$BUN_VERSION in guest =="
BUN_CACHE="$HOME/.cache/stereos-bun/v$BUN_VERSION"
mkdir -p "$BUN_CACHE"
if [ ! -x "$BUN_CACHE/bun-linux-x64-musl/bun" ]; then
  curl -fsSL "https://github.com/oven-sh/bun/releases/download/bun-v$BUN_VERSION/bun-linux-x64-musl.zip" \
    -o "$BUN_CACHE/bun-linux-x64-musl.zip"
  unzip -oq "$BUN_CACHE/bun-linux-x64-musl.zip" -d "$BUN_CACHE"
fi
if [ ! -x "$BUN_CACHE/lib/ld-musl-x86_64.so.1" ]; then
  rootfs="$BUN_CACHE/alpine-minirootfs-$ALPINE_VERSION-x86_64.tar.gz"
  curl -fsSL "https://dl-cdn.alpinelinux.org/alpine/v3.24/releases/x86_64/$(basename "$rootfs")" -o "$rootfs"
  printf '%s  %s\n' "$ALPINE_ROOTFS_SHA256" "$rootfs" | sha256sum -c -
  tar -xzf "$rootfs" -C "$BUN_CACHE" ./lib/ld-musl-x86_64.so.1
fi
if [ ! -f "$BUN_CACHE/usr/lib/libstdc++.so.6.0.34" ]; then
  for package in libstdc++ libgcc; do
    apk="$BUN_CACHE/$package-$ALPINE_GCC_VERSION.apk"
    curl -fsSL "https://dl-cdn.alpinelinux.org/alpine/v3.24/main/x86_64/$(basename "$apk")" -o "$apk"
    tar -xf "$apk" -C "$BUN_CACHE" usr/lib
  done
fi
ssh_guest 'mkdir -p /home/agent/.local/bin /home/agent/.local/lib'
scp -q -P "$SSH_PORT" -i "$KEY" -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
  -o LogLevel=ERROR -o IdentitiesOnly=yes "$BUN_CACHE/bun-linux-x64-musl/bun" \
  agent@127.0.0.1:/home/agent/.local/bin/bun-bin
scp -q -P "$SSH_PORT" -i "$KEY" -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
  -o LogLevel=ERROR -o IdentitiesOnly=yes "$BUN_CACHE/lib/ld-musl-x86_64.so.1" \
  agent@127.0.0.1:/home/agent/.local/lib/ld-musl-x86_64.so.1
scp -q -P "$SSH_PORT" -i "$KEY" -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
  -o LogLevel=ERROR -o IdentitiesOnly=yes "$BUN_CACHE/usr/lib/libstdc++.so.6.0.34" \
  agent@127.0.0.1:/home/agent/.local/lib/libstdc++.so.6
scp -q -P "$SSH_PORT" -i "$KEY" -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
  -o LogLevel=ERROR -o IdentitiesOnly=yes "$BUN_CACHE/usr/lib/libgcc_s.so.1" \
  agent@127.0.0.1:/home/agent/.local/lib/libgcc_s.so.1
cat <<'WRAPPER' | ssh_guest 'cat > /home/agent/.local/bin/bun && chmod 755 /home/agent/.local/bin/bun /home/agent/.local/bin/bun-bin /home/agent/.local/lib/ld-musl-x86_64.so.1'
#!/bin/sh
export LD_LIBRARY_PATH=/home/agent/.local/lib
exec /home/agent/.local/lib/ld-musl-x86_64.so.1 /home/agent/.local/bin/bun-bin "$@"
WRAPPER
ssh_guest '/home/agent/.local/bin/bun --version'

echo "== guest =="
ssh_guest 'id -un; hostname; uname -srm; grep PRETTY /etc/os-release'

echo "== smithers run =="
export STEREOS_SSH_PORT="$SSH_PORT" STEREOS_SSH_KEY="$KEY"
SMITHERS_ROOT="${SMITHERS_ROOT:-$(git rev-parse --show-toplevel)}"
exec env -u ANTHROPIC_API_KEY bun "$SMITHERS_ROOT/apps/cli/src/index.js" \
  up "$SMITHERS_ROOT/examples/stereos-sandbox-provider/real/stereos-real.tsx" \
  --input '{"prompt":"hello from the linux host"}'
