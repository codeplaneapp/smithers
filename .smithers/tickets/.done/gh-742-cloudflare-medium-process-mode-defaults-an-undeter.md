# 🐛 cloudflare: [medium] process-mode defaults an undeterminable exit status to success (should be failure)

GitHub: https://github.com/smithersai/smithers/issues/742

_via ultracode (Opus multi-agent) review_

**Summary:** In process execution mode the provider coalesces an unknown/null exit code to `0`, so a signal- or OOM-killed process can be reconciled as a successful task instead of failing loudly.

**Location:** `packages/cloudflare/src/index.js:282-284`

```js
const exitCode = Number(exit?.exitCode ?? proc.exitCode ?? 0);
if (exitCode !== 0) { throw new Error(...); }
```

**Failure scenario:** A detached process is terminated by a signal / OOM. The SDK's `waitForExit()` returns `{ exitCode: null }` (or a shape without an `exitCode` key) and `proc.exitCode` is also unset. `null ?? null ?? 0` yields `0`, the `exitCode !== 0` throw is skipped, and the provider proceeds to read and return `resultPath`. If a stale/partial-but-parseable result file is present (e.g. a reused sandbox, or the process wrote a partial bundle before dying), `parseCloudflareSandboxResult` succeeds and the killed run is recorded as a completed task.

**Why it matters:** Defaulting an undeterminable exit status to success is a durability/silent-failure trap for the engine — a crashed in-sandbox process is reconciled as done with stale content rather than surfacing for retry. Note exec mode (line 296) does the opposite: `Number(result.exitCode ?? 1)` treats an unknown exit as failure and also checks `result.success`. Process mode should match: default an undeterminable exit to non-zero (or throw when no exit info is available) rather than to `0`.


> Closed by ticket-fleet: landed on main in 80d9125f011b84b3e402c98079fdd3bc80b36027.
