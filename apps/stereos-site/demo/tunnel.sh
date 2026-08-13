#!/usr/bin/env bash
# Publish the guard through a cloudflared tunnel and record the resulting
# hostname in DNS, so the page can find the backend without an open port.
#
# Two modes, chosen by whether a named tunnel is configured:
#
#   named  /etc/stereos-tunnel.json exists (created by install-tunnel.sh once
#          the Cloudflare API token carries "Cloudflare Tunnel: Edit"). The
#          hostname is stable: stereos-api.smithers.sh.
#   quick  otherwise. cloudflared allocates a *.trycloudflare.com hostname at
#          startup. This script reads it out of the log and writes it to the
#          TXT record _stereos-api.smithers.sh, which the page resolves over
#          DNS-over-HTTPS to find the current backend.
#
# Either way the box never listens on a public port: cloudflared dials out.

set -euo pipefail

GUARD_URL="${STEREOS_GUARD_URL:-http://127.0.0.1:8787}"
ZONE_ID="${CLOUDFLARE_ZONE_ID:-8ebd98d2f0dc7d8db2e61f31ebc19c14}"
RECORD="${STEREOS_DISCOVERY_RECORD:-_stereos-api.smithers.sh}"
LOG=/tmp/stereos-tunnel.log
NAMED_CONFIG=/etc/stereos-tunnel.json

if [ -f "$NAMED_CONFIG" ]; then
  exec cloudflared tunnel --no-autoupdate run --token "$(python3 -c 'import json;print(json.load(open("'"$NAMED_CONFIG"'"))["token"])')"
fi

: >"$LOG"
cloudflared tunnel --url "$GUARD_URL" --no-autoupdate >"$LOG" 2>&1 &
CHILD=$!
trap 'kill "$CHILD" 2>/dev/null || true' EXIT TERM INT

# cloudflared prints the assigned hostname within a few seconds of startup.
HOSTNAME=""
for _ in $(seq 1 60); do
  HOSTNAME=$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' "$LOG" | head -1 || true)
  [ -n "$HOSTNAME" ] && break
  sleep 1
done

if [ -z "$HOSTNAME" ]; then
  echo "cloudflared did not report a hostname; see $LOG" >&2
  wait "$CHILD"
  exit 1
fi

HOSTNAME="${HOSTNAME#https://}"
echo "tunnel hostname: $HOSTNAME"

# Publish it, so the page can discover the current backend. The record holds a
# hostname only: no token, no key, nothing that grants access on its own.
if [ -n "${CLOUDFLARE_API_TOKEN:-}" ]; then
  API="https://api.cloudflare.com/client/v4/zones/$ZONE_ID/dns_records"
  EXISTING=$(curl -fsS -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" "$API?type=TXT&name=$RECORD" |
    python3 -c 'import json,sys; r=json.load(sys.stdin)["result"]; print(r[0]["id"] if r else "")')
  BODY=$(printf '{"type":"TXT","name":"%s","content":"%s","ttl":60}' "$RECORD" "$HOSTNAME")
  if [ -n "$EXISTING" ]; then
    curl -fsS -X PUT -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" -H "content-type: application/json" \
      "$API/$EXISTING" -d "$BODY" >/dev/null && echo "updated TXT $RECORD"
  else
    curl -fsS -X POST -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" -H "content-type: application/json" \
      "$API" -d "$BODY" >/dev/null && echo "created TXT $RECORD"
  fi
else
  echo "CLOUDFLARE_API_TOKEN unset; skipping DNS publication" >&2
fi

wait "$CHILD"
