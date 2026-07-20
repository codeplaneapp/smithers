# Add a runnable multi-table childRun contract example

GitHub: https://github.com/smithersai/smithers/issues/890

Add a typed example or end-to-end test where a child workflow writes multiple output tables and a parent Subflow schema matches the child's final task row. Assert that the parent receives that row, not a table-keyed snapshot, providing a maintained reference for which child output shape is required.


> Closed by ticket-fleet sync: Implemented in examples/subflow-multi-output.jsx: the child writes draft, stats, and decision tables, declares decision as its output, and the parent Subflow schema matches the decision row. The executable regression test packages/engine/tests/subflow-childrun-multi-output.e2e.test.jsx asserts the parent receives the final row rather than a table-keyed snapshot, including downstream consumption. Targeted test passed: 1 pass, 0 fail, 11 expect() calls. The contract is also documented in docs/components/subflow.mdx:124-149 and packages/components/src/components/SubflowProps.ts:20-32.
