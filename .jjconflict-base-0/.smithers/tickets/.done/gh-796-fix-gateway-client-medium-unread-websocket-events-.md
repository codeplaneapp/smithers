# 🐛 fix(gateway-client): [medium] unread WebSocket events grow an unbounded in-memory queue

GitHub: https://github.com/smithersai/smithers/issues/796

_via 2026-07 full-codebase audit_

## Summary

SmithersGatewayConnection appends every event/error to an array without a count or byte cap. A slow caller, or one that never iterates events(), retains every frame.

## Where

- `packages/gateway-client/src/SmithersGatewayConnection.ts:55-59 — unbounded queue`
- `packages/gateway-client/src/SmithersGatewayConnection.ts:147-190 — every event is appended`
- `packages/gateway-client/src/SmithersGatewayConnection.ts:192-202 — only consumer shift removes entries`

## Failure scenario / repro

Open a connection without consuming events and deliver 100,000 valid frames. All 100,000 remain queued; no backpressure or resync occurs.

## Impact

A busy or adversarial gateway can exhaust browser or Node memory.

## Suggested fix

Add byte and count bounds. On overflow, close with a typed backpressure error or enter an explicit resync contract; clear unreachable retained entries on terminal close.

## Tests

- Deliver beyond count and byte caps and assert bounded retention plus deterministic overflow behavior
- Preserve normal ordered delivery below the cap

## Dedupe notes

#702 concerns recovery from server backpressure; #711 concerns DevTools retention.


> Closed by ticket-fleet: landed on main in 81df8a587df3188b700fc5f24f06ace150e33846.
