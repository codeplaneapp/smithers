# Add a server-side WebSocket authentication deadline

GitHub: https://github.com/smithersai/smithers/issues/1007

Parent: smithers/gh-786-fix-gateway-high-unauthenticated-websocket-0for0ij.md

Context: Gateway WebSocket connections are registered immediately after upgrade, but authentication occurs only after a connect RPC, allowing a silent unauthenticated socket to remain indefinitely. Acceptance criteria: start an authentication deadline immediately after upgrade; close sockets that do not complete valid authentication before the deadline; clear the deadline after successful authentication and during all cleanup paths; prove with tests that a silent socket closes, releases its slot, and allows a subsequent authenticated client to connect.
