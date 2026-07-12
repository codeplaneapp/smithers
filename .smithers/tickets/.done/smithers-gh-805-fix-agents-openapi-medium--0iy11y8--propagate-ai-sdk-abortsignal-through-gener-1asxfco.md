# Propagate AI SDK abortSignal through generic HTTP tools

GitHub: https://github.com/smithersai/smithers/issues/1023

Parent: smithers/gh-805-fix-agents-openapi-medium-network-backed-t-12gi34i.md

Context: createHttpTool currently accepts only tool input and uses an independent timeout controller, so AI SDK cancellation cannot abort fetch. Acceptance criteria: accept ToolExecutionOptions in execute; compose the supplied abortSignal with the optional input timeout; pass the composed signal to fetch; preserve timeout behavior and cleanup; add a test using a never-settling fetch that verifies prompt rejection and underlying cancellation.


> Closed by ticket-fleet sync: Implemented in packages/agents/src/http/createHttpTool.js:37-38, where execute accepts executionOptions and forwards abortSignal; lines 63-65 compose it with the optional timeout signal via AbortSignal.any; lines 82-85 pass the composed signal to fetch; lines 114-117 clear the timeout. packages/agents/tests/http-tool-abort.test.js uses a real never-settling server and verifies prompt rejection plus underlying cancellation, composed timeout behavior, timeout preservation, and pre-aborted signals. Targeted test passed: 4 tests, 10 assertions, 0 failures.
