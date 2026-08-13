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
export PATH="$HOME/.bun/bin:/nix/var/nix/profiles/default/bin:$PATH"

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

echo "== guest =="
ssh_guest 'id -un; hostname; uname -srm; grep PRETTY /etc/os-release'

echo "== smithers run =="
export STEREOS_SSH_PORT="$SSH_PORT" STEREOS_SSH_KEY="$KEY"
# The published smthrs package installs its CLI as `smithers`.
exec env -u ANTHROPIC_API_KEY ./node_modules/.bin/smithers \
  up stereos-real.tsx --input '{"prompt":"hello from the linux host"}'
