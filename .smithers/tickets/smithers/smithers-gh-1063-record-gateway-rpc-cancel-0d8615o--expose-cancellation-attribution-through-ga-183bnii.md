# Expose cancellation attribution through Gateway contracts

GitHub: https://github.com/smithersai/smithers/issues/1122

Parent: smithers/gh-1063-record-gateway-rpc-cancellation-attribution.md

Context: The cancelRun RPC and run-row contracts currently expose only runId/status and contain no cancellation attribution fields. Acceptance criteria: define stable typed fields and JSON/OpenAPI schemas for cancellation attribution; expose persisted attribution through getRun/listRuns and the relevant cancellation response or run event; update gateway-client types and serializers; add contract and generated-OpenAPI drift tests.
