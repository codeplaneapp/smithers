# 🔒 fix(cli/localUiServer): [high] gateway & concierge proxy paths skip the DNS-rebinding Host check the data endpoints enforce

GitHub: https://github.com/smithersai/smithers/issues/751

_via ultracode (Opus multi-agent) review_

## Summary
The gateway and concierge reverse-proxy paths in `localUiServer.js` omit the `requestHostIsLoopback()` DNS-rebinding guard that the local-data endpoints enforce, so a rebound hostname can reach the proxied gateway/concierge via no-Origin GETs.

## References
- `apps/cli/src/localUiServer.js:580-582` — data endpoints: `isLocalDataRequestAllowed() = requestHostIsLoopback(req) && !isCrossOriginProxyRequest(req)`
- `apps/cli/src/localUiServer.js:562-565` — comment: `requestHostIsLoopback()` exists to defeat DNS rebinding
- `apps/cli/src/localUiServer.js:537-541` — `isCrossOriginProxyRequest()` returns `false` (allowed) when Origin is absent
- `apps/cli/src/localUiServer.js:1241-1252` — concierge `/api/` proxy: only checks `isCrossOriginProxyRequest`
- `apps/cli/src/localUiServer.js:1253-1268` — gateway proxy: only checks `isCrossOriginProxyRequest`
- `apps/cli/src/localUiServer.js:1287-1292` — WS upgrade handler: only checks `isCrossOriginProxyRequest`

## Failure scenario
An attacker page at `evil.com` whose DNS is rebound to `127.0.0.1`. After rebinding the page is same-origin with the server, so a simple GET to `/v1/rpc`, `/workflows`, or `/api/...` carries **no** Origin header and `Host: evil.com`. `isCrossOriginProxyRequest()` returns `false`, the request is proxied (Host/Origin rewritten to loopback before forwarding, hiding the real origin from the gateway), and the script-readable response leaks run/workflow/repo state. The identical GET against a data endpoint (e.g. the VCS snapshot path) is rejected by `requestHostIsLoopback()` because `Host: evil.com` is not loopback. POST/RPC mutations still carry an Origin and are correctly blocked (`originMatchesHost` requires a loopback Host at line 496); the gap is read/GET traffic and any endpoint acting on a no-Origin request. The concierge path additionally fronts chat credentials and can background workflows.

## Why it matters
An inconsistent, exploitable defense-in-depth gap in exactly the DNS-rebinding threat model the file already codes against for its data endpoints. Fix: add `requestHostIsLoopback(req)` to the gateway, concierge, and upgrade guards (or gate all three on `isLocalDataRequestAllowed`-equivalent logic).
