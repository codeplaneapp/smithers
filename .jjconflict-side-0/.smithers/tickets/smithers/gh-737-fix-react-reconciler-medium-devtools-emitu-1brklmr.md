# 🐛 fix(react-reconciler): [medium] devtools emitUnmount fires onCommit("unmount") for every fiber with a stale snapshot

GitHub: https://github.com/smithersai/smithers/issues/737

_via ultracode (Opus multi-agent) review_

The devtools `onCommitFiberUnmount` handler emits the public `onCommit("unmount", …)` callback for every unmounted fiber, not just Smithers nodes, and passes a stale pre-removal snapshot.

**Where**
- `packages/react-reconciler/src/devtools/SmithersDevTools.js:256-261` — `resolveNodeType(fiber)` gates only the verbose `console.log` (256-260); `self.core.emitUnmount()` on line 261 is unconditional.
- `packages/devtools/src/SmithersDevToolsCore.js:59-61` — `emitUnmount(snapshot = this._lastSnapshot ?? …)` calls `this.options.onCommit?.("unmount", snapshot)`.

**Failure scenario**
`resolveNodeType` returns `null` for anything that isn't a host `smithers:*` fiber (lines 41-50), yet the emission ignores it. Calling `hook.onCommitFiberUnmount(1, <function-component fiber>)` and `hook.onCommitFiberUnmount(1, <"div" host fiber>)` both push a `"unmount"` event — the `onCommit` callback receives `["unmount","unmount"]` for two non-Smithers fibers, plus any foreign-renderer fiber sharing the global hook. React calls this handler once per deleted fiber, so removing one `<Task>` subtree emits multiple `"unmount"` events (composite + host + descendants). Because `onCommitFiberUnmount` runs during `commitMutationEffects` before `onCommitFiberRoot` re-captures, `_lastSnapshot` is the previous commit and still contains the node being removed — the callback fires with garbage.

**Why it matters**
`onCommit` is the public devtools/observability integration point. This over-fires it (unlike the once-per-commit `emitCommit` path at line 248) with a stale tree, corrupting any consumer that counts or diffs on unmount, and is a perf drain on large trees. The sibling `console.log` being gated by `nodeType` shows the emission was meant to be gated too. Existing test `packages/react-reconciler/tests/reconciler-coverage.test.jsx:142` only exercises the log gating for a `smithers:workflow` fiber and never asserts emission gating.
