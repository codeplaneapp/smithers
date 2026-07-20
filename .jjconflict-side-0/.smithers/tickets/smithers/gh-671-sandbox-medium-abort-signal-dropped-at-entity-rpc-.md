# 🐛 sandbox: [medium] abort signal dropped at entity RPC boundary — cancel never SIGKILLs docker/bwrap command

GitHub: https://github.com/smithersai/smithers/issues/671

_via ultracode (Opus multi-agent) review_

## Summary
The run's `AbortSignal` is dropped at the `@effect/cluster` entity RPC boundary, so cancelling/tearing down a run never kills an in-flight sandbox `config.command` on the docker/bubblewrap/codeplane runtimes — it leaks until the 10-minute timeout.

## Trace
- `packages/sandbox/src/execute.js:667` — passes the signal: `svc.execute(resolveSandboxCommand(options.config?.command), sandboxHandle, runtime.signal)`.
- `svc` is the entity-wrapped `SandboxTransportService` for all built-in runtimes (`packages/sandbox/src/transport.js:36-53` → `makeSandboxTransportLayer` → `makeSandboxTransportServiceEffect`).
- Signal is dropped at three points:
  - `packages/sandbox/src/effect/sandbox-entity.js:180` — wrapper `execute: (command, handle) => client.execute({ command, handle })` ignores the 3rd `signal` arg.
  - `packages/sandbox/src/effect/sandbox-entity.js:78` — `SandboxExecutePayloadSchema` has no `signal` field (an `AbortSignal` isn't serializable over RPC).
  - `packages/sandbox/src/effect/sandbox-entity.js:140` — handler calls `executor.execute(payload.command, payload.handle)` with only two args.
- The runners accept and thread `signal` (`socket-runner.js:43` → `spawnSandboxCommand(..., { signal })`, `http-runner.js:36` likewise) into `spawnSandboxCommand`'s `options.signal` (`process-runner.js:321`), but always receive `signal=undefined` on the transport path.

There is no fallback interruption path: `transportCall` (`execute.js:126-131`) runs the effect on a fresh top-level `Effect.runPromise` fiber not tied to `runtime.signal`, and the child is spawned `detached:true`, so the explicit signal was the only kill mechanism.

## Failure scenario
A workflow uses a docker/bubblewrap sandbox with a long-running `config.command`. The user runs `smithers cancel` / `smithers down` mid-execution. `runtime.signal` aborts, but the signal never reaches `spawnSandboxCommand`, so the detached process group is not SIGKILLed. The docker/bwrap command keeps holding a container / burning CPU until `DEFAULT_SANDBOX_COMMAND_TIMEOUT_MS` (10 min, `process-runner.js:8`).

## Why it matters
Cancellation of an in-flight sandbox command is silently broken for all transport runtimes — leaking compute/containers for up to 10 minutes after cancel/teardown. It directly contradicts the intent documented at `process-runner.js:317-320`, and the `signal` params on the runner functions plus the `SandboxTransportService.execute(..., signal?)` type are misleading dead plumbing that make future readers believe cancellation works.
