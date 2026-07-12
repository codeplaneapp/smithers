# Apply nodeId filtering to multiplayer scores

GitHub: https://github.com/smithersai/smithers/issues/901

Compile ListScoresRequest.nodeId together with the required runId into the multiplayer scores collection predicate, or use the RPC-backed collection if the predicate cannot be validated. Add a parity test proving scores from other nodes are excluded.


> Closed by ticket-fleet sync: Implemented in packages/gateway-client/src/data/createSmithersCollections.ts:254-268 and :648-667. scoresWhere combines run_id and node_id, while unsupported literals use the RPC fallback. packages/gateway-client/tests/data/collectionsWhereFilters.test.ts:53-63, :118-147, :164-178, and :197-257 verify compilation, wiring, fallback, proxy validation, and seeded parity excluding other nodes. Focused tests passed: 153 pass, 0 fail.
