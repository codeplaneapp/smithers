# 🐛 devtools(run-store): [medium] ToolCallStarted is not replay-idempotent — full-log replay duplicates every tool call

GitHub: https://github.com/smithersai/smithers/issues/713

_via ultracode (Opus multi-agent) review_

**Summary:** `ToolCallStarted` blind-pushes to `task.toolCalls` with no `(name, seq)` dedup, violating the store's tested full-log replay-idempotency contract that every other reducer upholds.

**Location:** `packages/devtools/src/DevToolsRunStore.js:299`

```js
case "ToolCallStarted": {
    const task = this.ensureTask(run, event.nodeId, event.iteration);
    task.toolCalls.push({ name: event.toolName, seq: event.seq }); // no dedup, no terminal guard
    break;
}
```

**Failure scenario:**
1. Task emits `ToolCallStarted{toolName:'search', seq:1}` then `ToolCallFinished{seq:1, status:'success'}` → `toolCalls === [{search,1,success}]`.
2. A UI reconnects and replays the run's event log (modeled by `DevToolsRunStore.test.ts:478`/`512`, which re-feed the full event array a second time "as a reconnect-after-seq replay would").
3. Replay re-runs `ToolCallStarted` → pushes again → `[{search,1,success},{search,1}]`. The replayed `ToolCallFinished`'s `find()` (line 304) matches only the first duplicate, so the second entry never gets a `status`.
4. N replays → N copies. Tool-call lists/counts shown to the operator inflate.

**Why it matters:** The store's whole contract is that replaying the event log converges to the same read model as a single clean pass — explicitly asserted for run and task state at `DevToolsRunStore.test.ts:337, 359, 478, 512`, and every sibling reducer guards for it (`isTerminalTask` at lines 199/207/219/232/246/254/272/282/289). Tool calls silently break the invariant, and the existing idempotency tests contain no `ToolCallStarted` events so the regression is uncaught. Fix: upsert by `(name, seq)` instead of blind push (and mirror the terminal-guard pattern), plus extend the double-pass idempotency test to include tool-call events.
