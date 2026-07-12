# Bound retained tool calls per task in DevToolsRunStore

GitHub: https://github.com/smithersai/smithers/issues/1073

Parent: smithers/gh-711-devtools-run-store-medium-run-tasks-and-ta-1wt4jo4.md

Context: ToolCallStarted appends indefinitely to each task.toolCalls array, so agent tasks with many tool calls can grow the monitor read model without bound. Acceptance criteria: add configurable maxToolCallsPerTask to DevToolsRunStore and the public option types; resolve it using the existing cap semantics; FIFO-trim toolCalls when ToolCallStarted exceeds the cap while preserving status updates for retained calls; add tests proving old calls are evicted, recent calls remain, and Infinity and invalid-cap behavior are correct.
