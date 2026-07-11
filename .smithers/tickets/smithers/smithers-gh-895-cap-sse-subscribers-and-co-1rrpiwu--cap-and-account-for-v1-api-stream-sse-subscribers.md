# Cap and account for /v1/api/stream SSE subscribers

GitHub: https://github.com/smithersai/smithers/issues/974

Parent: smithers/gh-895-cap-sse-subscribers-and-consolidate-heartbeat-owne.md

Context: The gateway currently accepts every authenticated /v1/api/stream request and stores it without global or per-user limits. Add configurable global and per-user subscriber caps, using the authenticated user identity and a defined anonymous bucket where necessary. Acceptance criteria: excess requests are rejected before the SSE response is established with a structured 429 response; accepted connections increment the correct global and per-user counters exactly once; disconnect and gateway shutdown cleanup decrement/remove counters idempotently; counters cannot become negative or remain stale; tests cover global exhaustion, per-user exhaustion, successful admission after disconnect, and cleanup on both request and response close.
