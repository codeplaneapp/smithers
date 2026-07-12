# 🐛 fix(gateway): [high] unauthenticated WebSockets can exhaust maxConnections indefinitely

GitHub: https://github.com/smithersai/smithers/issues/786

_via 2026-07 full-codebase audit_

## Summary

A WebSocket counts against maxConnections immediately after upgrade, but authentication and heartbeat enforcement begin only after a valid connect RPC. A client can upgrade and remain silent forever.

## Where

- `packages/server/src/gateway.js:3888-3908 — connection cap is checked during upgrade`
- `packages/server/src/gateway.js:4696-4723 — unauthenticated socket is inserted immediately`
- `packages/server/src/gateway.js:4858-4877 — heartbeat starts only after authentication`

## Failure scenario / repro

With maxConnections:1, open one WebSocket and never send connect. It remains registered indefinitely and every later valid client is rejected.

## Impact

Unauthenticated remote clients can deny gateway access using at most maxConnections idle sockets.

## Suggested fix

Start an authentication deadline immediately after upgrade, close silent sockets, track pre-auth sockets under a small separate cap, and make slot admission atomic.

## Tests

- A silent socket is closed after the handshake timeout and releases its slot
- An authenticated client connects afterward
- Concurrent upgrades cannot overshoot the cap

## Dedupe notes

#553 and #702 cover different post-subscription/client recovery paths.
