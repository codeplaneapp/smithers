# Deferred `DecisionReported` event

The decisions ledger reads durable approval, ask-human, and memory provenance
tables directly. A first-class `DecisionReported` event is deferred because it
would change the engine event union, event category parser, event-type docs,
and observability event type together. Its proposed payload is `{runId,nodeId,
iteration,kind,status,requestedAtMs,resolution,detail}`.

The interim idiom is ask-human requests (normally kind `ask`) plus memory facts
stamped with run provenance. Facts are labelled as recorded with this run's
provenance: legacy writers did not stamp `run_id` and are not inferred.

`GET /v1/api/runs/:id/decisions` is an HTTP-mapped monitor read like
`listNodeStates` and `listHijackCandidates`: it is deliberately NOT in
`GATEWAY_RPC_DEFINITIONS`, so no protocol types, OpenAPI artifact, or
`docs/rpc/` page exist for it and the auth scope falls back to the gateway's
`run:read` default. Promoting it to a catalogued RPC later means updating the
registry, the hardcoded definition count in `scripts/check-docs.mjs`, the
generated OpenAPI/declaration artifacts, and regenerating the llms bundles
together.
