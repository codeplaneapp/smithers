# Bound and deduplicate Gateway SSE subscriptions

GitHub: https://github.com/smithersai/smithers/issues/1013

Parent: smithers/gh-787-fix-gateway-high-unbounded-stream-subscrip-15mgjqq.md

Context: handleApiStream adds every authenticated request to an uncapped global Set and creates a heartbeat per subscriber; SSE invalidations fan out independently to every subscriber. Acceptance criteria: enforce per-connection, per-user, and global SSE subscriber caps with rejection and cleanup tests; keep each subscriber's outbound queue byte-bounded; ensure one logical run-event copy per subscriber without duplicate generic delivery; add a slow-consumer and multi-subscriber integration test.


> Closed by ticket-fleet sync: packages/server/src/gateway.js:250-263 defines global, per-user, per-connection, replay, and outbound queue bounds. handleApiStream at lines 3412-3466 rejects cap violations with 429 and cleans up subscriber counters on close; shared heartbeat teardown is at lines 3357-3375 and 4555-4568. flushApiInvalidation at lines 3321-3332 serializes one change frame and enqueues it once per subscriber. packages/server/tests/gateway-sse-subscriber-caps.test.ts covers all cap rejection/cleanup cases, exact-one delivery across multiple subscribers, and a real paused-socket slow-consumer reset/recovery test. packages/server/tests/gateway-domain-api.test.ts covers coalescing, bounded replay, and bounded slow-consumer queues. Executed bun test for the relevant three files: 20 pass, 0 fail.
