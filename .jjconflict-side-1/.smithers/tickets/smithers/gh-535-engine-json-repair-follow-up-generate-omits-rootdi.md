# 🐛 engine: JSON-repair follow-up generate() omits rootDir/maxOutputBytes/taskContext

GitHub: https://github.com/smithersai/smithers/issues/535

**What happens**
When a task's agent response contains no extractable JSON, the engine sends a follow-up "output ONLY the JSON" repair turn. That call (`packages/engine/src/engine.js:3890-3903`) passes only `options/abortSignal/prompt/timeout/onStdout/onStderr`. The primary generate call (engine.js:3587-3620) passes `rootDir: taskRoot`, `taskContext`, and `maxOutputBytes: toolConfig.maxOutputBytes`; the schema-validation retry call (engine.js:4135-4153) passes `rootDir` and `maxOutputBytes`.

**Why it's wrong**
For CLI agents `rootDir` determines the working directory, so the repair turn runs in the engine process cwd instead of the task worktree (wrong repo state, wrong relative paths, potential writes outside the worktree). Its stdout is also uncapped because `maxOutputBytes` is dropped.

**Expected**
The repair call carries the same execution context as the other two generate calls: `rootDir: taskRoot`, `maxOutputBytes: toolConfig.maxOutputBytes`, and `taskContext` (the schema-retry call is also missing `taskContext` and could pick it up in the same fix).

Found during the 2026-07 repo-wide cleanup sweep (automated analyzer, human-unverified).
