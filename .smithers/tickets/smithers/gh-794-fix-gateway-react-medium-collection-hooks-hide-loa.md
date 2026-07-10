# 🐛 fix(gateway-react): [medium] collection hooks hide load failures as empty successful results

GitHub: https://github.com/smithersai/smithers/issues/794

_via 2026-07 full-codebase audit_

## Summary

Collection-backed React hooks discard useLiveQuery errors and always return error:undefined. Failed initial loads become empty, non-loading success states.

## Where

- `packages/gateway-react/src/useGatewayRuns.ts:20-25 — representative error suppression`
- `packages/gateway-react/src/useGatewayApprovals.ts and sibling collection hooks — same pattern`

## Failure scenario / repro

Make the initial endpoint return HTTP 500. The hook settles as {data:[], loading:false, error:undefined}.

## Impact

Authentication failures, outages, and server errors are silently presented as no data, preventing actionable error/retry UI.

## Suggested fix

Use a shared adapter that maps live-query readiness and error state into GatewayAsyncState. Preserve prior data if desired but surface the current error.

## Tests

- Exercise a failing real local endpoint for each hook family
- Assert error is populated and refetch recovers

## Dedupe notes

No existing issue covers collection-hook load error suppression.
