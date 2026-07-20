# 🐛 graph(extract): [medium] string timeoutMs/heartbeatTimeoutMs props silently dropped instead of coerced

GitHub: https://github.com/smithersai/smithers/issues/704

_via ultracode (Opus multi-agent) review_

**Summary:** `timeoutMs` and `heartbeatTimeoutMs` are accepted only when already `typeof === "number"`, so string-valued props (from MDX attributes or untyped JS workflows) are silently discarded instead of coerced with `Number()` like the sibling concurrency props.

**Locations** (`packages/graph/src/extract.js`):
- `timeoutMs: typeof raw.timeoutMs === "number" ? raw.timeoutMs : null` — lines 484 (subflow), 517 (sandbox), 565 (wait-for-event), 696 (task)
- `parseHeartbeatTimeoutMs` — lines 86-96 (requires `typeof === "number"`), used at 485, 518, 566, 673
- Contrast: `Number(raw.maxConcurrency)` at line 285 ("Coerce numeric strings (e.g. from MDX)…") and `Number(raw.subtreeConcurrency)` at line 310 — these ARE coerced.

**Failure scenario:** `<Task ... timeoutMs="60000" heartbeatTimeoutMs="120000">` authored in MDX (or a plain JS workflow, or a stringified-literal typo). rawProps is `Record<string, unknown>` and is not globally coerced (types.ts:23), so both values arrive as strings. `timeoutMs` resolves to `null` (no wall-clock timeout at all) and `heartbeatTimeoutMs` falls back to `DEFAULT_LOCAL_TASK_HEARTBEAT_TIMEOUT_MS` (10-min agent default). The author's 60s timeout and 120s heartbeat are silently ignored — no validation error.

**Why it matters:** Silently dropping an author-specified timeout/heartbeat defeats the very safety limit meant to bound runaway/hung tasks, and the misconfiguration is invisible. The same code already coerces MDX numeric strings for `maxConcurrency`/`subtreeConcurrency`; applying `Number()` (with the existing `Number.isFinite`/`> 0` guards) to these three props fixes the whole class. Note the analogous `retries` check at lines 105/658 shares the same asymmetry.
