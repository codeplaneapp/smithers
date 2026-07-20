# Exercise case08 inspector state through the real product path

GitHub: https://github.com/smithersai/smithers/issues/831

Parent: smithers/cov-11-case08-inspector-and-case24-replay-safety-are-hy.md

Context: The legacy case08 fault test fabricates an in-memory SQLite database and invokes deriveRunState directly, so it does not validate the complete workflow-to-durable-database-to-inspector path. Acceptance criteria: boot representative workflows with createSmithers and a real on-disk database, obtain persisted runs through SmithersDb and the production inspector read path, cover active, waiting, and terminal states, and assert that no state is idle-like. Do not use direct fabricated SQL as the system under test.
