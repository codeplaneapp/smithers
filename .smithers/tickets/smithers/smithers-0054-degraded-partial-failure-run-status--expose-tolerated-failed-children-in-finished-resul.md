# Expose tolerated failed children in finished results and inspect

GitHub: https://github.com/smithersai/smithers/issues/822

Parent: smithers/0054-degraded-partial-failure-run-status.md

Context: Finished runs can contain tolerated continueOnFail or transient agent failures that are otherwise indistinguishable from clean success. Acceptance criteria: finished RunResult includes failedChildren and failedChildKeys; smithers inspect includes those fields and a node inspection CTA; clean runs omit the fields; continueOnFail and transient-failure regression tests pass.
