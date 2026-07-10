# Document the childRun Subflow output contract

GitHub: https://github.com/smithersai/smithers/issues/888

Update Subflow documentation and SubflowProps output JSDoc to state that mode="childRun" stores the child workflow result, which is the child run's selected/last task output row rather than a table-keyed snapshot. Document the empty and multi-row cases and explain that adding or changing the child's final task can change the parent's expected schema.
