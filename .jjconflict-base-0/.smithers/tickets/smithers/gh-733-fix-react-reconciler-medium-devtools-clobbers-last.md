# 🐛 fix(react-reconciler): [medium] devtools clobbers last-good snapshot with a null tree on foreign / Workflow-less commits

GitHub: https://github.com/smithersai/smithers/issues/733

_via ultracode (Opus multi-agent) review_

`SmithersDevTools.onCommitFiberRoot` updates the snapshot from every renderer's commit — including ones that contain no Smithers tree — resetting the last good snapshot to an empty one.

**Where**
- `packages/react-reconciler/src/devtools/SmithersDevTools.js:239` — `onCommitFiberRoot(rendererID, root)` ignores `rendererID`; the bippy hook is process-global so this runs for *every* React renderer's commit.
- `:240-241` — `findSmithersRoot(root)` returns `null` when the committing root has no `smithers:workflow` fiber (a second renderer such as react-dom, or a Smithers subtree rendered without a top-level `<Workflow>`), so `tree` is `null`.
- `:242` — `self.core.captureSnapshot(null)` runs unconditionally. `captureSnapshot` (`packages/devtools/src/SmithersDevToolsCore.js:33-37`) sets `_lastSnapshot = buildSnapshot(null)`, and `buildSnapshot(null)` (`packages/devtools/src/buildSnapshot.js:9-12`) returns `{ tree: null, nodeCount: 0, taskCount: 0 }` — overwriting the previously captured valid snapshot.
- `:248` — `emitCommit(snapshot)` then fires `onCommit("commit", <empty snapshot>)`.

**Failure scenario**
In any process where a second React renderer commits after a valid workflow snapshot was captured (devtools used in a mixed react-dom + Smithers host, or any secondary reconciler root), the next foreign commit resets `SmithersDevTools.tree`/`.snapshot` (getters at `SmithersDevToolsCore.js:108,115`) to `null` and emits a `"commit"` reporting 0 nodes / 0 tasks. The devtools/monitor view goes empty until the next real workflow commit repopulates it.

**Why it matters**
The snapshot should only update from commits that actually contain a Smithers tree. Because `@smithers-orchestrator/react-reconciler/devtools` is a public export and the RDT hook is process-global, letting unrelated commits null it out makes the snapshot unreliable in any multi-renderer host. Guard the capture/emit on `smithersRoot` (skip when `!smithersRoot`), i.e. only `captureSnapshot`/`emitCommit` when a Smithers tree is present.
