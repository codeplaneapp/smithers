# Propagate HTTP and WebSocket cancellation context

GitHub: https://github.com/smithersai/smithers/issues/1121

Parent: smithers/gh-1063-record-gateway-rpc-cancellation-attribution.md

Context: Gateway HTTP requests know their request ID and authenticated identity, while WebSocket requests know their frame and connection context, but cancelRun currently only aborts an in-memory controller. Acceptance criteria: construct a common cancellation attribution from HTTP and WebSocket cancellation requests; include request ID, transport, authenticated client identity where available, and client PID when known; pass it through every Gateway cancellation path, including HTTP API cancellation; persist it with the cancellation request before aborting the run.
