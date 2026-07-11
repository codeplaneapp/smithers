# Consolidate SSE heartbeat ownership

GitHub: https://github.com/smithersai/smithers/issues/975

Parent: smithers/gh-895-cap-sse-subscribers-and-consolidate-heartbeat-owne.md

Context: Each /v1/api/stream subscriber currently owns an independent setInterval heartbeat, creating one timer per connection. Replace this with bounded gateway/connection-level heartbeat ownership that services active subscribers. Acceptance criteria: no per-subscriber heartbeat intervals are created; heartbeat ownership starts when needed and stops when no active SSE subscribers remain; each active subscriber receives heartbeat frames at the configured cadence; disconnect and gateway.close release heartbeat ownership without timer leaks; tests verify shared ownership, heartbeat delivery, and teardown after the last subscriber closes.
