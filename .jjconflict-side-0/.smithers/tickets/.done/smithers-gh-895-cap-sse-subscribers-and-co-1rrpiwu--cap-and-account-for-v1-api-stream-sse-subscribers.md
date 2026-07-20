# Cap and account for /v1/api/stream SSE subscribers

GitHub: https://github.com/smithersai/smithers/issues/974

Parent: smithers/gh-895-cap-sse-subscribers-and-consolidate-heartbeat-owne.md

Context: The gateway currently accepts every authenticated /v1/api/stream request and stores it without global or per-user limits. Add configurable global and per-user subscriber caps, using the authenticated user identity and a defined anonymous bucket where necessary. Acceptance criteria: excess requests are rejected before the SSE response is established with a structured 429 response; accepted connections increment the correct global and per-user counters exactly once; disconnect and gateway shutdown cleanup decrement/remove counters idempotently; counters cannot become negative or remain stale; tests cover global exhaustion, per-user exhaustion, successful admission after disconnect, and cleanup on both request and response close.


> Closed by ticket-fleet sync: Implemented on main by commit ced5684687. packages/server/src/gateway.js:261-263 defines global, per-user, and per-connection caps; lines 3345-3429 enforce them before SSE headers and return structured 429 RateLimited responses; lines 3412-3413 derive authenticated or anonymous identity keys; lines 3448-3466 provide idempotent request/response-close cleanup and counter updates; lines 4555-4568 clear heartbeat, subscribers, and counters on shutdown. packages/server/tests/gateway-sse-subscriber-caps.test.ts covers exhaustion, release and re-admission, teardown, and real socket cleanup. The focused suite passed: 5 tests, 439 assertions.
