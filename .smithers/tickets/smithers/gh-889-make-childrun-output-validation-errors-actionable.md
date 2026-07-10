# Make childRun output validation errors actionable

GitHub: https://github.com/smithersai/smithers/issues/889

Improve INVALID_OUTPUT errors for Subflow output schema mismatches so they include formatted Zod issues and the received value's top-level keys, in both the error message and durable error details where appropriate. Add regression tests covering expected/received shape diagnostics and retries={0}.
