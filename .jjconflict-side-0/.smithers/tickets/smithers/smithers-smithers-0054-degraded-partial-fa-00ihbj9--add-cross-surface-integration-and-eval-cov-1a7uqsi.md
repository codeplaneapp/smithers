# Add cross-surface integration and eval coverage for degraded runs

GitHub: https://github.com/smithersai/smithers/issues/979

Parent: smithers/smithers-0054-degraded-partial-failure-run-status--propagate-degraded-outcome-through-events-gateway-.md

Context: Existing engine coverage verifies persisted failedChildren but not the complete Gateway, CLI, and DevTools contract, and no ru-run-completed-but-failed eval fixture/test is present. Acceptance criteria: run a real tolerated-failure workflow through all relevant surfaces, assert count and keys plus clean-run omission, and verify the ru-run-completed-but-failed eval passes.
