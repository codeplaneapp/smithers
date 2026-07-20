# Propagate AI SDK abortSignal through createHttpTool requests

GitHub: https://github.com/smithersai/smithers/issues/919

Update createHttpTool so execute accepts ToolExecutionOptions, composes abortSignal with the input timeout, and passes the resulting signal to fetch. Add a test that aborts a never-settling request, asserts rejection, and verifies the fetch signal is aborted.


> Closed by ticket-fleet sync: packages/agents/src/http/createHttpTool.js:37-38 accepts executionOptions and forwards abortSignal; lines 63-65 compose it with timeout; lines 82-85 pass the resulting signal to fetch. packages/agents/tests/http-tool-abort.test.js:66-85 uses a real never-settling server, aborts the ToolExecutionOptions signal, asserts AbortError and prompt rejection, and verifies connection cancellation. Additional tests at lines 87-123 cover signal/timeout composition and preserved timeout behavior. The targeted test passed: 4 pass, 0 fail.
