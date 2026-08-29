#!/bin/bash
# The httpbin the psf/requests family is graded against, and the check that it
# is actually answering before a verdict is written.
#
#   lib/httpbin.sh resolve   the endpoint to grade against, chosen and reported
#   lib/httpbin.sh probe     is the public httpbin.org healthy? (exit 0/1)
#   lib/httpbin.sh start     start the local fallback and print its URL
#   lib/httpbin.sh url       the local fallback's URL if it is up, else nothing
#   lib/httpbin.sh stop      remove the local fallback
#   lib/httpbin.sh check     resolve, then prove the endpoint end to end
#
# ## Why the rig has to care
#
# `psf/requests` is the one repository in this sample whose graded tests are
# **network tests**. `test_requests.py` at these checkouts opens with
#
#     HTTPBIN = os.environ.get('HTTPBIN_URL', 'http://httpbin.org/')
#
# and roughly a third of the dataset's `FAIL_TO_PASS` and `PASS_TO_PASS`
# identifiers for `psf__requests-1766` and `psf__requests-2317` route through
# `httpbin(...)`. The suite was written against a live httpbin, and the official
# SWE-bench evaluation inherits that assumption unchanged.
#
# On 2026-08-21 the public httpbin.org answered **HTTP 503**. The r90 grading
# logs record it verbatim — `assert 503 == 200`, not a connection error — on 42
# of `psf__requests-2317`'s graded tests, while all 99 of its network-free
# `PASS_TO_PASS` tests passed. A `PASS_TO_PASS` test failing indicts the
# environment by construction: it passed on the unmodified checkout when the
# dataset was built. Both instances therefore graded `unresolved` for a reason no
# patch could change, and `psf__requests-1766`'s patch is byte-identical to the
# codex arm's. Two verdicts lost to a third party's outage, with nothing in the
# artifacts saying so.
#
# So `resolve` never lets that happen silently again. It states which service the
# grading will use and whether that service can satisfy the suite.
#
# ## Why the public service is preferred, and the local one is a fallback
#
# The suite tests **both schemes against the same host**:
#
#     def test_mixed_case_scheme_acceptable(self):
#         parts = urlparse(httpbin('get'))
#         for scheme in ['http://', 'HTTP://', ..., 'https://', 'HTTPS://', ...]:
#             r = s.send(requests.Request('GET', scheme + parts.netloc + parts.path).prepare())
#             assert r.status_code == 200
#
# and `requests` verifies certificates. A container on a private bridge address
# cannot present a certificate this checkout's `requests` trusts, and making it
# trust one would mean editing the graded container's trust store — a change to
# the grading environment far larger than the outage it works around. So the
# local httpbin recovers every test that speaks `http://` (measured: 6 of 6
# `FAIL_TO_PASS` and 78 of 79 `PASS_TO_PASS` on `psf__requests-1766`, against 0
# and 57 during the outage) and cannot recover `test_mixed_case_scheme_acceptable`.
#
# The order is therefore:
#
#   1. `SWB_HTTPBIN_URL`, if the operator set one. Their rig, their call.
#   2. **the public httpbin.org, when it answers 200 over both http and https** —
#      the service the dataset's tests name and the official evaluation uses.
#   3. the local container, when the public service is unhealthy — with the
#      degradation stated on stderr, so a verdict produced this way is never
#      mistaken for one produced against a whole service.
#
# `resolve` prints the URL on stdout and its reasoning on stderr, and exits 1 when
# it can offer nothing at all — because grading `psf/requests` against a dead
# service is how r90 lost two instances.
#
#   SWB_HTTPBIN_URL     grade against this endpoint, full stop
#   SWB_HTTPBIN_PUBLIC  the public service to probe (default http://httpbin.org/)
#   SWB_HTTPBIN_IMAGE   the local fallback's image (default: pinned kennethreitz/httpbin)
#   SWB_HTTPBIN_NAME    the local fallback's container name (default swb-httpbin)
#   SWB_HTTPBIN_WAIT    seconds to wait for the local fallback (default 60)
#
# Spends no tokens. `start` needs docker and pulls a 534 MB image once.
set -u

NAME="${SWB_HTTPBIN_NAME:-swb-httpbin}"
# Pinned by digest: a benchmark that grades against "whatever :latest is today"
# cannot say two runs met the same service. This is the manifest the rig pulled
# on 2026-08-21 with `--platform linux/amd64`.
IMAGE="${SWB_HTTPBIN_IMAGE:-kennethreitz/httpbin@sha256:599fe5e5073102dbb0ee3dbb65f049dab44fa9fc251f6835c9990f8fb196a72b}"
WAIT="${SWB_HTTPBIN_WAIT:-60}"
PUBLIC="${SWB_HTTPBIN_PUBLIC:-http://httpbin.org/}"

case "$WAIT" in
  ''|*[!0-9]*) echo "httpbin.sh: SWB_HTTPBIN_WAIT must be a non-negative integer" >&2; exit 2 ;;
esac

running() { [ "$(docker inspect -f '{{.State.Running}}' "$NAME" 2>/dev/null)" = "true" ]; }

bridge_ip() {
  docker inspect -f '{{.NetworkSettings.Networks.bridge.IPAddress}}' "$NAME" 2>/dev/null
}

# `docker port` prints `127.0.0.1:54321`; the port is this script's own readiness
# probe. The graded container never uses it — it has no route to the host's
# loopback — and gets the bridge address instead.
host_probe() { docker port "$NAME" 80/tcp 2>/dev/null | head -1; }

print_url() {
  IP="$(bridge_ip)"
  if [ -z "$IP" ]; then return 1; fi
  printf 'http://%s/\n' "$IP"
}

ready() {
  ENDPOINT="$(host_probe)"
  if [ -z "$ENDPOINT" ]; then return 1; fi
  # `-f` so a 5xx is not mistaken for a live service — which is the exact
  # failure this whole file exists because of.
  curl -sf --max-time 5 "http://127.0.0.1:${ENDPOINT##*:}/get" >/dev/null 2>&1
}

# Is the public service whole? Both schemes, because the suite tests both.
probe_public() {
  BASE="${PUBLIC%/}"
  curl -sf --max-time 15 "$BASE/get" >/dev/null 2>&1 || return 1
  case "$BASE" in
    http://*) curl -sf --max-time 15 "https://${BASE#http://}/get" >/dev/null 2>&1 || return 1 ;;
    *) ;;
  esac
  return 0
}

start() {
  if running; then
    print_url || { echo "httpbin.sh: $NAME is running but has no bridge address" >&2; exit 1; }
    return 0
  fi
  # A container that exited (a host reboot, a `docker stop`) is removed rather
  # than restarted: httpbin is stateless, so a fresh one is both cheaper and
  # more honest than resurrecting whatever the old one held.
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
    echo "httpbin.sh: pulling $IMAGE" >&2
    docker pull --platform linux/amd64 "$IMAGE" >&2 || {
      echo "httpbin.sh: could not pull $IMAGE" >&2; exit 1; }
  fi
  docker run -d --platform linux/amd64 --name "$NAME" \
    --label swb-rig=httpbin -p 127.0.0.1::80 "$IMAGE" >/dev/null 2>&1 || {
    echo "httpbin.sh: could not start $NAME" >&2; exit 1; }

  WAITED=0
  while ! ready; do
    if [ "$WAITED" -ge "$WAIT" ]; then
      echo "httpbin.sh: $NAME did not answer within ${WAIT}s" >&2
      docker logs "$NAME" 2>&1 | tail -20 >&2
      exit 1
    fi
    sleep 1
    WAITED=$((WAITED + 1))
  done
  print_url || { echo "httpbin.sh: $NAME started but has no bridge address" >&2; exit 1; }
}

resolve() {
  if [ -n "${SWB_HTTPBIN_URL:-}" ]; then
    echo "httpbin.sh: grading against SWB_HTTPBIN_URL ($SWB_HTTPBIN_URL)" >&2
    printf '%s\n' "$SWB_HTTPBIN_URL"
    return 0
  fi
  if probe_public; then
    echo "httpbin.sh: the public service at $PUBLIC answers over http and https; grading against it" >&2
    printf '%s\n' "$PUBLIC"
    return 0
  fi
  echo "httpbin.sh: the public service at $PUBLIC is not answering over both schemes." >&2
  LOCAL="$(start)" || {
    echo "httpbin.sh: and the local fallback would not start, so psf/requests cannot be graded honestly." >&2
    return 1; }
  echo "httpbin.sh: falling back to the local httpbin at $LOCAL." >&2
  echo "httpbin.sh: DEGRADED — a private address carries no trusted certificate, so every" >&2
  echo "  https:// assertion in the suite will fail (test_mixed_case_scheme_acceptable is one)." >&2
  echo "  Treat an 'unresolved' produced this way as a rig result, not a patch result." >&2
  printf '%s\n' "$LOCAL"
}

case "${1:-}" in
  resolve) resolve ;;
  probe) probe_public ;;
  start) start ;;
  url) if running; then print_url; fi ;;
  stop) docker rm -f "$NAME" >/dev/null 2>&1 || true ;;
  check)
    URL="$(resolve)" || exit 1
    printf '%s\n' "$URL"
    BASE="${URL%/}"
    # The local fallback's bridge address is reachable from another container and
    # not from this host, so the host-side proof goes through the published port.
    # Reachability *from a container* is what `resolve` already established by
    # starting it on the same bridge the evaluator uses.
    if running && [ "$URL" = "$(print_url)" ]; then
      ENDPOINT="$(host_probe)"
      BASE="http://127.0.0.1:${ENDPOINT##*:}"
    fi
    curl -sf --max-time 15 "$BASE/get" >/dev/null || {
      echo "httpbin.sh: /get did not answer at $BASE" >&2; exit 1; }
    curl -sf --max-time 15 -u user:pass "$BASE/basic-auth/user/pass" >/dev/null || {
      echo "httpbin.sh: /basic-auth did not answer at $BASE" >&2; exit 1; }
    echo "httpbin.sh: /get and /basic-auth both answered at $BASE" >&2
    ;;
  *)
    echo "usage: lib/httpbin.sh resolve|probe|start|url|stop|check" >&2
    exit 2 ;;
esac
