# Compile approval collection filters for multiplayer Electric

GitHub: https://github.com/smithersai/smithers/issues/899

Update the multiplayer approvals collection to honor runId, workflow, and limit filters consistently with listApprovals. Use validated predicates or RPC fallback where needed, then test local/multiplayer parity across all approval filters.


> Closed by ticket-fleet sync: Implemented in packages/gateway-client/src/data/createSmithersCollections.ts:201-208 and 564-613. runId uses validated Electric predicates; workflow and limit fall back to the RPC-backed collection using listApprovals(params). packages/gateway-client/tests/data/collectionsFilterParity.test.ts covers pending/runId parity, workflow/limit fallback, and multiplayer routing; targeted tests passed 14/14. Related multiplayer/provider tests also passed 7/7.
