---
description: "Provider-neutral remote process execution, provisioned-machine lifecycle, conformance, and sandbox liveness."
---

# @smthrs/sandbox

Provider-neutral remote process execution, provisioned-machine lifecycle, conformance, liveness, and supervision. The package exports `RemoteChildProcessSpawner`, `ProviderConformance`, `Sandbox`, `SandboxConformance`, `DirectorySandbox`, `ContainerSandbox`, `KubernetesSandbox`, `JustBashSandbox`, `MicrosandboxSandbox`, `VercelSandbox`, `DaytonaSandbox`, `AwsSandbox`, `CloudflareSandbox`, `SandboxHealth`, and `SandboxSupervision` as namespaces. Provider packages adapt their SDK sessions to either the spawn-only or provisioned-machine contract; this package derives Effect's host services and health machinery from those contracts. The nine bundled providers obey the same rule: a vendor SDK arrives as an injected structural slice and a CLI arrives as an injected spawner, so adding a backend costs this package no dependency and no host access.

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
| `@smthrs/sandbox/KubernetesSandbox` | [src/KubernetesSandbox/](https://github.com/smithersai/smithers/tree/main/packages/sandbox/src/KubernetesSandbox) |
| `@smthrs/sandbox/JustBashSandbox` | [src/JustBashSandbox/](https://github.com/smithersai/smithers/tree/main/packages/sandbox/src/JustBashSandbox) |
| `@smthrs/sandbox/MicrosandboxSandbox` | [src/MicrosandboxSandbox/](https://github.com/smithersai/smithers/tree/main/packages/sandbox/src/MicrosandboxSandbox) |
| `@smthrs/sandbox/VercelSandbox` | [src/VercelSandbox/](https://github.com/smithersai/smithers/tree/main/packages/sandbox/src/VercelSandbox) |
| `@smthrs/sandbox/DaytonaSandbox` | [src/DaytonaSandbox/](https://github.com/smithersai/smithers/tree/main/packages/sandbox/src/DaytonaSandbox) |
| `@smthrs/sandbox/AwsSandbox` | [src/AwsSandbox/](https://github.com/smithersai/smithers/tree/main/packages/sandbox/src/AwsSandbox) |
| `@smthrs/sandbox/CloudflareSandbox` | [src/CloudflareSandbox/](https://github.com/smithersai/smithers/tree/main/packages/sandbox/src/CloudflareSandbox) |
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

`layer` delivers a command-supplied stdin stream only to a provider that declares `stdin: true`, collected whole and bounded at 16 MiB; for any other provider it rejects the command instead of dropping its input. It also rejects additional file descriptors,
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

This page is the public API reference for the package's fifteen namespace exports: `RemoteChildProcessSpawner`, `ProviderConformance`, `Sandbox`, `SandboxConformance`, the nine providers `DirectorySandbox`, `ContainerSandbox`, `KubernetesSandbox`, `JustBashSandbox`, `MicrosandboxSandbox`, `VercelSandbox`, `DaytonaSandbox`, `AwsSandbox`, and `CloudflareSandbox`, then `SandboxHealth` and `SandboxSupervision`. Provider packages adapt their SDK sessions to the spawn-only `RemoteChildProcessSpawner.Provider` or lifecycle-owning `Sandbox.Provider`; this package derives Effect host services, conformance checks, health, and supervision from those seams. Each bundled provider is one `make` that returns a `Sandbox.Provider`; the vendor surface it drives is a constructor argument.

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

The command reaches the provider as the string `CommandLine.render` produces: the same string `@smthrs/kernel`'s `proc:spawn` check is written against, so a grant and the thing it authorizes cannot drift apart. Unsupported semantics are declared rather than dropped: a stdin stream for a provider that does not declare `stdin: true` (or on any stage of a pipeline but the first), additional file descriptors, custom shell paths, detached processes, non-default pipeline routing, and delivering a signal to `kill` fail with a `BadArgument` `PlatformError`. A declared provider receives stdin as one complete byte blob in `RemoteOptions.stdin`, never as a live pipe. The adapter honors output `pipe` / `ignore` / `inherit` dispositions and output sinks. A remote process ends by closing its scope. Two divergences cannot be reported as a failure and are stated in the module header instead: `extendEnv` is ignored, because the remote session's ambient environment never crosses the seam, and `isRunning` turns `false` when a caller observes `exitCode` rather than when the remote process ends.

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

The kill check watches the process, not the call. A `kill` that returns success and leaves the command running satisfies the type and leaks a process inside the sandbox for every cancelled action, so the check waits for `runs` to stop and reports `the command was still running after the signal` when it does not. How it stopped is not the subject: a provider that reports a signalled process as a failed `exitCode` is as conforming as one that reports a status. `Commands.stopsWithin` bounds the wait, defaulting to `ProviderConformance.defaultStopsWithin` (5 seconds). The handle is only the wrapper, though, and a shell that dies while its child lives on satisfies every observation the handle allows, so a fixture may also name `Commands.survivor`: a command that exits zero while the signalled command's work is still alive. It runs in the same session after the exit is observed, and a zero exit is the violation `the command's work was still running after its handle reported it stopped`.

The checks run through `RemoteChildProcessSpawner.layer`, because a provider that satisfies the interface but not the adapter is of no use to a caller, and each check gets a fresh session so a check that leaves one unusable cannot decide the next. The optional capabilities are checked only when the provider declares them: an absent `ping` or `kill` is a documented absence, not a defect.

### Sandbox

| Export | Kind | Notes |
| --- | --- | --- |
| `Session` | interface | one held machine: identity, workdir, spawn, byte-typed file transfer, and optional `kill`, `ping`, and native file operations |
| `Provider` | interface + service tag | scoped `acquire(session)` creates or reattaches a machine and owns its teardown |
| `CommandProviderOptions`, `commandProvider` | interface and constructor | projects a lifecycle provider onto `RemoteChildProcessSpawner.Provider` |
| `fileSystem` | constructor | derives Effect's `FileSystem` from one session |
| `LayerHostOptions`, `layerHost` | interface and layer | holds one machine as `ChildProcessSpawner`, `FileSystem`, `Path`, and `SandboxHealth`; `health` sets the probe deadline |
| `TestSession`, `TestSessionProvider`, `TestSessionState` | const and interfaces | deterministic scripted lifecycle provider, guest tree, commands, and acquire/release observations |

`Session` is a machine contract, not just a command transport. Its file operations and spawned commands must see the same tree.

| Obligation | Required behavior |
| --- | --- |
| default directory | `spawn(command, {})` runs in `Session.workdir` |
| relative cwd | a relative `cwd` is taken under `workdir`, never under the transport's own directory |
| environment names | `spawn` fails with `spawn_error` when an `options.env` entry with a value is named anything but `[A-Za-z_][A-Za-z0-9_]*`, rather than delivering a variable the command cannot see |
| standard input | `spawn` delivers `options.stdin` bytes as the command's complete input; a transport with no input channel stages a workspace file and redirects |
| parent creation | `writeFile` creates missing parent directories |
| absence | `readFile` fails with `ProviderError.code === "not_found"` when the path is absent |
| contents | file contents cross as bytes and round-trip unchanged |
| optional control | `ping` keeps the spawner-level meaning; a declared `kill` ends the command and everything it started, not only the shell that wrapped it |

:::warning[Environment names must be shell identifiers]
A command given to `spawn` is arbitrary shell text, so every provider runs it
through a shell, and a shell rebuilds its environment from the entries whose
names are shell identifiers when it starts. Dash, which is `/bin/sh` on Debian
and Ubuntu, drops `a-b`; bash, which is `/bin/sh` on macOS, keeps it. Delivery
is therefore not portable, and no arrangement of the delivery fixes it because
the shell that drops the name is the one that has to interpret the command.
The loss is also invisible to the host, so nothing downstream could report it.
`spawn` refuses such a name instead, on every provider and every platform, and
names the variable in the error.
:::

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
const machineHost = Sandbox.layerHost(provider, {
  session: "run:01J...",
  health: { deadline: "10 seconds" }
})
```

`layerHost` acquires one session for the layer scope and derives `ChildProcessSpawner`, `FileSystem`, and `Path` from it. This layer context is what a caller hands to an agent's standard filesystem and shell tools to place both on the same machine. When the provider supplies isolation, the machine boundary, not a path guard, denies ambient host access. Closing the layer scope runs provider teardown.

The layer also serves `SandboxHealth`, built with `SandboxHealth.fromProvider` over the held session, so a caller can ask whether the machine is still there. `options.health` is the probe's `ProbeOptions`; its `deadline` defaults to 5 seconds. A session without `ping` yields the noop probe, which always answers `Healthy`. That is not a claim the machine is alive; it says nothing is watching it.

What `layerHost` deliberately does not do is what `SandboxSupervision` does for the spawn-only seam: retire an unhealthy session and open a fresh one behind the caller's back. That is right for a transport, where a command is the whole unit of work, and wrong here, because the body holding these services has been writing to this machine. Swapping it mid-action would silently discard those writes and hand the body an empty tree that still looks like its workspace. A dead machine surfaces as a failure instead, and re-provisioning belongs to whoever retries the action, which acquires the session key again.

### SandboxConformance

| Export | Kind | Notes |
| --- | --- | --- |
| `CheckOptions` | interface | session key, command fixture, declared `kill` / `ping` capabilities, and `checkTimeout`, the wall-clock deadline that convicts a hung check under any clock |
| `check` | function | returns all violations of the session and delegated spawn contracts |
| `posixCommands` | const | the `Commands` fixture shape for POSIX-shell sessions; sets `shell: true` |
| `uniquePosixCommands` | function | the fixture `check` actually runs by default: the same shape with a per-call sleep duration, so concurrent suites on one host never mistake each other's fixture for a survivor |

```ts
import { SandboxConformance } from "@smthrs/sandbox"

const violations = yield* SandboxConformance.check(provider, {
  provides: { kill: true, ping: true }
})
```

Each check acquires a fresh session. The file checks verify binary, empty, and 64 KiB byte round-trips, `not_found`, parent creation, the default workdir and a relative `cwd`, environment delivery, refusal of an environment name a guest shell would drop (`refuses-an-unusable-environment-name`), standard input delivery (verified through `readFile`, so a pseudo-terminal transport is not penalized for its output), standard error arriving on one of the two streams, and a working release-then-reacquire cycle. Two checks deliberately cross surfaces: `files-reach-processes` writes through `writeFile` and measures the file with `wc -c` in a process, and `processes-reach-files` has a process produce a file that `readFile` must return, so a session serving files from anywhere but the machine its processes run on cannot pass. The suite then projects the provider through `Sandbox.commandProvider` and delegates spawn, exit, ping, and process-stop checks to `ProviderConformance`, whose kill check now also runs the fixture's `survivor` probe: after a kill, a command that can still be found running on the machine is a violation even though its wrapper exited. A provider package asserts that the returned array is empty.

### Providers

One row per bundled provider. Every cell is read from the provider's source and its tests.

| Provider | What a machine is | How the vendor surface arrives | Reattaches an existing machine on the same session key | Declares `kill` | Real-backend test in this repository |
| --- | --- | --- | --- | --- | --- |
| `DirectorySandbox` | one host directory under `root` | injected services: the host `FileSystem` and `ChildProcessSpawner` | yes, the recursive `makeDirectory` leaves a crash-left directory and its files in place | yes, the host handle's signal | host directories and processes (`DirectorySandbox.test.ts`) |
| `ContainerSandbox` | one container from `image`, held on `sleep infinity` | injected spawner running a Docker-compatible CLI | yes, a name `already in use` is reattached | yes, a pidfile plus a `/proc` descendant walk | Docker (`RealContainerSandbox.integration.test.ts`, skipped without `docker info`) |
| `KubernetesSandbox` | one Pod from `image`, held on `sleep infinity` | injected spawner running `kubectl` | yes, `AlreadyExists` is reattached | yes, the same pidfile script over `kubectl exec` | OrbStack Kubernetes (`RealKubernetesSandbox.integration.test.ts`, skipped without the `orbstack` context) |
| `JustBashSandbox` | one directory in a shared virtual filesystem; commands are interpreted in-process | injected interpreter slice (`JustBashLike`) and `FileSystem` | n/a, in-process | no | none, fake only |
| `MicrosandboxSandbox` | one local microVM from an image or a snapshot | injected SDK slice (`Sdk`) | yes, `sandboxAlreadyExists` connects to or restarts it; `persistence: "sticky"` keeps it running for that purpose | no | Microsandbox microVM (`RealMicrosandbox.integration.test.ts`, skipped without the `microsandbox` binary) |
| `VercelSandbox` | one named persistent Vercel sandbox | injected SDK slice (`Sdk`) plus caller-supplied credentials | yes, `getOrCreate` with `persistent: true` and `resume: true` | no | none, fake only |
| `DaytonaSandbox` | one named Daytona sandbox | injected SDK slice: a configured `Daytona` client | yes, `get(name)` first, `create` on a 404, `start` when attached | no | none, fake only |
| `AwsSandbox` | one Fargate task from `RunTask` | injected SDK slice for the lifecycle, the AWS CLI over an injected spawner for commands | yes, `ListTasks` by the `startedBy` tag adopts a ready leftover | yes, a pidfile plus the descendant walk through a second session | none live; the fake reproduces the Session Manager framing over a real local shell |
| `CloudflareSandbox` | one Sandbox Durable Object behind a Worker binding | caller-supplied binding, through an injected `getSandbox` slice | yes, the Durable Object id is derived from the key, so the same object answers | no | none, fake only |

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

### KubernetesSandbox

| Export | Kind | Notes |
| --- | --- | --- |
| `make` | constructor | builds a create-or-reattach `Sandbox.Provider` whose machines are Pods driven through an injected `kubectl` spawner; `image` is required, and `namespace`, `program`, `context`, `kubeconfig`, `workdir`, `env`, `labels`, `resources`, `serviceAccount`, `nodeSelector`, `createArgs`, and `namePrefix` shape the Pod |

```ts
import { KubernetesSandbox } from "@smthrs/sandbox"

const provider = KubernetesSandbox.make({
  spawner,
  image: "node:22",
  context: "orbstack",
  namespace: "smithers-runs",
  serviceAccount: "runner",
  resources: {
    requests: { cpu: "250m", memory: "512Mi" },
    limits: { cpu: "2", memory: "2Gi" }
  }
})
```

`acquire` derives the Pod name from the session key (prefix `smthrs-sbx-`, lowercased, bounded to 63 characters with the key's digest kept), runs `kubectl run` with `--restart Never` and `sleep infinity`, treats an `AlreadyExists` answer as a reattach, waits for the `Ready` condition with a 300 second timeout, and prepares the workdir and a session-private pidfile directory. Options `kubectl run` has no flag for (`serviceAccount`, `nodeSelector`, `resources`) travel as a strategic-merge `--overrides` document; `context`, `namespace`, and `kubeconfig` prefix every invocation. The scope finalizer runs `kubectl delete pod --force --grace-period=0`, and a Pod that was created but never became Ready or could not prepare its workspace is deleted the same way.

Commands run through `kubectl exec` under the guest `sh`, in the requested `cwd` with the requested environment applied by `env(1)` rather than `export`, because `export` is a special builtin whose refusal of a name would end the whole script. Files travel through the same channel as base64: a read runs guest `base64`, a write pipes base64 into `base64 -d` on the exec's stdin after `mkdir -p` of the parent, and "file contents cross the text boundary as base64 and remain byte exact". `kill` is the `ContainerSandbox` design, a pidfile per command and a second exec that signals descendants before the recorded pid. `ping` is `kubectl exec <pod> -- true`.

Isolation is the cluster's, not the provider's: the image, the service account, and the namespace's policies decide what a Pod can reach, and the provider only forwards the shaping options above. The image must carry `sh`, `env`, and `base64`. The Ready timeout is fixed. The real-backend suite runs against the `orbstack` context and skips wherever `kubectl cluster-info` does not answer there.

### JustBashSandbox

| Export | Kind | Notes |
| --- | --- | --- |
| `JustBashLike` | interface | the structural slice of a just-bash interpreter, matching the real `Bash.exec(commandLine, options)`: `cwd`, `env`, `stdin` with `stdinKind: "bytes"`, resolving to `{ stdout, stderr, exitCode }` |
| `make` | constructor | builds a `Sandbox.Provider` whose machines are subdirectories of `root` (default `/workspace`) in one virtual filesystem; `bash` and `fs` are required |

```ts
import { JustBashSandbox } from "@smthrs/sandbox"

const provider = JustBashSandbox.make({
  bash: interpreter, // a just-bash instance mounted over the same tree as `fs`
  fs,
  root: "/workspace"
})
```

`acquire` creates `root/<slug>` through the injected `FileSystem` and removes it, recursively, when the scope closes. Commands go to `bash.exec` with the session workdir as `cwd` (a relative spawn `cwd` is rooted under it), the defined entries of the spawn environment, and any spawn `stdin` rendered as a latin1 string under `stdinKind: "bytes"`, the byte representation the interpreter documents; reads, writes, and the native `files` operations (`exists`, `stat`, `readDirectory`, `makeDirectory`, `remove`, `rename`, `realPath`, `readLink`, with relative paths rooted at the workdir) go to the injected `FileSystem`. The caller must mount the interpreter and that service on the same tree: "In a browser this normally means just-bash and `BrowserFileSystem` both view the same ZenFS volume." `ping` always succeeds. There is no machine to reattach; a same-key acquire recreates the directory with a recursive `makeDirectory`, which leaves whatever the mounted tree already holds in place.

"This provider is a workspace boundary, not a security boundary. An interpreted command can address anything its shared virtual filesystem permits." Runs are serialized behind one permit, because just-bash has one mutable filesystem view. A spawn completes before it returns, stdout and stderr each replay at most one chunk, and `isRunning` is already `false` by the time a caller can observe the adapted handle. There is no signal delivery, no separately spawned process pipeline, and no incremental output, so sessions omit `kill` and the conformance kill check is skipped for them. The suite runs the interpreter as a real shell over the same real directory the injected `FileSystem` serves, and the slice is proven assignable from a real just-bash 3.2.0 `Bash` instance, with a negative control against the old shape.

### MicrosandboxSandbox

| Export | Kind | Notes |
| --- | --- | --- |
| `Sdk` | interface | the structural slice of the Microsandbox SDK: `Sandbox.builder(name)` and `Sandbox.get(name)`, with the fluent builder, the single-drain command handle, the lifecycle handle, and the guest filesystem behind them |
| `make` | constructor | builds a `Sandbox.Provider` over local Microsandbox microVMs; `image` (default `oven/bun:1`) or `snapshot`, `workdir`, `shell`, `env`, `persistence`, `cpus`, `maxCpus`, `memoryMib`, `maxMemoryMib`, `maxDurationSecs`, `idleTimeoutSecs`, `security`, `pullPolicy`, `labels`, `scripts`, `detached`, `disableNetwork` |

```ts
import * as Microsandbox from "microsandbox"
import { MicrosandboxSandbox } from "@smthrs/sandbox"

const provider = MicrosandboxSandbox.make({
  sdk: Microsandbox,
  image: "oven/bun:1",
  persistence: "sticky",
  cpus: 2,
  memoryMib: 2048,
  idleTimeoutSecs: 600,
  disableNetwork: true
})
```

The machine name is `smthrs-msb-<slug>`. `acquire` configures the builder and calls `create`; when the SDK answers `sandboxAlreadyExists` it fetches the handle and connects when the machine is running or starts it (detached, for sticky sessions) when it is stopped. "Machine creation is registered as a scoped resource before guest setup, so a microVM that boots but cannot prepare its workspace is stopped." `ephemeral` persistence, the default, stops the machine when the scope closes; `sticky` "deliberately leaves it running so the next acquire of the same session key can reconnect", and only stops a sticky machine it created but could not prepare. Commands run through `execStreamWith(shell, ["-c", command])` with the workdir applied per execution, "because Microsandbox validates a builder workdir before the selected image has booted", and the single-drain handle is collected exactly once; output comes back through the byte-typed `stdoutBytes()`/`stderrBytes()`. Writes use the SDK's byte-safe `fs().write` and reads its byte-typed `fs().read`; standard input rides the exec builder's own `stdinBytes` channel. `ping` reads `/etc/hostname`.

`image` and `snapshot` are exclusive; naming both fails with `unavailable` before any vendor call. Output is collected after the command finishes: one stdout chunk, one stderr chunk, no streaming, and no `kill`. A stopped ephemeral machine is gone with its files. The real-backend suite runs the conformance check against a real microVM only where the `microsandbox` binary answers `--version`.

### VercelSandbox

| Export | Kind | Notes |
| --- | --- | --- |
| `Credentials` | interface | `oidcToken`, or `token` together with `teamId` and `projectId` |
| `Sdk` | interface | the portion of `@vercel/sandbox` used: `Sandbox.getOrCreate`, then `runCommand`, `readFile`, `writeFiles`, `extendTimeout`, and `stop` on the instance |
| `make` | constructor | builds a `Sandbox.Provider` over named, persistent Vercel sandboxes; `env`, `timeoutMs`, `maxDurationMs`, `workdir` (default `/vercel/sandbox`), `runtime`, `commandEnv`, `namePrefix` (default `smthrs-`) |

```ts
import * as vercel from "@vercel/sandbox"
import { VercelSandbox } from "@smthrs/sandbox"

const provider = VercelSandbox.make({
  sdk: vercel,
  token,
  teamId,
  projectId,
  timeoutMs: 30 * 60_000,
  maxDurationMs: 60 * 60_000,
  runtime: "node22"
})
```

The machine name is `smthrs-<slug>`, lowercased. `acquire` calls `Sandbox.getOrCreate` with `persistent: true` and `resume: true`, so a name that already exists is resumed with its filesystem, and the scope finalizer calls `stop()`, which leaves the persistent sandbox in place for the next acquire. Credentials resolve in a fixed order: an explicit `oidcToken` or `VERCEL_OIDC_TOKEN` wins; otherwise `token`, `teamId`, and `projectId` are sent together or not at all; the environment consulted is `options.env`, never `process.env`. "Vercel limits the timeout accepted by one create request to five minutes. Longer requested lifetimes create at that ceiling, then call `extendTimeout` with only the remaining duration because that API extends by its argument rather than setting an absolute target." Commands run as `sh -lc` through `runCommand`, with `commandEnv` under the per-spawn environment. A read drains `readFile`'s stream, string or bytes, into one buffer, and `null` is `not_found`; a write runs `mkdir -p` for the parent and calls `writeFiles`.

`timeoutMs` must be a positive finite number, `maxDurationMs` is a caller-owned cap checked before any vendor request, and `workdir` must be absolute; each refusal is a `spawn_error` raised before anything is acquired. Output arrives after the command finishes, so there is no streaming and no `kill`; `runCommand` has no input channel, so standard input is staged as a workspace file and redirected. There is no real-backend suite; the provider is proven against a fake that keeps the vendor API shapes and runs every command through a real shell against real files.

### DaytonaSandbox

| Export | Kind | Notes |
| --- | --- | --- |
| `Sdk` | interface | the portion of a configured `Daytona` client used: `get`, `create`, `start`, `delete`, and on the instance `getWorkDir`, `process.executeCommand`, `fs.downloadFile`, `fs.uploadFileStream` |
| `make` | constructor | builds a `Sandbox.Provider` over Daytona sandboxes; `workdir`, `commandEnv`, `namePrefix` (default `smthrs-`), `startTimeoutSeconds`, `deleteTimeoutSeconds` (default 60) |

```ts
import { DaytonaSandbox } from "@smthrs/sandbox"

const provider = DaytonaSandbox.make({
  sdk: daytona, // a configured `new Daytona(...)` client
  workdir: "/home/daytona/workspace",
  startTimeoutSeconds: 120
})
```

The machine name is `smthrs-<slug>`, lowercased. `acquire` calls `get(name)` first; a 404 creates a sandbox with that name, and an existing one is started with `startTimeoutSeconds`. "Creation or attachment is registered as a scoped resource before start and workspace preparation, so any later failure still runs the blocking delete finalizer", `delete(sandbox, deleteTimeoutSeconds, true)`. The workdir is `options.workdir` or the sandbox's own `getWorkDir()`, and either must be absolute. Commands run through `process.executeCommand(command, cwd, env)`. "Daytona's byte-native download and stream-upload operations serve file transfer; shell execution creates missing parents": `downloadFile` for reads, with `FILE_NOT_FOUND` mapped to `not_found`, and `uploadFileStream` for writes.

Teardown deletes the sandbox, so nothing survives a normal release; only a crash-left sandbox is found again by name. `executeCommand` returns one `result` string with no stderr field on the wire, so a command's standard error arrives merged into standard output rather than separately, and output arrives after the command finishes; there is no streaming and no `kill`, and standard input is staged as a workspace file and redirected. There is no real-backend suite; the provider is proven against a fake that keeps the documented API and error shapes (unverified live) and runs every command through a real shell against real files.

### AwsSandbox

| Export | Kind | Notes |
| --- | --- | --- |
| `Sdk` | interface | the structural slice of the AWS SDK v3 `ECS` aggregate client: `runTask`, `describeTasks`, `listTasks`, `stopTask`, `registerTaskDefinition`, `deregisterTaskDefinition` |
| `ExecTransport` | interface | how commands reach the task: the AWS CLI and its Session Manager plugin over an injected spawner, with `program`, `globalArgs`, and `chunkBytes` knobs |
| `make` | constructor | builds a `Sandbox.Provider` over Fargate tasks; `region`, `cluster`, `subnets`, and either `taskDefinition` or `image` with `taskRoleArn` are required; `exec` supplies the command transport; `securityGroups`, `assignPublicIp`, `container`, `workdir`, `platformVersion`, `executionRoleArn`, `env`, `pollIntervalMs`, `maxPollAttempts`, and for an image `cpu` and `memory` shape the task |

```ts
import { ECS } from "@aws-sdk/client-ecs"
import { AwsSandbox } from "@smthrs/sandbox"

const provider = AwsSandbox.make({
  sdk: new ECS({ region: "us-west-2" }),
  exec: { spawner },
  region: "us-west-2",
  cluster: "smithers",
  subnets: ["subnet-0abc"],
  securityGroups: ["sg-0abc"],
  image: "ghcr.io/acme/runner:1",
  taskRoleArn: "arn:aws:iam::123456789012:role/runner-task",
  executionRoleArn: "arn:aws:iam::123456789012:role/runner-exec"
})
```

`acquire` first looks for the machine a previous acquire of the same key left running: `ListTasks` filtered by the `startedBy` tag derived from the key, adopted only when `DescribeTasks` shows its `ExecuteCommandAgent` already `RUNNING`, so a crash-interrupted run resumes its task instead of starting a second one beside it. Otherwise it calls `RunTask` with `enableExecuteCommand: true`, `launchType: "FARGATE"`, and that `startedBy`, polls `DescribeTasks` with exponential backoff (capped at 10 seconds, `maxPollAttempts` default 60) until the task is `RUNNING` and its agent is, and registers `StopTask` on the scope; an adopted task is released the same way, so closing the scope always leaves nothing behind. A task that reaches `STOPPED` first fails with `unavailable`; an exhausted poll budget fails with `timeout`. Supplying an image registers a minimal Fargate task definition and deregisters it after the task finalizer runs: family `smthrs-<startedBy>`, `sleep infinity`, `initProcessEnabled`, `cpu` 256 and `memory` 512 by default, container `sandbox`. `env` reaches the task as container overrides, which needs a `container` name or an image-generated definition. `ping` describes the task again and requires the same readiness.

Commands, reads, and writes travel through `ExecTransport`: `aws ecs execute-command --interactive`, driven through the injected spawner, because ECS Exec is two halves and the ECS API implements only one. `ExecuteCommand` opens an SSM session and returns its metadata; the data channel that carries output and status is the Session Manager protocol, which the AWS CLI speaks by delegating to `session-manager-plugin`. The session is a pseudo-terminal, so standard error arrives interleaved on standard output and line endings are normalized; the plugin exits zero whatever the remote command did, so every command is wrapped to print its own status line, and a session that ends without one is `aborted`, never a success. Reads come back as guest `base64` and writes go in as base64 slices bounded by `chunkBytes` (default 3072 bytes before encoding), so file contents are byte-exact despite the terminal. Standard input is staged as a workspace file and redirected. `kill` records each command's guest pid in a session-private pidfile and signals it and its descendants through a second session; closing a spawn's scope does the same for a command not yet seen to end.

Without an `exec` transport the session still provisions and tears down tasks but refuses `spawn`, `readFile`, and `writeFile` with `unavailable`, naming the missing transport, and the conformance suite records fifteen violations for it; with the transport it passes the suite in full. Honest limits: the host running the provider needs the `aws` CLI and `session-manager-plugin` installed; a command's standard error cannot be separated from its output; and no live cluster is driven from this repository, so the transport is proven against a fake that reproduces the plugin's banner, footer, carriage returns, and zero exit over a real local shell, while the exact command length the SSM document accepts is the service's to enforce, which is what `chunkBytes` is for.

### CloudflareSandbox

| Export | Kind | Notes |
| --- | --- | --- |
| `Sdk<Binding>` | interface | the structural slice of `@cloudflare/sandbox`: `getSandbox(binding, id, options)` returning `mkdir`, `writeFile`, `readFile`, `exec`, `startProcess`, and `destroy`; `Binding` stays generic because the real `DurableObjectNamespace` type only exists in a Worker |
| `make` | constructor | builds a `Sandbox.Provider` over Sandbox Durable Objects; `binding` is required, and `execution` (`exec`, the default, or `process`), `workdir`, `sleepAfter`, and `keepAlive` are optional |

```ts
import { getSandbox } from "@cloudflare/sandbox"
import { CloudflareSandbox } from "@smthrs/sandbox"

const provider = CloudflareSandbox.make({
  sdk: { getSandbox },
  binding: env.SANDBOX,
  execution: "exec",
  sleepAfter: "10m"
})
```

"The Worker binding is the credential and infrastructure handle." `acquire` resolves the Durable Object whose id is the session slug, with `enableDefaultSession: false` so the SDK's implicit shell session is never opened, forwards `keepAlive` and `sleepAfter` only when set, registers `destroy()` on the scope, and creates the workdir. In `exec` mode a command is `sandbox.exec` and its completed result; in `process` mode it is `startProcess`, then `waitForExit`, then `getLogs`; a process that reports no exit status on either surface fails with `spawn_error` rather than being given one. "File payloads use the SDK's base64 encoding and the text is read from the result's `content` field. This preserves arbitrary bytes without importing host modules." `FILE_NOT_FOUND` is `not_found`. `ping` runs `exec("true")` in the workdir.

This provider does not create infrastructure. The Durable Object namespace, its container image, and the Worker that holds the binding are deployed by the caller, and the binding is the credential; there is nothing to configure here beyond it. Output arrives after the command completes in both modes, so there is no streaming and no `kill`; the exec options carry no input channel at 0.12.9, so standard input is staged as a workspace file and redirected. The finalizer destroys the object, so a normal release discards its files; only a crash-left object is found again by id. There is no real-backend suite; both execution modes are proven against a fake binding that runs every command through a real shell against real files.

### Browser support

`@smthrs/sandbox` is gated as a browser entry point by `scripts/browser-check.mjs` (`pnpm run browser`, and one CI step). The probe only runs the effect a provider hands it, and host access stays behind the provider layer.

See [Hosts and capabilities](/concepts/hosts-and-capabilities), the [`@smthrs/kernel` reference](/api/kernel), and [failure and retry](/concepts/failure-and-retry).
