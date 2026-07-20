# 🐛 fix(gateway-client): [high] live events can overtake replay and regress resilient stream cursors

GitHub: https://github.com/smithersai/smithers/issues/788

_via 2026-07 full-codebase audit_

## Summary

streamRunEvents registers a live subscriber before asynchronously replaying retained events. A live event can arrive before older replay frames, and the resilient client can then move its resume cursor backward.

## Where

- `packages/server/src/gateway.js:6592-6608 — subscriber is registered before replay drains`
- `packages/server/src/gateway.js:5407-5411 — live frames send immediately`
- `packages/gateway-client/src/SmithersGatewayClient.ts:413-418 — lastSeq is assigned without monotonicity`

## Failure scenario / repro

Pause replay/gap snapshot construction and emit a new event. Observed order can be seq 4, gap_resync, seq 2, seq 3; the client ends at lastSeq 3 and receives seq 4 again after reconnect.

## Impact

Consumers apply non-monotonic state, receive duplicates, and lose ordered resume semantics.

## Suggested fix

Establish a replay cutoff before live registration, buffer newer live frames until replay drains, then flush monotonically. As defense in depth, never decrease the client cursor.

## Tests

- Use a deterministic replay barrier and emit a live frame while paused
- Assert monotonic delivery/cursor and no duplicate after reconnect

## Dedupe notes

#702 concerns BackpressureDisconnect recovery, not this server ordering race.
