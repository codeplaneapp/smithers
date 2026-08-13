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

pub=$(cat "$STEREOS_KEY.pub")
ssh_admin "sudo install -d -m 700 -o agent -g agent /home/agent/.ssh \
  && printf '%s\n' '$pub' | sudo tee /home/agent/.ssh/authorized_keys >/dev/null \
  && sudo chown agent:agent /home/agent/.ssh/authorized_keys \
  && sudo chmod 600 /home/agent/.ssh/authorized_keys"

ssh -p "$port" -i "$STEREOS_KEY" -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
  -o LogLevel=ERROR -o IdentitiesOnly=yes agent@127.0.0.1 'true'

echo "agent login verified on $VM (127.0.0.1:$port)" >&2
echo "export STEREOS_SSH_PORT=$port"
echo "export STEREOS_SSH_KEY=$STEREOS_KEY"
