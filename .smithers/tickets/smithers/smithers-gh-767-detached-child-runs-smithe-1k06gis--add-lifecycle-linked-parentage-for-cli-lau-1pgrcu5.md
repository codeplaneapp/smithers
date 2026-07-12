# Add lifecycle-linked parentage for CLI-launched child runs

GitHub: https://github.com/smithersai/smithers/issues/1000

Parent: smithers/gh-767-detached-child-runs-smithers-up-detach-orp-07nrnmp.md

Context: Engine-created Subflow runs persist parentRunId, but smithers up --detach cannot declare or propagate a parent. Acceptance criteria: add a supported parent-run option or API; validate and persist the relationship; propagate it through detached process arguments and RunOptions; expose it in inspection/list/tree surfaces; add integration tests for detached and nested child launches.
