# Add a degraded terminal run status and RunState mapping

GitHub: https://github.com/smithersai/smithers/issues/823

Parent: smithers/0054-degraded-partial-failure-run-status.md

Context: The current runtime remains binary and maps every finished run to succeeded, even when failedChildren is nonzero. Acceptance criteria: add a documented degraded or partial terminal status to scheduler and engine schemas; persist and expose a distinct RunState such as succeeded-with-failures; preserve terminal/non-fatal continueOnFail behavior; verify existing finished-success consumers remain compatible.
