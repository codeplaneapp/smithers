# Share one heartbeat scheduler per WebSocket connection

GitHub: https://github.com/smithersai/smithers/issues/1012

Parent: smithers/gh-787-fix-gateway-high-unbounded-stream-subscrip-15mgjqq.md

Context: each registered run-event stream creates its own interval, so many streams create many timers. Acceptance criteria: use at most one heartbeat timer per WebSocket connection; emit heartbeats for all active streams with the required payload; start and stop the timer as the first and last stream are registered or removed; verify timer cleanup on unsubscribe, backpressure disconnect, socket close, and gateway shutdown.
