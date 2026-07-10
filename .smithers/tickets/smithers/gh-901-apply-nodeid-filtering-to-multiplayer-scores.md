# Apply nodeId filtering to multiplayer scores

GitHub: https://github.com/smithersai/smithers/issues/901

Compile ListScoresRequest.nodeId together with the required runId into the multiplayer scores collection predicate, or use the RPC-backed collection if the predicate cannot be validated. Add a parity test proving scores from other nodes are excluded.
