# Consolidate SSE heartbeat ownership

GitHub: https://github.com/smithersai/smithers/issues/975

Parent: smithers/gh-895-cap-sse-subscribers-and-consolidate-heartbeat-owne.md

Context: Each /v1/api/stream subscriber currently owns an independent setInterval heartbeat, creating one timer per connection. Replace this with bounded gateway/connection-level heartbeat ownership that services active subscribers. Acceptance criteria: no per-subscriber heartbeat intervals are created; heartbeat ownership starts when needed and stops when no active SSE subscribers remain; each active subscriber receives heartbeat frames at the configured cadence; disconnect and gateway.close release heartbeat ownership without timer leaks; tests verify shared ownership, heartbeat delivery, and teardown after the last subscriber closes.


> Closed by ticket-fleet sync: packages/server/src/gateway.js implements one gateway-level apiStreamHeartbeatTimer using API_STREAM_HEARTBEAT_MS, fans heartbeat frames to every active subscriber, starts it on registration, stops it after the last request/response disconnect, and clears it in Gateway.close. packages/server/tests/gateway-sse-subscriber-caps.test.ts verifies shared heartbeat ownership, delivery to multiple real SSE subscribers, disconnect cleanup, and teardown after the final subscriber closes. The targeted suite passes: 5 tests, 0 failures.
