# 🐛 fix(gateway-react): [medium] provider retains stale client options and drops collection auth headers

GitHub: https://github.com/smithersai/smithers/issues/793

_via 2026-07 full-codebase audit_

## Summary

SmithersGatewayProvider memoizes its RPC client without several behavior-affecting options, and custom headers are never propagated to the collection/data client.

## Where

- `packages/gateway-react/src/SmithersGatewayProvider.ts:19-30 — headers, fetch, WebSocket, and metadata are omitted`
- `packages/gateway-client/src/data/createSmithersDataClient.ts:69-73 — data client supports bearer headers only`
- `packages/gateway-client/src/SmithersGatewayClientOptions.ts:1-11 — public options include the omitted values`

## Failure scenario / repro

Rerendering with rotated headers or a new fetch/WebSocket implementation retains the old client. Trusted-proxy headers may authenticate RPC calls but be absent from collections/SSE.

## Impact

RPC and collection surfaces can have different authorization, and credential or transport rotation remains stale until remount.

## Suggested fix

Include all behavior-affecting options in recreation semantics, propagate custom headers to data/SSE clients, and close owned clients when replaced.

## Tests

- Rerender with changed headers/fetch/WebSocket/metadata and assert the next request uses them
- Verify auth headers reach RPC, API, and SSE consistently

## Dedupe notes

No matching provider-option or collection-header issue.
