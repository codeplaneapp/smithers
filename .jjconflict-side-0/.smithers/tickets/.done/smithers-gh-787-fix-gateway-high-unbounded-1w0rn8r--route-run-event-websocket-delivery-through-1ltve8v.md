# Route run-event WebSocket delivery through one bounded writer

GitHub: https://github.com/smithersai/smithers/issues/1011

Parent: smithers/gh-787-fix-gateway-high-unbounded-stream-subscrip-15mgjqq.md

Context: broadcastEvent directly calls the generic WebSocket sender and separately queues a dedicated run-event frame, allowing the generic copy to bypass stream backpressure and inflate socket buffering. Acceptance criteria: all run-event writes use one byte-bounded writer with observable buffered-byte limits; slow real sockets cannot accumulate unbounded data; overflow produces the defined per-stream or per-connection failure behavior; add tests for bounded buffered data and no bypass.


> Closed by ticket-fleet sync: packages/server/src/gateway.js routes broadcastEvent's generic and dedicated run-event frames through sendEvent and the shared connection event writer. The writer measures UTF-8 bytes, exposes getConnectionBufferedEventBytes(), observes ws.bufferedAmount, caps queued bytes at 32 MiB, and closes congested connections with code 1013 on overflow. Per-stream queues are capped at 1,000 frames; overflow emits run.error BackpressureDisconnect and unregisters only that stream. Tests in packages/server/tests/gateway-connection-event-writer.test.js cover no bypass, shared delivery, bounded buffered bytes, lossless recovery, and connection overflow. packages/server/tests/gateway-run-event-backpressure.test.js covers bounded per-stream buffering, recovery, stream overflow, and queued run.error delivery. The targeted command passed: 7 tests, 0 failures.
