# Add Gateway cancellation attribution integration tests

GitHub: https://github.com/smithersai/smithers/issues/1124

Parent: smithers/gh-1063-record-gateway-rpc-cancellation-attribution.md

Context: Existing Gateway tests verify cancellation status and inactive-run errors but do not verify attribution. Acceptance criteria: use real Gateway HTTP and WebSocket requests with deterministic request IDs and authenticated identities; cancel active runs through both transports; verify the run record and exposed RPC/API response contain the expected attribution, including optional client PID behavior; verify legacy or missing optional identity data remains valid; avoid mocked gateway data.
