# Propagate degraded outcome through events, Gateway, CLI, and DevTools

GitHub: https://github.com/smithersai/smithers/issues/824

Parent: smithers/0054-degraded-partial-failure-run-status.md

Context: RunFinished currently persists failed-child fields, but the Gateway run.completed mapping drops them and no complete cross-surface contract is tested. Acceptance criteria: persist a terminal event carrying failed-child count and keys; expose the fields through Gateway, CLI, and DevTools without re-deriving node rows; add integration coverage and verify the ru-run-completed-but-failed eval.
