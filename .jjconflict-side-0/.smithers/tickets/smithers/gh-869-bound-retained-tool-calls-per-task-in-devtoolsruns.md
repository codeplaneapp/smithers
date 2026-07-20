# Bound retained tool calls per task in DevToolsRunStore

GitHub: https://github.com/smithersai/smithers/issues/869

Add a configurable maxToolCallsPerTask retention cap to DevToolsRunStore and the public option types. Enforce FIFO trimming when ToolCallStarted appends beyond the cap while preserving status updates for retained calls. Add tests proving old calls are evicted, recent calls remain, and cap edge cases follow existing resolveCap semantics.
