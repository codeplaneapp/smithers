# 🐛 fix(daytona): [medium] exec ignores per-tool timeoutMs client-side, unlike create/startup and the Vercel sibling

GitHub: https://github.com/smithersai/smithers/issues/734

_via ultracode (Opus multi-agent) review_

**Summary:** The Daytona session `exec` never enforces the per-tool `timeoutMs` client-side; it only maps it to Daytona's server-side `timeoutSecs` and races solely against the abort signal, so a stalled `executeCommand` RPC is not bounded by `toolTimeoutMs`.

**Location:** `packages/daytona/src/createDaytonaSandboxProvider.js:106-108`

```js
const timeoutSecs = Number.isFinite(timeoutMs) && timeoutMs > 0 ? Math.ceil(timeoutMs / 1000) : 0;
const execPromise = Promise.resolve(sandbox.process.executeCommand(command, cwd, env, timeoutSecs));
const res = signal ? await raceWithAbort(execPromise, signal) : await execPromise;
```

`raceWithAbort` already accepts `{ timeoutMs }` (defined at :287, honored at :307-314) and the create/startup paths use it (:52-56, :77-81). Exec does not, and the `signal`-undefined branch awaits the SDK promise with zero timeout protection.

**Failure scenario:** The kit calls `session.exec(command, { timeoutMs: request.toolTimeoutMs, signal: request.signal })` (`packages/sandbox/src/provider-kit/createCommandSandboxProvider.js:71-76`). If the Daytona SDK's `executeCommand` RPC stalls at the transport layer (dropped connection / server hang), the server-side `timeoutSecs` never fires because the response itself is what's stuck. With no signal (or before the run's heartbeat-timeout backstop trips), `exec` waits past `toolTimeoutMs` — unbounded in the no-signal branch.

**Contract precedent:** The sibling Vercel provider deliberately races exec against BOTH the signal and `opts.timeoutMs` (`packages/vercel/src/createVercelSandboxProvider.js:165`, `raceCommand`), with a dedicated test "local timeout rejects when the command never settles" (`packages/vercel/tests/createVercelSandboxProvider.test.js:215-230`). Daytona diverges from this established contract.

**Why it matters:** The per-tool `toolTimeoutMs` bound the kit passes is silently ignored client-side, so a hung exec is only caught (if at all) by the coarser engine heartbeat-timeout rather than the intended tool deadline. Fix is trivial: pass `{ timeoutMs }` to `raceWithAbort` and drop the signal-only shortcut so the timeout is enforced even when `signal` is undefined. Add a "never-settles" test mirroring Vercel's.
