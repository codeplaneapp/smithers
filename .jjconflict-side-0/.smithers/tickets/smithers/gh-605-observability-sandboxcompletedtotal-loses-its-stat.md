# 🐛 observability: sandboxCompletedTotal loses its status tag when the event has no runtime

GitHub: https://github.com/smithersai/smithers/issues/605

**What happens**
`apps/observability/src/metrics/trackEvent.js:290-293` (SandboxCompleted case):
```js
const byRuntime = event.runtime && event.runtime.length > 0
    ? Metric.tagged(Metric.tagged(sandboxCompletedTotal, "runtime", event.runtime), "status", event.status)
    : sandboxCompletedTotal;
```
The `status` tag is only applied inside the runtime-present branch; when `runtime` is empty the bare counter increments with no tags at all.

**Why it's wrong**
`event.status` is always available on SandboxCompleted, and the catalog declares `sandboxCompletedTotal` with labels `["runtime", "status"]`. Completions without a runtime silently lose the success/failure breakdown. Compare SandboxCreated (`trackEvent.js:269-272`), which correctly conditionally tags only `runtime`.

**Expected behavior**
Tag `status` unconditionally; tag `runtime` only when present.

Found during the 2026-07 repo-wide cleanup sweep (automated analyzer, human-unverified).
