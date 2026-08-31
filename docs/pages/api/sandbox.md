---
description: "Provider-neutral remote process execution, provisioned-machine lifecycle, conformance, and sandbox liveness."
---

# @smthrs/sandbox

Provider-neutral remote process execution, provisioned-machine lifecycle, conformance, liveness, and supervision. The package exports `RemoteChildProcessSpawner`, `ProviderConformance`, `Sandbox`, `SandboxConformance`, `DirectorySandbox`, `ContainerSandbox`, `SandboxHealth`, and `SandboxSupervision` as namespaces. Provider packages adapt their SDK sessions to either the spawn-only or provisioned-machine contract; this package derives Effect's host services and health machinery from those contracts.

```ts
import { RemoteChildProcessSpawner } from "@smthrs/sandbox"
import * as Effect from "effect/Effect"
import * as ChildProcess from "effect/unstable/process/ChildProcess"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"

const provider = RemoteChildProcessSpawner.TestRemote.make({
  scripts: { "echo hi": { stdout: "hi" } }
})

const program = Effect.gen(function*() {
  const spawner = yield* ChildProcessSpawner
  return yield* spawner.string(ChildProcess.make("echo", ["hi"]))
}).pipe(Effect.provide(RemoteChildProcessSpawner.layer(provider)))
```

The package depends on `@smthrs/kernel`, for `CommandLine` rendering and quoting alone, and on nothing else in the workspace: a sandbox is one way to satisfy `ChildProcessSpawner`, so it sits above the closed host list rather than inside it. It bundles for the browser because host access arrives through a provider or injected host services.

## Entry points

| Import | Source |
| --- | --- |
| `@smthrs/sandbox` | [src/index.ts](https://github.com/smithersai/smithers/blob/main/packages/sandbox/src/index.ts) |
| `@smthrs/sandbox/RemoteChildProcessSpawner` | [src/RemoteChildProcessSpawner/](https://github.com/smithersai/smithers/tree/main/packages/sandbox/src/RemoteChildProcessSpawner) |
| `@smthrs/sandbox/ProviderConformance` | [src/ProviderConformance/](https://github.com/smithersai/smithers/tree/main/packages/sandbox/src/ProviderConformance) |
| `@smthrs/sandbox/Sandbox` | [src/Sandbox/](https://github.com/smithersai/smithers/tree/main/packages/sandbox/src/Sandbox) |
| `@smthrs/sandbox/SandboxConformance` | [src/SandboxConformance/](https://github.com/smithersai/smithers/tree/main/packages/sandbox/src/SandboxConformance) |
| `@smthrs/sandbox/DirectorySandbox` | [src/DirectorySandbox/](https://github.com/smithersai/smithers/tree/main/packages/sandbox/src/DirectorySandbox) |
| `@smthrs/sandbox/ContainerSandbox` | [src/ContainerSandbox/](https://github.com/smithersai/smithers/tree/main/packages/sandbox/src/ContainerSandbox) |
| `@smthrs/sandbox/SandboxHealth` | [src/SandboxHealth/](https://github.com/smithersai/smithers/tree/main/packages/sandbox/src/SandboxHealth) |
| `@smthrs/sandbox/SandboxSupervision` | [src/SandboxSupervision/](https://github.com/smithersai/smithers/tree/main/packages/sandbox/src/SandboxSupervision) |

## RemoteChildProcessSpawner

| Export | Kind | Notes |
| --- | --- | --- |
| `ProviderErrorCode` | const + type | `aborted`, `timeout`, `unavailable`, `not_found`, `spawn_error`, `unknown`: this seam's own closed set |
| `ProviderError` | class | tagged `@smthrs/sandbox/RemoteChildProcessSpawner/ProviderError` |
| `Provider` | interface + service tag | `session`, scoped `open`, scoped `spawn` |
| `RemoteProcess`, `RemoteOptions` | interfaces | a started remote process (`stdout`, `stderr`, `exitCode`) and the `cwd`/`env` carried across |
| `layer` | layer | a `ChildProcessSpawner` backed by a provider; acquisition is tied to the layer scope |
| `TestScript`, `TestRemoteState`, `TestRemoteProvider` | interfaces | scripted provider fixtures |
| `TestRemote` | const | `make(options?)`, a deterministic scripted provider |

`layer` rejects command-supplied stdin streams, additional file descriptors,
custom shell paths, detached processes, and non-default pipeline routing with a
`BadArgument` `PlatformError`. Those options cannot be represented by the
provider contract and are never silently dropped. Output dispositions and
output sinks are applied by the adapter.

:::warning[Two divergences the error channel cannot report]
`extendEnv` is ignored, because the remote session's ambient environment never
crosses the seam. `isRunning` turns `false` when a caller observes `exitCode`
rather than when the remote process ends. Both are stated in the module header.
:::

## SandboxHealth

| Export | Kind | Notes |
| --- | --- | --- |
| `Healthy`, `Unhealthy` | classes | health states; `Unhealthy.component` is `"sandbox"` |
| `HealthState` | const + type | union schema |
| `UnhealthyReason` | const + type | `unresponsive`, `ping_failed` |
| `PingProvider`, `ProbeOptions`, `Service` | interfaces | probe inputs |
| `probe` | function | one ping under a deadline (5 seconds by default); never fails |
| `SandboxHealth` | service tag | `@smthrs/sandbox/SandboxHealth` |
| `make`, `makeNoop` | constructors | `makeNoop` always reports `Healthy` |
| `layer`, `layerNoop` | layers | |

## Reading next

[`@smthrs/kernel`](/api/kernel) owns the closed host list this satisfies a slot of, and the `proc:spawn` check written against the same rendered command line the provider receives. [`@smthrs/run-store`](/api/run-store) owns the run-ownership heartbeat that detects a dead engine owner rather than a dead sandbox.

## API reference

This page is the public API reference for the package's eight namespace exports: `RemoteChildProcessSpawner`, `ProviderConformance`, `Sandbox`, `SandboxConformance`, `DirectorySandbox`, `ContainerSandbox`, `SandboxHealth`, and `SandboxSupervision`. Provider packages adapt their SDK sessions to the spawn-only `RemoteChildProcessSpawner.Provider` or lifecycle-owning `Sandbox.Provider`; this package derives Effect host services, conformance checks, health, and supervision from those seams.

It depends on `@smthrs/kernel`, for `CommandLine` rendering and quoting alone, and nothing else in the workspace. That direction is deliberate: a sandbox is one way to satisfy `ChildProcessSpawner`, so it sits above the closed host list rather than inside it.

### RemoteChildProcessSpawner

| Export | Kind | Notes |
| --- | --- | --- |
| `Provider` | interface + service tag | `session`, scoped `open`, and a scoped `spawn` returning a `RemoteProcess` |
| `RemoteProcess`, `RemoteOptions` | interfaces | a started remote process in the same three pieces a child process has (`stdout`, `stderr`, `exitCode`), and the `cwd`/`env` a rendered command carries across |
| `ProviderErrorCode` | const + type | `aborted`, `timeout`, `unavailable`, `not_found`, `spawn_error`, `unknown` |
| `ProviderError` | class | tagged `@smthrs/sandbox/RemoteChildProcessSpawner/ProviderError` |
| `layer` | layer | adapts a configured provider to Effect's `ChildProcessSpawner` |
| `make` | constructor | the scoped spawner behind `layer`, for a caller that holds sessions itself (`SandboxSupervision`) |
| `TestScript`, `TestRemoteState`, `TestRemoteProvider` | interfaces | scripted provider fixtures |
| `TestRemote` | const | `make(options?)` builds a deterministic scripted provider |
| `TestRemoteKill` | interface | one signal the scripted provider was asked to deliver |

Provider acquisition is tied to the layer scope: interrupting an execution or a stream consumer closes that scope and therefore runs the finalizer installed by `Provider.open`. No `AbortSignal` crosses this seam.

A provider may add SDK details to `ProviderError.cause`, but it cannot create new host-visible failure kinds: the code set is closed, and `layer` normalizes each code onto the `PlatformError` reason that already means it (`timeout` → `TimedOut`, `unavailable` and `not_found` → `NotFound`, the rest → `Unknown`), naming the `ChildProcess` module the sibling spawners name. `not_found` means a requested guest path is absent; it stays distinct from a session that is unavailable until that normalization boundary.

`Provider.kill` and `Provider.ping` are optional, because a transport that can only post a command line has neither. A provider that implements them buys two things it cannot otherwise have: one command can be stopped without tearing down the session that runs it, and the session's liveness can be supervised. When `kill` is present the adapter maps `ChildProcessHandle.kill` onto it and signals a still-running command when its scope closes, ahead of the provider's own release finalizer; a process this side has already seen exit is left alone. When `kill` is absent the adapter keeps the old refusal, a `BadArgument` `PlatformError`, rather than pretending to have delivered a signal.

The codes are this seam's own. They used to borrow the deleted `Shell` service's set; a remote session goes wrong in its own ways, so the seam now declares them.

The command reaches the provider as the string `CommandLine.render` produces: the same string `@smthrs/kernel`'s `proc:spawn` check is written against, so a grant and the thing it authorizes cannot drift apart. Unsupported semantics are declared rather than dropped: command-supplied stdin streams, additional file descriptors, custom shell paths, detached processes, non-default pipeline routing, and delivering a signal to `kill` fail with a `BadArgument` `PlatformError`. The adapter honors output `pipe` / `ignore` / `inherit` dispositions and output sinks. A remote process ends by closing its scope. Two divergences cannot be reported as a failure and are stated in the module header instead: `extendEnv` is ignored, because the remote session's ambient environment never crosses the seam, and `isRunning` turns `false` when a caller observes `exitCode` rather than when the remote process ends.

### SandboxHealth

| Export | Kind | Notes |
| --- | --- | --- |
| `Healthy`, `Unhealthy` | classes | tagged `@smthrs/sandbox/SandboxHealth/Healthy` and `…/Unhealthy` |
| `HealthState` | const + type | union schema of the two |
| `UnhealthyReason` | const + type | `unresponsive`, `ping_failed` |
| `PingProvider`, `ProbeOptions`, `Service` | interfaces | probe inputs and the service shape |
| `probe` | function | runs one ping under a deadline; never fails |
| `SandboxHealth` | service tag | tag key `@smthrs/sandbox/SandboxHealth` |
| `make`, `makeNoop`, `layer`, `layerNoop` | constructors and layers | `makeNoop` always reports `Healthy`, for hosts without a remote sandbox |
| `fromProvider`, `layerFromProvider` | constructor and layer | probes a `RemoteChildProcessSpawner.Provider` through its optional `ping`, and falls back to `makeNoop` when it has none |

The journal's run-ownership heartbeat detects a dead engine owner; nothing detected a dead sandbox under a live engine. This module closes that gap with a taxonomy plus a probe, not a supervisor, no polling loop lives here.

`probe` never fails: a failed ping becomes `Unhealthy(reason: "ping_failed")`, and a ping that outlives the deadline (5 seconds by default) becomes `Unhealthy(reason: "unresponsive")`. That is what distinguishes "sandbox dead" from "slow command": the probe answers within the deadline either way. `Unhealthy.component` is `"sandbox"`, so an "engine alive, sandbox dead" diagnosis is explicit rather than inferred from a generic provider error.

Reasons, like the host error codes, are a stable public contract: never repurpose one, add one.

### SandboxSupervision

| Export | Kind | Notes |
| --- | --- | --- |
| `Options` | interface | `interval`, plus an optional `probe`, `tolerance`, `deadline`, and `reporter` |
| `Reporter`, `loggingReporter` | interface and const | where a retirement is reported; the default logs a warning |
| `SandboxUnhealthy` | class | tagged `sandbox-unhealthy`, carrying `session`, `reason`, `message`, and `probes` |
| `make`, `layer` | constructor and layer | a `ChildProcessSpawner` that keeps one supervised session |

`SandboxHealth` reports a verdict; supervision is what acts on one. It holds a single provider session, probes it on `interval`, and retires it after `tolerance` consecutive unhealthy verdicts (default 1; one healthy answer resets the count). Retiring fails everything running in the session with a `NotFound` `PlatformError`, the same reason a session that refused to open produces, because both say the same thing to a retry policy. It then closes the session scope so the provider's finalizer runs, and lets the next command open a fresh session. That failure is the point: under the plain adapter a session that dies leaves its commands waiting forever, because a dead session is silent.

The session opens on the first command, not while the layer builds: a host that never spawns anything must not pay for a sandbox, and a provider that is down must fail the action that needed it rather than the composition root. A provider without `ping` is never probed, so wrapping one in supervision costs nothing and changes nothing.

```ts
import { SandboxSupervision } from "@smthrs/sandbox"

const spawner = SandboxSupervision.layer(provider, { interval: "10 seconds", tolerance: 2 })
```

### ProviderConformance

| Export | Kind | Notes |
| --- | --- | --- |
| `Commands` | interface | the three fixture commands a run needs: `writes` (with its exact `output`), `fails` (with its `failureCode`), and `runs` |
| `Violation`, `format` | interface and function | one check that did not hold, and a report an adapter author can act on |
| `check` | function | runs the suite against one provider and returns the violations |

Vendor providers live in plugin packages, so this package cannot test them. It states the contract as behavior instead, and the plugin runs the statement:

```ts
import { ProviderConformance } from "@smthrs/sandbox"

const violations = yield* ProviderConformance.check(provider, {
  writes: "sh -c 'printf hello'",
  output: "hello",
  fails: "sh -c 'exit 3'",
  failureCode: 3,
  runs: "sh -c 'sleep 60'",
  shell: true
})
```

`Commands.shell` defaults to `false`. Set it to `true` when the fixture strings are shell lines; the suite then renders them verbatim instead of POSIX-quoting each whole string as one program token. `SandboxConformance.posixCommands` sets it for its POSIX fixtures.

The checklist:

| Check | What the provider must do |
| --- | --- |
| `writes-its-output` | `writes` puts exactly `output` on stdout and exits 0 |
| `reports-a-nonzero-exit` | `fails` reports `failureCode` as an exit code, not as a failure |
| `answers-a-ping` | a declared `ping` answers while the session is open |
| `signals-a-running-command` | a declared `kill` STOPS a live process |

The kill check watches the process, not the call. A `kill` that returns success and leaves the command running satisfies the type and leaks a process inside the sandbox for every cancelled action, so the check waits for `runs` to stop and reports `the command was still running after the signal` when it does not. How it stopped is not the subject: a provider that reports a signalled process as a failed `exitCode` is as conforming as one that reports a status. `Commands.stopsWithin` bounds the wait, defaulting to `ProviderConformance.defaultStopsWithin` (5 seconds).

The checks run through `RemoteChildProcessSpawner.layer`, because a provider that satisfies the interface but not the adapter is of no use to a caller, and each check gets a fresh session so a check that leaves one unusable cannot decide the next. The optional capabilities are checked only when the provider declares them: an absent `ping` or `kill` is a documented absence, not a defect.

### Sandbox

| Export | Kind | Notes |
| --- | --- | --- |
| `Session` | interface | one held machine: identity, workdir, spawn, byte-typed file transfer, and optional `kill`, `ping`, and native file operations |
| `Provider` | interface + service tag | scoped `acquire(session)` creates or reattaches a machine and owns its teardown |
| `CommandProviderOptions`, `commandProvider` | interface and constructor | projects a lifecycle provider onto `RemoteChildProcessSpawner.Provider` |
| `fileSystem` | constructor | derives Effect's `FileSystem` from one session |
| `LayerHostOptions`, `layerHost` | interface and layer | holds one machine as `ChildProcessSpawner`, `FileSystem`, and `Path` |
| `TestSession`, `TestSessionProvider`, `TestSessionState` | const and interfaces | deterministic scripted lifecycle provider, guest tree, commands, and acquire/release observations |

`Session` is a machine contract, not just a command transport. Its file operations and spawned commands must see the same tree.

| Obligation | Required behavior |
| --- | --- |
| default directory | `spawn(command, {})` runs in `Session.workdir` |
| parent creation | `writeFile` creates missing parent directories |
| absence | `readFile` fails with `ProviderError.code === "not_found"` when the path is absent |
| contents | file contents cross as bytes and round-trip unchanged |
| optional control | `kill` and `ping` keep the spawner-level meanings |

```ts
import { Sandbox } from "@smthrs/sandbox"
import * as Effect from "effect/Effect"

const useMachine = Effect.scoped(
  Effect.gen(function*() {
    const session = yield* provider.acquire("run:01J...")
    yield* session.writeFile(`${session.workdir}/src/input.bin`, bytes)
    const process = yield* session.spawn("test -f src/input.bin", {})
    return yield* process.exitCode
  })
)
```

`Provider.acquire(key)` is scoped. Acquisition registers teardown as a finalizer of that scope; closing the scope is the only lifecycle end exposed to the caller. The stable key lets an implementation deterministically name and reattach a crash-left machine when it can. Image, memory, network policy, and other machine shape belong to provider construction, not `acquire`.

`commandProvider(provider, options)` projects that lifecycle back onto the spawn-only provider. Existing `RemoteChildProcessSpawner` adapters, `SandboxHealth.fromProvider`, `SandboxSupervision`, and `ProviderConformance` then compose unchanged. `options.provides` declares `kill` and `ping` before acquisition, because the projected provider must expose those capabilities statically. A supervision retire-and-reopen cycle acquires a new generation; an older generation's late finalizer cannot clear the newer held session.

`fileSystem(session)` uses `Session.readFile` and `Session.writeFile` for byte transfer. It derives `exists`, `stat`, `makeDirectory`, `readDirectory`, `remove`, `rename`, `realPath`, and `readLink` with POSIX `sh` probes. Entries in `session.files` override the derived operations one by one. Other `FileSystem` operations retain `makeNoop`'s explicit refusal rather than simulating watches, open handles, or temporary directories.

The probe surface is intentionally honest. `stat` reports exact file size, but mode is `0` and times and ownership are absent. Directory output is line-framed, so a newline in a filename is misread. Probes require the named POSIX utilities on the machine.

```ts
const machineHost = Sandbox.layerHost(provider, { session: "run:01J..." })
```

`layerHost` acquires one session for the layer scope and derives `ChildProcessSpawner`, `FileSystem`, and `Path` from it. This layer context is what a caller hands to an agent's standard filesystem and shell tools to place both on the same machine. When the provider supplies isolation, the machine boundary, not a path guard, denies ambient host access. Closing the layer scope runs provider teardown.

### SandboxConformance

| Export | Kind | Notes |
| --- | --- | --- |
| `CheckOptions` | interface | session key, command fixture, and declared `kill` / `ping` capabilities |
| `check` | function | returns all violations of the session and delegated spawn contracts |
| `posixCommands` | const | default `Commands` fixture for POSIX-shell sessions; sets `shell: true` |

```ts
import { SandboxConformance } from "@smthrs/sandbox"

const violations = yield* SandboxConformance.check(provider, {
  provides: { kill: true, ping: true }
})
```

Each check acquires a fresh session. The suite verifies byte round-trips, `not_found`, parent creation, the default workdir, environment delivery, and a working release-then-reacquire cycle. It projects the provider through `Sandbox.commandProvider` and delegates spawn, exit, ping, and real process-stop checks to `ProviderConformance`. A provider package asserts that the returned array is empty.

### DirectorySandbox

| Export | Kind | Notes |
| --- | --- | --- |
| `DirectorySandboxOptions` | interface | injected host `FileSystem`, `ChildProcessSpawner`, and scratch root |
| `make` | constructor | builds a `Sandbox.Provider` backed by one host directory per session key |

```ts
import { DirectorySandbox } from "@smthrs/sandbox"

const provider = DirectorySandbox.make({
  fs,
  spawner,
  root: "/var/tmp/smithers"
})
```

`acquire` creates the deterministic scratch directory, runs shell commands there by default, exposes native host file operations, delivers real process signals, and removes the directory when the scope closes. The filesystem and spawner are injected values; the package takes no ambient host dependency.

This is a trusted local workspace backend, **not a security boundary**. A spawned process is not confined to the scratch directory and can address whatever its host credentials permit. Use it for local composition, tests, or CI placement where the body is trusted.

### ContainerSandbox

| Export | Kind | Notes |
| --- | --- | --- |
| `ContainerSandboxOptions` | interface | injected spawner, image, and optional CLI, workdir, environment, network, create arguments, and name prefix |
| `make` | constructor | builds a create-or-reattach `Sandbox.Provider` over a Docker-compatible CLI |

```ts
import { ContainerSandbox } from "@smthrs/sandbox"

const provider = ContainerSandbox.make({
  spawner,
  image: "node:22",
  network: "none"
})
```

The default CLI is `docker`; set `program: "podman"` for Podman or name a compatible wrapper. `acquire` deterministically names the container, runs `create` then `start`, and reattaches when that name already exists. Commands, reads, and writes all travel through `exec` to the same guest workdir. The scope finalizer runs `rm --force`, ending the container and everything still inside it.

Killing the local `docker exec` client does not reliably signal the guest process. Each spawned command therefore writes its guest pid to a session-private pidfile. `kill` starts a second guest command that walks descendants through `/proc`, signals children first, and then signals the recorded process. Acquisition wipes the pidfile directory before reuse, so reattachment cannot target stale pids.

### Browser support

`@smthrs/sandbox` is gated as a browser entry point by `scripts/browser-check.mjs` (`pnpm run browser`, and one CI step). The probe only runs the effect a provider hands it, and host access stays behind the provider layer.

See [Hosts and capabilities](/concepts/hosts-and-capabilities), the [`@smthrs/kernel` reference](/api/kernel), and [failure and retry](/concepts/failure-and-retry).
