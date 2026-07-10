# Add a runnable multi-table childRun contract example

GitHub: https://github.com/smithersai/smithers/issues/890

Add a typed example or end-to-end test where a child workflow writes multiple output tables and a parent Subflow schema matches the child's final task row. Assert that the parent receives that row, not a table-keyed snapshot, providing a maintained reference for which child output shape is required.
