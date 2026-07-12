# Propagate AI SDK abortSignal through generic HTTP tools

GitHub: https://github.com/smithersai/smithers/issues/1023

Parent: smithers/gh-805-fix-agents-openapi-medium-network-backed-t-12gi34i.md

Context: createHttpTool currently accepts only tool input and uses an independent timeout controller, so AI SDK cancellation cannot abort fetch. Acceptance criteria: accept ToolExecutionOptions in execute; compose the supplied abortSignal with the optional input timeout; pass the composed signal to fetch; preserve timeout behavior and cleanup; add a test using a never-settling fetch that verifies prompt rejection and underlying cancellation.
