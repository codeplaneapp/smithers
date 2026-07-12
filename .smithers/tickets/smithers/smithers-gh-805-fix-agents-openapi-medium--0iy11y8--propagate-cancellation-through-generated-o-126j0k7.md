# Propagate cancellation through generated OpenAPI tools

GitHub: https://github.com/smithersai/smithers/issues/1026

Parent: smithers/gh-805-fix-agents-openapi-medium-network-backed-t-12gi34i.md

Context: generated OpenAPI tools invoke executeRequest through Effect without forwarding ToolExecutionOptions.abortSignal, and fetch receives no signal. Acceptance criteria: accept execution options in generated tools; thread the signal through executeToolEffect and executeRequest; pass it to fetch while preserving metrics and error handling; add a never-settling fetch test asserting prompt rejection and underlying cancellation.
