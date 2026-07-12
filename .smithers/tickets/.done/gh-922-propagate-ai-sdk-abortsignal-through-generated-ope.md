# Propagate AI SDK abortSignal through generated OpenAPI tools

GitHub: https://github.com/smithersai/smithers/issues/922

Pass ToolExecutionOptions.abortSignal from generated OpenAPI tool execute functions through Effect execution into executeRequest and fetch. Add a cancellation test using a never-settling fetch and assert the request signal is aborted and the tool rejects.


> Closed by ticket-fleet sync: Implemented in packages/openapi/src/tool-factory/_helpers.js: execute accepts executionOptions.abortSignal (lines 478-482), combines it with the Effect fiber signal (379-387), and passes it through executeRequest to fetch (301, 347). packages/openapi/tests/execution-cancellation.test.js provides a real never-settling /hang server and verifies prompt rejection, server-observed abort, pre-abort behavior, normal completion, and fiber interruption. Targeted test passed: 5 tests, 0 failures.
