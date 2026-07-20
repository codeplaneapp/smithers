# Make childRun output validation errors actionable

GitHub: https://github.com/smithersai/smithers/issues/889

Improve INVALID_OUTPUT errors for Subflow output schema mismatches so they include formatted Zod issues and the received value's top-level keys, in both the error message and durable error details where appropriate. Add regression tests covering expected/received shape diagnostics and retries={0}.


> Closed by ticket-fleet sync: Implemented in packages/engine/src/output-validation-diagnostics.js and wired through engine.js, compute-task-bridge.js, and static-task-bridge.js. INVALID_OUTPUT messages include formatted Zod issue paths, expected/received data, and received top-level keys; durable details include issues, receivedKeys, and receivedDescription. Regression coverage is in packages/engine/tests/childrun-output-validation-diagnostics.e2e.test.jsx and output-validation-diagnostics.test.js, including Subflow retries={0}. Targeted tests passed: 14 tests, 0 failures.
