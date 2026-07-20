# Document the childRun Subflow output contract

GitHub: https://github.com/smithersai/smithers/issues/888

Update Subflow documentation and SubflowProps output JSDoc to state that mode="childRun" stores the child workflow result, which is the child run's selected/last task output row rather than a table-keyed snapshot. Document the empty and multi-row cases and explain that adding or changing the child's final task can change the parent's expected schema.


> Closed by ticket-fleet sync: Implemented in docs/components/subflow.mdx:124-149 and packages/components/src/components/SubflowProps.ts:20-34, covering last-task output, non-table-keyed shape, empty/null, single-row, multi-row, and schema-change cases. Behavior is implemented by normalizeChildOutput in packages/engine/src/child-workflow.js:72-81. Passing tests: packages/engine/tests/child-workflow.test.js, packages/engine/tests/subflow-childrun-multi-output.e2e.test.jsx, and packages/engine/tests/childrun-output-validation-diagnostics.e2e.test.jsx. The targeted contract check in scripts/check-docs.mjs also passes.
