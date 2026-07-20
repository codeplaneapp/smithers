# 🐛 engine: [low] compute-callback timeout setTimeout is never cleared (ref-timer keeps event loop alive)

GitHub: https://github.com/smithersai/smithers/issues/674

_via ultracode (Opus multi-agent) review_

**Summary:** The compute-task timeout timer is never cleared, leaking one ref'd timer per compute task until its timeout window elapses.

**Location:** `packages/engine/src/engine.js:4289` (created), consumed by `await Promise.race(races)` at `packages/engine/src/engine.js:4298`.

**Details:** In the `desc.computeFn` branch, the timeout arm is built as:
```js
races.push(new Promise((_, reject) => setTimeout(() => reject(new SmithersError("TASK_TIMEOUT", ...)), desc.timeoutMs)));
```
The `setTimeout` id is never captured, and there is no `finally { clearTimeout(...) }` after the `Promise.race`. When the compute promise (or abort promise) wins, the timer stays armed and ref'd.

**Failure scenario:** A compute task with `timeoutMs = 600000` completes in 200ms. A dangling 10-minute ref'd timer remains (holding the SmithersError closure), keeping the Node event loop alive and delaying process exit. Across many compute tasks this accumulates one leaked timer per task for the remainder of each timeout window.

**Why it matters:** Concrete resource leak and delayed/blocked process exit for compute-heavy workflows with long timeouts. The correct pattern already exists in this file for the heartbeat timer (`setTimeout` at 2837, `clearTimeout` at 2888/4805).

**Fix:** Capture the timer id and `clearTimeout` it in a `finally` after `Promise.race`; optionally `.unref()` it. (Note: the later timeout rejection is already handled by `Promise.race`, so it is not an unhandled-rejection concern.)
