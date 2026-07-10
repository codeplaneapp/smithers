# Propagate AI SDK abortSignal through generated OpenAPI tools

GitHub: https://github.com/smithersai/smithers/issues/922

Pass ToolExecutionOptions.abortSignal from generated OpenAPI tool execute functions through Effect execution into executeRequest and fetch. Add a cancellation test using a never-settling fetch and assert the request signal is aborted and the tool rejects.
