# Add complete Monitor run-list loading and query-error handling

GitHub: https://github.com/smithersai/smithers/issues/958

Parent: smithers/gh-855-add-complete-monitor-loading-empty-and-error-state.md

Context: The Monitor displays loading placeholders, but the runs collection hook returns error: undefined and App only consumes loading. Acceptance criteria: 1. Initial list loading is visibly distinct from an empty successful result. 2. Failed list queries render a consistent error state with the failure message and retry action. 3. Refetching preserves usable last-known rows where available. 4. Failed refreshes do not become “No runs match.” 5. Add tests for initial loading, empty success, populated success, and failed query states.
