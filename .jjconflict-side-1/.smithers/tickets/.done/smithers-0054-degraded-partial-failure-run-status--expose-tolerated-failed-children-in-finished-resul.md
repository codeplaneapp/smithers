# Expose tolerated failed children in finished results and inspect

GitHub: https://github.com/smithersai/smithers/issues/822

Parent: smithers/0054-degraded-partial-failure-run-status.md

Context: Finished runs can contain tolerated continueOnFail or transient agent failures that are otherwise indistinguishable from clean success. Acceptance criteria: finished RunResult includes failedChildren and failedChildKeys; smithers inspect includes those fields and a node inspection CTA; clean runs omit the fields; continueOnFail and transient-failure regression tests pass.


> Closed by ticket-fleet sync: Implemented in packages/scheduler/src/makeWorkflowSession.js:427-435, typed in packages/driver/src/RunResult.ts:9-21, propagated by packages/engine/src/engine.js:6144-6172, and exposed by apps/cli/src/index.js:1453-1556 with a node inspection CTA. Regression tests cover continueOnFail, transient SESSION_ERROR failures, and clean omission in packages/scheduler/tests/workflowSession-degraded.test.js:44-107; engine and RunFinished propagation are covered in packages/engine/tests/run-options-lifecycle.e2e.test.jsx:238-284. Targeted tests passed: 53 pass, 0 fail.
