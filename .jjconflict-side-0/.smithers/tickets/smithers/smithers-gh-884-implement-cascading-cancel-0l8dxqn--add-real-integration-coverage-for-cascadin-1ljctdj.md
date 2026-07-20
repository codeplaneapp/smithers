# Add real integration coverage for cascading cancellation and orphan reaping

GitHub: https://github.com/smithersai/smithers/issues/973

Parent: smithers/gh-884-implement-cascading-cancellation-and-orphan-proces.md

Context: Existing coverage proves single-run cancellation, ancestry traversal, and isolated detached timeout cleanup, but does not prove that cancelling a parent cleans up child runs or real agent processes.

Acceptance criteria:
- Use the real database, engine, child-workflow path, public cancellation surface, and real OS child processes; do not mock gateway data or fabricate process state.
- Cover nested descendants in live, waiting, paused, and stale/ownerless states, including cancellation during detached ownership.
- Assert that the parent and every descendant converge to the expected terminal state, no active runtime owners remain, and every spawned agent/process-tree PID is gone.
- Include race/idempotency assertions and run the relevant SQLite/Postgres paths where supported.
