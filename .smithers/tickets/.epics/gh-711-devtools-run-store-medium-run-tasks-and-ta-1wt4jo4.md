# 🐛 devtools(run-store): [medium] run.tasks and task.toolCalls grow unbounded despite runs/events being FIFO-capped

GitHub: https://github.com/smithersai/smithers/issues/711

_via ultracode (Opus multi-agent) review_

**Summary:** `DevToolsRunStore` deliberately bounds retained runs and per-run events, but leaves the per-run task read model (`run.tasks`) and per-task `toolCalls` uncapped, so a long-lived loop/supervisor run leaks memory in a monitor/inspector process.

**References:**
- `packages/devtools/src/DevToolsRunStore.js:327-334` — `ensureRun` FIFO-evicts oldest runs, comment: caps exist so a live bus "can't grow the store forever".
- `packages/devtools/src/DevToolsRunStore.js:165-167` — events spliced to `maxEventsPerRun`.
- `packages/devtools/src/DevToolsRunStore.js:344-358` — `ensureTask` inserts one `TaskExecutionState` per `${nodeId}::${iteration}` into `run.tasks` with **no cap and no eviction**.
- `packages/devtools/src/DevToolsRunStore.js:299` — `ToolCallStarted` pushes to `task.toolCalls` with **no cap**.

**Failure scenario:** A durable supervisor/loop workflow iterates thousands of times over M nodes. Each `(node, iteration)` yields a distinct `run.tasks` entry that is never evicted — thousands×M entries — even though the same run's event log is trimmed to `maxEventsPerRun`. An agent node making tens of thousands of tool calls grows `task.toolCalls` without bound. In a long-running `smithers monitor`/inspector attached to such a run, heap climbs indefinitely while the capped events falsely imply bounded memory. `getTaskState` (lines 143-155) confirms multiple iterations coexist per node, so the growth is real, not overwrite.

**Why it matters:** Inconsistent, easy-to-miss retention gap. The code explicitly bounds runs and events for memory, but the task/tool-call read model — proportional to iterations, not node count — is the one uncapped growth vector, so the memory guarantee the caps imply does not actually hold for long-running loop workflows. Fix: add an analogous cap/eviction (e.g. `maxTasksPerRun`, `maxToolCallsPerTask`) resolved via `resolveCap`.
