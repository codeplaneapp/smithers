# Isolate unauthenticated WebSocket capacity

GitHub: https://github.com/smithersai/smithers/issues/892

Track pre-authenticated WebSocket sockets separately from authenticated connections and enforce a small bounded pre-auth cap so idle unauthenticated clients cannot exhaust maxConnections. Define promotion from pre-auth to authenticated capacity and release accounting on close, with coverage for the cap and slot release.


> Closed by ticket-fleet sync: Implemented in packages/server/src/gateway.js with a default maxPreAuthConnections cap, separate preAuthConnections tracking, authenticatedConnectionCount promotion accounting, upgrade rejection, and cleanup on close or failed authentication. packages/server/src/GatewayOptions.ts exposes the option. packages/server/tests/gateway-preauth-capacity.test.js covers cap enforcement, pre-auth close release, successful promotion, authenticated-capacity refusal, failed-auth release, and authenticated close release. The targeted test run passed all 5 tests and 27 expectations.
