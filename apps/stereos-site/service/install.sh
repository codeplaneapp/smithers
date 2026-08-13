#!/usr/bin/env bash
# Install the stereos.smithers.sh demo service on a host already prepared by
# real/provision-linux-host.sh (QEMU/KVM, Nix, Bun, the built coder-dev image).
#
#   ./install.sh                 install units, reload systemd, start everything
#   ./install.sh --no-start      lay the files down without touching services
#
# Layout it creates:
#   ~/stereos-demo/.smithers/    the demo workspace: workflows + provider + guard
#   ~/stereos-demo/node_modules  symlink to the checkout, so `smthrs` resolves
#   /etc/stereos-demo.env        0600: the gateway bearer token
#   /etc/systemd/system/         stereos-vm, stereos-gateway, stereos-guard

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORKSPACE="${STEREOS_WORKSPACE:-$HOME/stereos-demo}"
CHECKOUT="${STEREOS_CHECKOUT:-$HOME/smithers}"
ENV_FILE=/etc/stereos-demo.env
LIB_DIR=/usr/local/lib/stereos-demo
START=1
[ "${1:-}" = "--no-start" ] && START=0

[ -d "$CHECKOUT/node_modules" ] || { echo "no node_modules in $CHECKOUT; run pnpm install there first" >&2; exit 1; }

echo "== laying down $WORKSPACE =="
rm -rf "$WORKSPACE/.smithers"
mkdir -p "$WORKSPACE/.smithers"
tar -C "$HERE" --exclude systemd -cf - . | tar -C "$WORKSPACE/.smithers" -xf -
ln -sfn "$CHECKOUT/node_modules" "$WORKSPACE/node_modules"
chmod +x "$WORKSPACE/.smithers/guest-runner.sh" "$WORKSPACE/.smithers/boot-vm.sh"

echo "== bundling the embedded run UI =="
(cd "$WORKSPACE/.smithers" && bun build-ui.ts)

echo "== $LIB_DIR =="
sudo mkdir -p "$LIB_DIR"
sudo install -m 0755 "$HERE/boot-vm.sh" "$LIB_DIR/boot-vm.sh"
sudo install -m 0755 "$HERE/tunnel.sh" "$LIB_DIR/tunnel.sh"

if [ ! -f "$ENV_FILE" ]; then
  echo "== minting the gateway bearer token =="
  printf 'SMITHERS_API_KEY=%s\n' "$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')" | sudo tee "$ENV_FILE" >/dev/null
fi
# The tunnel unit publishes its own hostname, so it needs a DNS-scoped token.
# Pass it in the environment on first install; it is stored 0600 root-only.
if [ -n "${CLOUDFLARE_API_TOKEN:-}" ] && ! sudo grep -q CLOUDFLARE_API_TOKEN "$ENV_FILE"; then
  printf 'CLOUDFLARE_API_TOKEN=%s\n' "$CLOUDFLARE_API_TOKEN" | sudo tee -a "$ENV_FILE" >/dev/null
fi
sudo chmod 0600 "$ENV_FILE"
sudo chown root:root "$ENV_FILE"

echo "== systemd units =="
for unit in stereos-vm stereos-gateway stereos-guard stereos-tunnel; do
  sed -e "s|@USER@|$USER|g" -e "s|@HOME@|$HOME|g" -e "s|@WORKSPACE@|$WORKSPACE|g" -e "s|@CHECKOUT@|$CHECKOUT|g" \
    "$HERE/systemd/$unit.service" | sudo tee "/etc/systemd/system/$unit.service" >/dev/null
done
sudo systemctl daemon-reload

if [ "$START" = 1 ]; then
  echo "== starting =="
  sudo systemctl enable --now stereos-vm.service
  sudo systemctl enable --now stereos-gateway.service
  sudo systemctl enable --now stereos-guard.service
  sudo systemctl enable --now stereos-tunnel.service
  sleep 5
  systemctl --no-pager --lines=0 status stereos-vm stereos-gateway stereos-guard stereos-tunnel || true
fi

echo "done. guard on 127.0.0.1:${STEREOS_GUARD_PORT:-8787}"
