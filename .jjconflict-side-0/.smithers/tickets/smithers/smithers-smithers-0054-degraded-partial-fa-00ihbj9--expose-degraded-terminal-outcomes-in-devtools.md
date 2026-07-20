# Expose degraded terminal outcomes in DevTools

GitHub: https://github.com/smithersai/smithers/issues/978

Parent: smithers/smithers-0054-degraded-partial-failure-run-status--propagate-degraded-outcome-through-events-gateway-.md

Context: DevTools RunFinished types and RunExecutionState do not model failedChildren or failedChildKeys; the reducer records only finished status and timestamp. Acceptance criteria: add typed optional fields, copy them into the DevTools run state/snapshot from the terminal event without node-row reconstruction, and add degraded and clean-run reducer tests.
