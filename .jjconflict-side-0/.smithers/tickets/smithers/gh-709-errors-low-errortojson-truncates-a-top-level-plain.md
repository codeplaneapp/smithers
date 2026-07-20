# 🐛 errors: [low] errorToJson truncates a top-level plain Error's `.cause` and own props on the durable failure path

GitHub: https://github.com/smithersai/smithers/issues/709

_via ultracode (Opus multi-agent) review_

**Summary:** `buildErrorJson`'s plain-`Error` branch returns only `{name, message, stack}`, dropping `.cause` and every custom own-enumerable prop before `toJsonSafe` can preserve them — so directly-recorded plain Errors lose their root-cause chain.

**Location:** `packages/errors/src/errorToJson.js:122-127` (the `if (error instanceof Error)` branch in `buildErrorJson`).

**Root cause:** `errorToJson(e)` = `toJsonSafe(buildErrorJson(e), new WeakSet())`. `buildErrorJson` converts a top-level plain Error into a fresh plain object `{name, message, stack}` (no `cause`, no own props). That object is no longer an `Error`, so `toJsonSafe`'s rich Error branch (lines 32-56, which walks `cause` + `Object.keys`) never runs for the top-level error. The `SmithersError`/`EngineError` branches (lines 99-120) DO keep `cause`, and a plain Error nested as their `cause` is preserved by `toJsonSafe` — an inconsistency.

**Failure scenario:** The engine records failed tasks via `JSON.stringify(errorToJson(err))` (engine.js:4674/4730/6644, deferred-state-bridge.js:782, etc.). For a common `err = new Error('wrap', { cause: rootCause })` (with any custom fields), the durable record becomes only `{name, message, stack}` — the entire cause chain and custom fields are silently lost. Verified empirically:

```
new Error('wrap', { cause: root }); e.customField='important';
errorToJson(e) => { name:'Error', message:'wrap', stack:'…' }   // cause + customField gone
```

The identical Error wrapped as a SmithersError's cause is fully preserved.

**Why it matters:** This is the durable failed-task write path — the recorded error is often the only forensic artifact after a crash/resume. Dropping the cause chain for the most common wrapper-Error shape causes real debugging blindness. Untested: errors-serialization.test.js only ever passes a plain Error as a nested cause (test ~L72), never as the top-level argument.

**Fix sketch:** In the plain-Error branch, include `cause` (and let `toJsonSafe` walk own props), or simply return the Error itself so `toJsonSafe`'s Error branch handles it uniformly.
