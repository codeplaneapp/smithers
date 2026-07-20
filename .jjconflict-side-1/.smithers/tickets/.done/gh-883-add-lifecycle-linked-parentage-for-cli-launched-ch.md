# Add lifecycle-linked parentage for CLI-launched child runs

GitHub: https://github.com/smithersai/smithers/issues/883

Add a supported parent-run option or engine API for detached child launches. Persist and validate the parentRunId, propagate it through detached process arguments, and expose the relationship in run inspection. Add integration tests proving dynamically launched children are linked to their parent.


> Closed by ticket-fleet sync: Implemented in apps/cli/src/index.js: --parent-run-id is supported, validated for non-empty/self-parent/resume conflicts, parent existence is checked, and detached launches forward the option. packages/engine/src/engine.js persists parentRunId in the run row. Inspect and ps expose parentRunId. apps/cli/tests/up-parent-run-id.e2e.test.js covers foreground, detached, nested lineage, persistence, inspection, ps, unknown-parent, self-parent, and resume validation; it passes with 4 tests and 0 failures.
