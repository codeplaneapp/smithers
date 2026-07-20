# Document the childRun last-task output contract

GitHub: https://github.com/smithersai/smithers/issues/1004

Parent: smithers/gh-768-subflow-mode-childrun-output-is-the-child--0eqwmrr.md

Context: childRun persists the child workflow's normalized RunResult.output, which represents the child's final task output rather than a table-keyed snapshot. The current Subflow type comment and page do not make this shape explicit. Acceptance criteria: update docs/components/subflow.mdx and the output jsdoc in packages/components/src/components/SubflowProps.ts to state that childRun output is the child's last task row, explain array/null normalization where relevant, distinguish it from a table-keyed snapshot, and warn that adding or changing the child's final task changes the parent's expected schema. Add or update documentation validation coverage if applicable.


> Closed by ticket-fleet sync: docs/components/subflow.mdx:124-149 and packages/components/src/components/SubflowProps.ts:20-33 document the last-task RunResult.output contract, null/single-row/array normalization, absence of table-keyed snapshots, and parent schema changes. scripts/check-docs.mjs:2249-2299 adds and invokes a dedicated validation guard, which passed. bun test packages/engine/tests/child-workflow.test.js passed 3 tests, and packages/engine/tests/subflow-childrun-multi-output.e2e.test.jsx passed 1 test covering final-row propagation. The full docs check reports unrelated failures elsewhere, but the Subflow contract check passes.
