# Document the childRun last-task output contract

GitHub: https://github.com/smithersai/smithers/issues/1004

Parent: smithers/gh-768-subflow-mode-childrun-output-is-the-child--0eqwmrr.md

Context: childRun persists the child workflow's normalized RunResult.output, which represents the child's final task output rather than a table-keyed snapshot. The current Subflow type comment and page do not make this shape explicit. Acceptance criteria: update docs/components/subflow.mdx and the output jsdoc in packages/components/src/components/SubflowProps.ts to state that childRun output is the child's last task row, explain array/null normalization where relevant, distinguish it from a table-keyed snapshot, and warn that adding or changing the child's final task changes the parent's expected schema. Add or update documentation validation coverage if applicable.
