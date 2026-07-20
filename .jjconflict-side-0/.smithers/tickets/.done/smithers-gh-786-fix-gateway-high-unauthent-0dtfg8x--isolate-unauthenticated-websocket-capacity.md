# Isolate unauthenticated WebSocket capacity

GitHub: https://github.com/smithersai/smithers/issues/1008

Parent: smithers/gh-786-fix-gateway-high-unauthenticated-websocket-0for0ij.md

Context: Pre-authenticated sockets currently share the authenticated connection set and can consume all maxConnections slots. Acceptance criteria: track pre-authenticated sockets separately; enforce a bounded pre-auth capacity; define and implement promotion from pre-auth to authenticated capacity; release both forms of accounting on close or failed authentication; add tests covering the pre-auth cap, promotion, and slot release.


> Closed by ticket-fleet sync: Implemented in packages/server/src/gateway.js:2069-2076, 4391-4418, and 5233-5504 with separate preAuthConnections tracking, maxPreAuthConnections enforcement, authenticated-capacity promotion, and cleanup on close or failed authentication. Configuration is exposed in packages/server/src/GatewayOptions.ts:91-106. packages/server/tests/gateway-preauth-capacity.test.js:196-318 covers pre-auth caps, close release, promotion, promotion refusal, failed-auth release, and authenticated slot release; the targeted test passed with 5 pass and 0 fail. packages/server/tests/gateway-http-boundaries.test.js:423-469 also covers upgrade rejection.
