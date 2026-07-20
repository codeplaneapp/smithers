# 🔒 fix(gateway): [high] trusted-proxy auth accepts forgeable identity headers from direct clients

GitHub: https://github.com/smithersai/smithers/issues/785

_via 2026-07 full-codebase audit_

## Summary

trusted-proxy mode accepts user, role, scope, and token-id headers from every client that can reach the gateway. It does not verify that the request came through a configured trusted proxy.

## Where

- `packages/server/src/gateway.js:4977-4980 — every Host is allowed whenever auth is configured`
- `packages/server/src/gateway.js:5107-5135 — identity headers are trusted directly`

## Failure scenario / repro

Configure trusted-proxy mode and make the listener directly reachable. A direct request supplying x-user-role:operator and x-user-scopes:* is authenticated with those forged grants.

## Impact

Any proxy-bypass path becomes a complete authorization bypass for run launch, cancellation, approvals, and administrative RPCs.

## Suggested fix

Require configured trusted peer addresses/CIDRs, a protected Unix socket, mutual authentication, or a signed proxy assertion. Reject trusted headers from untrusted peers and fail startup when no enforceable trust boundary exists.

## Tests

- Reject forged headers from a direct/untrusted peer
- Accept equivalent headers only from a configured trusted peer
- Cover HTTP RPC and WebSocket connect

## Dedupe notes

#446 concerns Origin allowlists and #751 concerns local-UI DNS rebinding; neither verifies trusted-proxy provenance.
