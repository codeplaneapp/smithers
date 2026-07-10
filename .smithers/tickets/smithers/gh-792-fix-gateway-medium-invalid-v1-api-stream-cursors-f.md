# 🐛 fix(gateway): [medium] invalid /v1/api/stream cursors flush 200 before validation

GitHub: https://github.com/smithersai/smithers/issues/792

_via 2026-07 full-codebase audit_

## Summary

GET /v1/api/stream commits an SSE 200 and registers the subscriber before validating Last-Event-ID/lastEventId. Invalid input throws after the response can no longer become a 400.

## Where

- `packages/server/src/gateway.js:3166-3173 — headers are flushed`
- `packages/server/src/gateway.js:3174-3196 — subscriber is registered`
- `packages/server/src/gateway.js:3197-3200 — cursor parsed afterward`
- `packages/server/src/gateway.js:1762-1769 — invalid values throw`

## Failure scenario / repro

Request the stream with Last-Event-ID:not-a-number. The client gets 200 and a hanging/incomplete SSE response, with an unhandled validation rejection.

## Impact

Malformed input looks successful, may retain subscriber state, and produces process-level noise instead of a deterministic client error.

## Suggested fix

Validate URL/query/header cursor before writeHead, flushHeaders, and subscriber registration; return the normal structured 400 response.

## Tests

- Invalid header and query cursors return 400 before SSE bytes
- No subscriber or unhandled rejection remains
- Valid resume behavior is unchanged

## Dedupe notes

Distinct from #554, which covers a different /v1/runs/:runId/events handler.
