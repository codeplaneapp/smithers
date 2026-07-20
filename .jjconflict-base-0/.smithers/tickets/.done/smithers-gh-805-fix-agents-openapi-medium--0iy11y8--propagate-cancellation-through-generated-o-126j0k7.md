# Propagate cancellation through generated OpenAPI tools

GitHub: https://github.com/smithersai/smithers/issues/1026

Parent: smithers/gh-805-fix-agents-openapi-medium-network-backed-t-12gi34i.md

Context: generated OpenAPI tools invoke executeRequest through Effect without forwarding ToolExecutionOptions.abortSignal, and fetch receives no signal. Acceptance criteria: accept execution options in generated tools; thread the signal through executeToolEffect and executeRequest; pass it to fetch while preserving metrics and error handling; add a never-settling fetch test asserting prompt rejection and underlying cancellation.


> Closed by ticket-fleet sync: Implemented in packages/openapi/src/tool-factory/_helpers.js: generated execute accepts executionOptions.abortSignal (lines 478-482), passes it through executeToolEffect and executeRequest (lines 379-387, 347), and fetch receives it as init.signal (lines 249-264). Metrics and error handling remain in place (lines 382, 390-391, 485-497). packages/openapi/tests/execution-cancellation.test.js uses a real never-settling Bun server and verifies prompt rejection, server-observed cancellation, normal completion, pre-abort behavior, backwards compatibility, and Effect fiber interruption. pnpm -C packages/openapi test passed: 192 tests, 0 failures.
