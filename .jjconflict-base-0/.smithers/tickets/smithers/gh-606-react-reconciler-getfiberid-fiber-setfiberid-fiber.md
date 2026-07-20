# 🧹 react-reconciler: `getFiberId(fiber) ?? setFiberId(fiber)` fallback would assign an undefined DevTools node id

GitHub: https://github.com/smithersai/smithers/issues/606

**What happens**
`packages/react-reconciler/src/devtools/SmithersDevTools.js:156`:
```js
const id = getFiberId(fiber) ?? setFiberId(fiber);
```
In bippy (0.5.39/0.5.42), `setFiberId(fiber, id?)` returns `void` (`bippy/dist/core.d.ts:437`), so if the fallback ever ran, `id` would be `undefined` and `fiberToNode` would emit a DevToolsNode with `id: undefined`.

**Why it's wrong**
The expression encodes a wrong assumption about setFiberId's return value. It is unreachable today only because bippy's `getFiberId` auto-generates and returns a number for unseen fibers — a bippy behavior change would silently produce id-less nodes in the DevTools tree.

**Expected behavior**
Either `getFiberId(fiber)` alone (relying on its auto-generate contract), or an explicit generate-and-return (`setFiberId(fiber, newId); return newId`).

Latent — not observable today.

Found during the 2026-07 repo-wide cleanup sweep (automated analyzer, human-unverified).
