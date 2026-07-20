# 🐛 fix(vercel): [medium] per-command deadline sent as SDK `timeout` not `timeoutMs`; abort signal not forwarded — runaway/cancelled commands leak remote compute

GitHub: https://github.com/smithersai/smithers/issues/738

_via ultracode (Opus multi-agent) review_

`exec()` forwards the per-command deadline under the wrong SDK field, so the sandbox never SIGKILLs a runaway command server-side; only the local JS promise is abandoned.

**Where**
- `packages/vercel/src/createVercelSandboxProvider.js:163` — `runInput.timeout = opts.timeoutMs`. `RunCommandParams` has no `timeout` field; the correct one is `timeoutMs` (`packages/vercel/node_modules/@vercel/sandbox/dist/session.d.ts:62`, "killed with SIGKILL … enforced by the sandbox at exec time"). Unknown key is silently ignored.
- Same site: `opts.signal` is never placed on `runInput`, though `RunCommandParams.signal?: AbortSignal` exists (session.d.ts:56). `opts.signal` is only used for the pre-flight aborted check (line 149) and `raceCommand` (line 165), which only rejects the local promise.
- (Not a bug: the session-level `timeout` on `Sandbox.create` at lines 146/354 is a valid create param.)

**Failure scenario**
A tool command hangs (e.g. a network fetch that never returns) with `toolTimeoutMs=60_000`. `raceCommand` rejects after 60s and `exec` throws, surfacing a timeout — but since the SDK got the ignored `timeout` key and no `signal`, the real process keeps running inside the Vercel sandbox, burning vCPU/billing until the whole session timeout (up to 45+ min). Cancellation/abort leaks identically.

**Why it matters**
Defeats the intended per-command server-side kill-switch: runaway or cancelled commands leak remote compute and billing for the full session lifetime instead of dying at the deadline.

**Fix**
Set `runInput.timeoutMs = opts.timeoutMs` and `runInput.signal = opts.signal`. Update the tests that assert the wrong key: `packages/vercel/tests/createVercelSandboxProvider.test.js:212` (`lastRunInput?.timeout`) and `:464` (`"timeout" in lastRunInput`).
