# Add a server-side WebSocket authentication deadline

GitHub: https://github.com/smithersai/smithers/issues/891

Start an authentication timer immediately after WebSocket upgrade, close sockets that do not complete a valid connect RPC before the deadline, clear the timer after authentication, and ensure timeout cleanup releases the connection slot. Add tests proving a silent socket closes and a valid client can connect afterward.


> Closed by ticket-fleet sync: Implemented in packages/server/src/gateway.js:5246-5308, where handleSocket starts authDeadlineTimer after upgrade and terminates unauthenticated sockets; lines 5350-5366 clear the timer and release connection slots; lines 5471-5473 clear it after successful authentication. packages/server/tests/gateway-ws-auth-deadline.test.js covers silent-socket eviction and subsequent authenticated connection, timer clearing, failed authentication, and disconnect cleanup. Focused test passed: 4 pass, 0 fail.
