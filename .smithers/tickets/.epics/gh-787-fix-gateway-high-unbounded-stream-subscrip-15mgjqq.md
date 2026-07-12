# 🐛 fix(gateway): [high] unbounded stream subscriptions and direct WebSocket sends defeat backpressure

GitHub: https://github.com/smithersai/smithers/issues/787

_via 2026-07 full-codebase audit_

## Summary

The gateway does not cap run-event streams or SSE subscribers. Each stream allocates state, a heartbeat interval, and a queue, while generic broadcasts also write directly to the WebSocket and bypass the bounded stream queue.

## Where

- `packages/server/src/gateway.js:2628-2651 — per-stream state and interval`
- `packages/server/src/gateway.js:3136-3217 — uncapped SSE subscribers`
- `packages/server/src/gateway.js:6571-6625 — repeated streamRunEvents registrations`
- `packages/server/src/gateway.js:5375-5411 — generic direct sends and duplicate run-event delivery`

## Failure scenario / repro

One authenticated connection registered 5,000 streams and created 5,000 entries/intervals. A slow socket still receives the generic event copy even when the dedicated stream queue would pause it.

## Impact

One client can exhaust timers, memory, CPU, and the socket implementation's internal buffer.

## Suggested fix

Enforce per-connection, per-user, per-run, and global caps; reuse one heartbeat per connection; route all writes through a single byte-bounded writer; avoid duplicate generic delivery.

## Tests

- Reject registrations beyond each cap and verify cleanup
- Exercise a slow real socket and assert bounded buffered data
- Cap SSE subscribers and ensure one logical copy per run event

## Dedupe notes

#553, #702, and #731 cover different leaks/recovery behavior, not caps or the direct-send bypass.
