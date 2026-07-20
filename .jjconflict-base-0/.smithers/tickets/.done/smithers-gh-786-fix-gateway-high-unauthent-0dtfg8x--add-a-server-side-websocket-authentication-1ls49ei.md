# Add a server-side WebSocket authentication deadline

GitHub: https://github.com/smithersai/smithers/issues/1007

Parent: smithers/gh-786-fix-gateway-high-unauthenticated-websocket-0for0ij.md

Context: Gateway WebSocket connections are registered immediately after upgrade, but authentication occurs only after a connect RPC, allowing a silent unauthenticated socket to remain indefinitely. Acceptance criteria: start an authentication deadline immediately after upgrade; close sockets that do not complete valid authentication before the deadline; clear the deadline after successful authentication and during all cleanup paths; prove with tests that a silent socket closes, releases its slot, and allows a subsequent authenticated client to connect.


> Closed by ticket-fleet sync: Implemented in packages/server/src/gateway.js: authDeadlineMs defaults to 10,000 ms; handleSocket starts a timer immediately after registration; expiry terminates unauthenticated sockets; shared close/error cleanup clears the timer and releases connection accounting; successful handleConnect authentication clears the timer; Gateway.close also clears timers. Configuration is documented in packages/server/src/GatewayOptions.ts. packages/server/tests/gateway-ws-auth-deadline.test.js directly covers silent-socket termination and slot release followed by authenticated connection, failed authentication cleanup, successful authentication surviving the deadline, and disconnect cleanup. Targeted verification: bun test packages/server/tests/gateway-ws-auth-deadline.test.js — 4 pass, 0 fail.
