# Bound and deduplicate Gateway SSE subscriptions

GitHub: https://github.com/smithersai/smithers/issues/1013

Parent: smithers/gh-787-fix-gateway-high-unbounded-stream-subscrip-15mgjqq.md

Context: handleApiStream adds every authenticated request to an uncapped global Set and creates a heartbeat per subscriber; SSE invalidations fan out independently to every subscriber. Acceptance criteria: enforce per-connection, per-user, and global SSE subscriber caps with rejection and cleanup tests; keep each subscriber's outbound queue byte-bounded; ensure one logical run-event copy per subscriber without duplicate generic delivery; add a slow-consumer and multi-subscriber integration test.
