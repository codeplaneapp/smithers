# 🐛 fix(gateway-client): [medium] streamRunEventsResilient hangs forever on server BackpressureDisconnect

GitHub: https://github.com/smithersai/smithers/issues/702

_via ultracode (Opus multi-agent) review_

## Summary
`streamRunEvents` yields `run.error` frames as ordinary data instead of throwing, so a server backpressure disconnect leaves `streamRunEventsResilient` blocked forever with a leaked, subscription-less WebSocket.

## Details
- `packages/gateway-client/src/SmithersGatewayClient.ts:354` — `streamRunEvents` allow-lists `"run.error"`; `subscribedStream` (lines 331-341) simply `yield`s the frame. Contrast `streamExtension` (lines 608-616), which `throw`s `GatewayRpcError` on `ext.stream.error`. The doc comment at lines 569-570 wrongly claims `streamRunEvents` surfaces `run.error` by throwing.
- `packages/gateway-client/src/SmithersGatewayClient.ts:321` + `:262` — each `streamRunEvents` opens its **own** WebSocket via `connect()` (no pooling).
- `packages/server/src/gateway.js:2753` (`disconnectRunEventStreamForBackpressure`) sends `run.error{code:"BackpressureDisconnect"}`, calls `unregisterRunEventSubscriber` (clearing the stream heartbeat), and **deliberately keeps the WS open** (comment line 2749) — leaking a now-subscription-less dedicated socket.
- `packages/gateway-client/src/SmithersGatewayConnection.ts:192` — `shift()` blocks on a waiter that only resolves on a pushed frame or socket close; neither happens and there is no client idle/heartbeat timeout.
- `packages/gateway-client/src/SmithersGatewayClient.ts:419` — a yielded `run.error` frame is not `run.completed`, so `reachedTerminal` stays false; the inner `for await` (line 401) blocks forever. The stream neither throws nor ends, so the reconnect/backoff path (lines 430-452) is never entered.

## Failure scenario
A UI subscribed via `streamRunEventsResilient` to a busy run briefly stalls (backgrounded tab / slow render) so its server outbound queue exceeds `RUN_EVENT_STREAM_OUTBOUND_QUEUE_LIMIT` (gateway.js:2703). The server emits one `run.error` (BackpressureDisconnect), unregisters the subscriber, and keeps the WS open. The client yields that frame, then awaits the next frame — which never arrives and the socket never closes — so the generator hangs permanently. The documented auto-resume never fires.

## Why it matters
Backpressure disconnect of a slow consumer is exactly the case resilient streaming exists to survive, yet it produces a permanent silent hang with no client recovery plus a leaked open WebSocket held server-side. The live run view goes dead until the whole page/connection is torn down.

## Fix sketch
Throw on `run.error` (as `streamExtension` does) so `streamRunEventsResilient` treats BackpressureDisconnect as a `transport_error` and reconnects with backoff — or explicitly detect the `BackpressureDisconnect` code and force a reconnect while closing the dead socket.
