# Add resume-safe child relaunch and deduplication

GitHub: https://github.com/smithersai/smithers/issues/886

Define stable child identity or idempotency semantics so a resumed or relaunched parent reattaches to existing child runs instead of creating duplicate fan-out. Add crash, resume, and duplicate-launch tests.


> Closed by ticket-fleet sync: Implemented in packages/engine/src/child-workflow.js with deterministic child IDs, preserved terminal results, live-child attachment, stale-owner resume, and nested identity composition. packages/engine/src/task-compute-fns.js applies this to Subflow execution. Tests in child-workflow-prefer-resume.test.jsx cover restart, crash recovery, duplicate prevention, live attachment, retries, and nested grandchildren; dynamic-workflow-file-subflow.e2e.test.jsx covers cancellation/resume with one child run. Targeted execution passed: 16 tests, 0 failures.
