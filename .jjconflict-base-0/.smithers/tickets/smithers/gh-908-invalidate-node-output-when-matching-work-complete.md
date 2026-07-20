# Invalidate node output when matching work completes or emits output

GitHub: https://github.com/smithersai/smithers/issues/908

Update useGatewayNodeOutput so unchanged run/node/iteration parameters can still trigger a refetch when a matching node output, finish, failure, or terminal-state event arrives. Preserve stale-request protection and add a test where output is initially absent, then a finish/output event is published, and the hook exposes the durable output without manual refetch or parameter changes.
