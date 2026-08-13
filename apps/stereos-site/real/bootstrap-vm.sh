#!/usr/bin/env bash
# bootstrap-vm.sh — make an mb-booted stereOS VM reachable by the Smithers provider.
#
# masterblaster boots the VM and injects an SSH key over the stereosd control
# plane, but it wires that key to the admin user only. The Smithers provider
# connects as agent, the restricted user, so this script installs the stereos
# public key into /home/agent/.ssh/authorized_keys over the admin channel.
#
# Drop this script once masterblaster injects keys for the agent user too
# (integration gap #6 in real/README.md).
#
# Usage: real/bootstrap-vm.sh [vm-name]        # default: smithers-stereos
# Prints the environment the provider reads.

set -euo pipefail

VM="${1:-smithers-stereos}"
MB="${MB:-mb}"
STEREOS_KEY="${STEREOS_SSH_KEY:-$HOME/.config/stereos/ssh-key}"
ADMIN_KEY="$HOME/.config/mb/vms/$VM/ssh_key"
BUN_VERSION="${STEREOS_BUN_VERSION:-1.2.21}"
BUN_CACHE="$HOME/.cache/stereos-bun/v$BUN_VERSION"
ALPINE_VERSION="3.24.1"
ALPINE_ROOTFS_SHA256="f55a90f69052c5bd6f92cb09a8f47065970830b194c917a006fb94028e721259"
ALPINE_GCC_VERSION="15.2.0-r5"

[ -f "$STEREOS_KEY.pub" ] || {
  echo "no stereos key at $STEREOS_KEY.pub; run: ssh-keygen -t ed25519 -f $STEREOS_KEY -N ''" >&2
  exit 1
}
[ -f "$ADMIN_KEY" ] || { echo "no mb key at $ADMIN_KEY; is '$VM' up? try: $MB up" >&2; exit 1; }

port=$("$MB" status "$VM" 2>/dev/null | sed -n 's/.*127\.0\.0\.1:\([0-9]*\).*/\1/p' | head -1)
[ -n "$port" ] || { echo "could not read an SSH port from: $MB status $VM" >&2; exit 1; }

ssh_admin() {
  ssh -p "$port" -i "$ADMIN_KEY" -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
    -o LogLevel=ERROR -o IdentitiesOnly=yes admin@127.0.0.1 "$@"
}

cat "$STEREOS_KEY.pub" | ssh_admin 'sudo install -d -m 700 -o agent -g agent /home/agent/.ssh \
  && sudo tee /home/agent/.ssh/authorized_keys >/dev/null \
  && sudo chown agent:agent /home/agent/.ssh/authorized_keys \
  && sudo chmod 600 /home/agent/.ssh/authorized_keys'

# Mixtapes intentionally omit a JS runtime. Download the pinned official Linux
# arm64 Bun build on the host, then install it in the guest through the already
# authenticated admin channel.
mkdir -p "$BUN_CACHE"
if [ ! -x "$BUN_CACHE/bun-linux-aarch64-musl/bun" ]; then
  curl -fsSL "https://github.com/oven-sh/bun/releases/download/bun-v$BUN_VERSION/bun-linux-aarch64-musl.zip" \
    -o "$BUN_CACHE/bun-linux-aarch64-musl.zip"
  unzip -oq "$BUN_CACHE/bun-linux-aarch64-musl.zip" -d "$BUN_CACHE"
fi
if [ ! -x "$BUN_CACHE/lib/ld-musl-aarch64.so.1" ]; then
  rootfs="$BUN_CACHE/alpine-minirootfs-$ALPINE_VERSION-aarch64.tar.gz"
  curl -fsSL "https://dl-cdn.alpinelinux.org/alpine/v3.24/releases/aarch64/$(basename "$rootfs")" -o "$rootfs"
  printf '%s  %s\n' "$ALPINE_ROOTFS_SHA256" "$rootfs" | shasum -a 256 -c -
  tar -xzf "$rootfs" -C "$BUN_CACHE" ./lib/ld-musl-aarch64.so.1
fi
if [ ! -f "$BUN_CACHE/usr/lib/libstdc++.so.6.0.34" ]; then
  for package in libstdc++ libgcc; do
    apk="$BUN_CACHE/$package-$ALPINE_GCC_VERSION.apk"
    curl -fsSL "https://dl-cdn.alpinelinux.org/alpine/v3.24/main/aarch64/$(basename "$apk")" -o "$apk"
    tar -xf "$apk" -C "$BUN_CACHE" usr/lib
  done
fi
scp -q -P "$port" -i "$ADMIN_KEY" -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
  -o LogLevel=ERROR -o IdentitiesOnly=yes "$BUN_CACHE/bun-linux-aarch64-musl/bun" \
  admin@127.0.0.1:/tmp/stereos-bun-bin
scp -q -P "$port" -i "$ADMIN_KEY" -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
  -o LogLevel=ERROR -o IdentitiesOnly=yes "$BUN_CACHE/lib/ld-musl-aarch64.so.1" \
  admin@127.0.0.1:/tmp/stereos-musl-loader
scp -q -P "$port" -i "$ADMIN_KEY" -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
  -o LogLevel=ERROR -o IdentitiesOnly=yes "$BUN_CACHE/usr/lib/libstdc++.so.6.0.34" \
  admin@127.0.0.1:/tmp/stereos-libstdc++.so.6
scp -q -P "$port" -i "$ADMIN_KEY" -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
  -o LogLevel=ERROR -o IdentitiesOnly=yes "$BUN_CACHE/usr/lib/libgcc_s.so.1" \
  admin@127.0.0.1:/tmp/stereos-libgcc_s.so.1
ssh_admin 'sudo install -d -m 755 -o agent -g agent /home/agent/.local/bin /home/agent/.local/lib \
  && sudo install -m 755 -o agent -g agent /tmp/stereos-bun-bin /home/agent/.local/bin/bun-bin \
  && sudo install -m 755 -o agent -g agent /tmp/stereos-musl-loader /home/agent/.local/lib/ld-musl-aarch64.so.1 \
  && sudo install -m 644 -o agent -g agent /tmp/stereos-libstdc++.so.6 /home/agent/.local/lib/libstdc++.so.6 \
  && sudo install -m 644 -o agent -g agent /tmp/stereos-libgcc_s.so.1 /home/agent/.local/lib/libgcc_s.so.1 \
  && rm -f /tmp/stereos-bun-bin /tmp/stereos-musl-loader /tmp/stereos-libstdc++.so.6 /tmp/stereos-libgcc_s.so.1'
cat <<'WRAPPER' | ssh_admin 'sudo tee /home/agent/.local/bin/bun >/dev/null && sudo chown agent:agent /home/agent/.local/bin/bun && sudo chmod 755 /home/agent/.local/bin/bun'
#!/bin/sh
export LD_LIBRARY_PATH=/home/agent/.local/lib
exec /home/agent/.local/lib/ld-musl-aarch64.so.1 /home/agent/.local/bin/bun-bin "$@"
WRAPPER

ssh -p "$port" -i "$STEREOS_KEY" -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
  -o LogLevel=ERROR -o IdentitiesOnly=yes agent@127.0.0.1 '/home/agent/.local/bin/bun --version'

echo "agent login verified on $VM (127.0.0.1:$port)" >&2
echo "export STEREOS_SSH_PORT=$port"
echo "export STEREOS_SSH_KEY=$STEREOS_KEY"
