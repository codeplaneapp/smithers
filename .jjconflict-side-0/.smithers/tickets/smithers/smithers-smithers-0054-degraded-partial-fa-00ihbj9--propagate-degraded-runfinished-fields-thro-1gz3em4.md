# Propagate degraded RunFinished fields through Gateway

GitHub: https://github.com/smithersai/smithers/issues/976

Parent: smithers/smithers-0054-degraded-partial-failure-run-status--propagate-degraded-outcome-through-events-gateway-.md

Context: The engine persists failedChildren and failedChildKeys on RunFinished, but Gateway mapEvent and run contracts omit them. Acceptance criteria: preserve the fields in run.completed event payloads and Gateway run snapshots/getRun responses, omit them consistently for clean runs, and add mapping and integration tests covering count and keys.
