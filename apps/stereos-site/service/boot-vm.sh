#!/usr/bin/env bash
# Boot the locally built coder-dev mixtape under QEMU/KVM and keep it up.
#
# stereos-vm.service runs this in the foreground: QEMU stays attached (no
# -daemonize) so systemd owns the process and restarts it if the guest dies.
# The guest runtime is installed once per boot, because the copy-on-write
# overlay is recreated only when it is missing.

set -euo pipefail

SSH_PORT="${STEREOS_SSH_PORT:-2222}"
KEY="${STEREOS_SSH_KEY:-$HOME/.config/stereos/ssh-key}"
IMAGE="${STEREOS_IMAGE:-$HOME/stereOS/result/stereos.qcow2}"
OVERLAY="${STEREOS_OVERLAY:-$HOME/stereos-overlay.qcow2}"
OVMF_CODE="${STEREOS_OVMF_CODE:-/usr/share/OVMF/OVMF_CODE_4M.fd}"
OVMF_VARS="${STEREOS_OVMF_VARS:-$HOME/stereos-efi-vars.fd}"
RUNTIME_DIR="${STEREOS_RUNTIME_DIR:-$HOME/.cache/stereos-bun/v1.2.21}"

export PATH="$HOME/.bun/bin:/nix/var/nix/profiles/default/bin:$PATH"

[ -f "$OVERLAY" ] || qemu-img create -f qcow2 -F qcow2 -b "$IMAGE" "$OVERLAY" >/dev/null
[ -f "$OVMF_VARS" ] || cp /usr/share/OVMF/OVMF_VARS_4M.fd "$OVMF_VARS"

ssh_guest() {
  ssh -p "$SSH_PORT" -i "$KEY" -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
    -o LogLevel=ERROR -o IdentitiesOnly=yes -o ConnectTimeout=5 agent@127.0.0.1 "$@"
}

# Install the guest Bun runtime once the guest answers, then stay out of the way.
(
  for _ in $(seq 1 120); do
    if ssh_guest true 2>/dev/null; then
      if ! ssh_guest '/home/agent/.local/bin/bun --version' >/dev/null 2>&1; then
        ssh_guest 'mkdir -p /home/agent/.local/bin /home/agent/.local/lib'
        scp_guest() {
          scp -q -P "$SSH_PORT" -i "$KEY" -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
            -o LogLevel=ERROR -o IdentitiesOnly=yes "$1" "agent@127.0.0.1:$2"
        }
        scp_guest "$RUNTIME_DIR/bun-linux-x64-musl/bun" /home/agent/.local/bin/bun-bin
        scp_guest "$RUNTIME_DIR/lib/ld-musl-x86_64.so.1" /home/agent/.local/lib/ld-musl-x86_64.so.1
        scp_guest "$RUNTIME_DIR/usr/lib/libstdc++.so.6.0.34" /home/agent/.local/lib/libstdc++.so.6
        scp_guest "$RUNTIME_DIR/usr/lib/libgcc_s.so.1" /home/agent/.local/lib/libgcc_s.so.1
        printf '%s\n' '#!/bin/sh' \
          'export LD_LIBRARY_PATH=/home/agent/.local/lib' \
          'exec /home/agent/.local/lib/ld-musl-x86_64.so.1 /home/agent/.local/bin/bun-bin "$@"' |
          ssh_guest 'cat > /home/agent/.local/bin/bun && chmod 755 /home/agent/.local/bin/bun /home/agent/.local/bin/bun-bin /home/agent/.local/lib/ld-musl-x86_64.so.1'
      fi
      ssh_guest '/home/agent/.local/bin/bun --version' >&2 || true
      break
    fi
    sleep 2
  done
) &

# Mixtape images boot through GRUB under UEFI, so the VM needs OVMF. With
# SeaBIOS the firmware never hands off and the serial log stays empty.
exec qemu-system-x86_64 \
  -machine q35,accel=kvm -cpu host -smp 2 -m 3072 \
  -drive "if=pflash,format=raw,unit=0,readonly=on,file=$OVMF_CODE" \
  -drive "if=pflash,format=raw,unit=1,file=$OVMF_VARS" \
  -drive "file=$OVERLAY,if=virtio,format=qcow2" \
  -netdev "user,id=net0,hostfwd=tcp:127.0.0.1:$SSH_PORT-:22" \
  -device virtio-net-pci,netdev=net0 \
  -serial file:"$HOME/vm-console.log" -display none
