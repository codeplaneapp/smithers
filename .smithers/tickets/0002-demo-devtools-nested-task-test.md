# Demo: add a nested DevTools tree unit test

Add one focused unit test to `packages/devtools/tests/treeUtilities.test.ts`.

Required change:

- Add a test under the existing `collectTasks` suite that verifies `collectTasks` returns tasks in stable depth-first order when a task is nested inside an extra child container, such as a `sequence` inside the existing `parallel` branch.

Constraints:

- Keep the change limited to `packages/devtools/tests/treeUtilities.test.ts`.
- Do not change production code unless the new test exposes a real bug.
- Run `bun test packages/devtools/tests/treeUtilities.test.ts` and report the result.
