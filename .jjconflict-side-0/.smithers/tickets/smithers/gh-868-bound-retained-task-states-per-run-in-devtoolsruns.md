# Bound retained task states per run in DevToolsRunStore

GitHub: https://github.com/smithersai/smithers/issues/868

Add a configurable maxTasksPerRun retention cap to DevToolsRunStore and the public SmithersDevToolsOptions/DevToolsRunStoreOptions types. Resolve it with the existing cap semantics and FIFO-evict the oldest run.tasks entries when new node iterations exceed the cap. Add tests covering iteration growth, FIFO retention, Infinity, and invalid-cap behavior.
