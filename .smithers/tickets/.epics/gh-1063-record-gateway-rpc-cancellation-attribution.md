# Record Gateway RPC cancellation attribution

GitHub: https://github.com/smithersai/smithers/issues/1063

Propagate Gateway WebSocket and HTTP cancellation request context into the run cancellation source, including request ID, client identity where available, and client PID when known. Persist and expose the attribution, with RPC contract and integration tests.
