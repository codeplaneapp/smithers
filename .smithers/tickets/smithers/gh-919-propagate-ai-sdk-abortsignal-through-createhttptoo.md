# Propagate AI SDK abortSignal through createHttpTool requests

GitHub: https://github.com/smithersai/smithers/issues/919

Update createHttpTool so execute accepts ToolExecutionOptions, composes abortSignal with the input timeout, and passes the resulting signal to fetch. Add a test that aborts a never-settling request, asserts rejection, and verifies the fetch signal is aborted.
