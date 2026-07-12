# Route run-event WebSocket delivery through one bounded writer

GitHub: https://github.com/smithersai/smithers/issues/1011

Parent: smithers/gh-787-fix-gateway-high-unbounded-stream-subscrip-15mgjqq.md

Context: broadcastEvent directly calls the generic WebSocket sender and separately queues a dedicated run-event frame, allowing the generic copy to bypass stream backpressure and inflate socket buffering. Acceptance criteria: all run-event writes use one byte-bounded writer with observable buffered-byte limits; slow real sockets cannot accumulate unbounded data; overflow produces the defined per-stream or per-connection failure behavior; add tests for bounded buffered data and no bypass.
