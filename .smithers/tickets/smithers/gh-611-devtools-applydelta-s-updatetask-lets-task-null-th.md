# 🐛 devtools: applyDelta's updateTask lets `task: null` through validation, producing a type-violating snapshot

GitHub: https://github.com/smithersai/smithers/issues/611

**What happens**
`packages/devtools/src/applyDelta.js:113-121`:
```js
if (op.task === undefined) { delete target.node.task; }
else if (typeof op.task !== "object") { throw new InvalidDeltaError(...); }
else { target.node.task = cloneValue(op.task); }
```
Since `typeof null === "object"`, an op `{ op: "updateTask", id, task: null }` passes validation and assigns `task = null`.

**Why it's wrong / failure scenario**
`DevToolsNode` declares `task?: { nodeId: string; ... }` — object or absent, never null. Downstream truthiness checks (`if (node.task)` in printTree) happen to tolerate null, but the snapshot no longer matches its declared type, and structural comparison (deepEqual in diffSnapshots) treats `task: null` and missing `task` as different — a null-task delta can make otherwise-identical snapshots compare unequal. Neither applyDelta.test.ts nor applyDelta-edge-cases.test.ts covers a null task.

**Expected behavior**
Treat `null` like `undefined` (delete the field), or reject it with InvalidDeltaError. Add a test either way.

Found during the 2026-07 repo-wide cleanup sweep (automated analyzer, human-unverified).
