# Bound retained task states per run in DevToolsRunStore

GitHub: https://github.com/smithersai/smithers/issues/1072

Parent: smithers/gh-711-devtools-run-store-medium-run-tasks-and-ta-1wt4jo4.md

Context: DevToolsRunStore creates one run.tasks entry for each nodeId and iteration, so long-running loop or supervisor workflows retain unbounded task state. Acceptance criteria: add configurable maxTasksPerRun to DevToolsRunStore and the public SmithersDevToolsOptions and DevToolsRunStoreOptions types; resolve it using the existing resolveCap semantics, including Infinity and invalid values; FIFO-evict the oldest run.tasks entries when new iterations exceed the cap; add tests covering iteration growth, FIFO retention, Infinity, and invalid-cap behavior.
