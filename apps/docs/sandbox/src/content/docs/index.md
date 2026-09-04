---
title: "@smthrs/sandbox"
description: "Provisioned machines for flows: two provider seams, Effect host services derived from them, two conformance suites, liveness, and nine bundled machine providers."
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/flows/sandbox/docs/README.md"
---

`@smthrs/sandbox` puts a flow's file operations and child processes on a
machine that is not the one running the flow.

It contains no vendor SDK, reads no host global, and opens no socket of its
own. A provider adapts a backend (a container, a microVM, a cloud runner) to
one of two contracts, and this package derives everything else from that
contract: Effect's `ChildProcessSpawner` and `FileSystem`, a liveness probe,
heartbeat supervision, and two conformance suites that state each contract as
behavior an adapter has to produce.

## The two seams

Which contract a backend can satisfy is decided by what its transport can do,
not by how much you want from it.

- `RemoteChildProcessSpawner.Provider` runs one rendered command line and
  reports `stdout`, `stderr`, and an exit code. That is enough to satisfy
  Effect's `ChildProcessSpawner` and nothing more. Use it when something else
  already provisioned the machine.
- `Sandbox.Provider` owns a machine's whole lifecycle. `acquire(key)` creates
  or reattaches one machine and hands back a `Session`: byte-typed file
  transfer beside the same spawn, torn down when the acquiring scope closes.
  A session is what you need to place work, because a body that edits a file
  and then compiles it needs the file operations and the processes to see one
  tree.

Everything built on the narrower seam composes with the wider one:
`Sandbox.commandProvider` projects a lifecycle provider back down to a spawn
provider, so the adapter, the health probe, supervision, and the provider
conformance suite all work unchanged.

## Who uses this package

Hosts place a flow body or an agent's standard tools on a provisioned machine
with `Sandbox.layerHost`. Provider authors implement one of the two seams and
prove the adapter with the matching conformance suite. Both audiences share the
same warning: this package adapts whatever isolation a backend gives you and
adds none of its own. Read
[What a sandbox does and does not prevent](/concepts/isolation/) before you
rely on one.

## Install

```bash
pnpm add @smthrs/sandbox
```

For runtime requirements, import forms, and the vendor SDKs each provider
expects, see [Installation](/installation/).

## The smallest real example

Hold one machine and serve the host surface from it. The body asks for
Effect's ordinary services and never names a provider:

```ts
import { DirectorySandbox, Sandbox } from "@smthrs/sandbox"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as ChildProcess from "effect/unstable/process/ChildProcess"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"

const body = Effect.gen(function*() {
  const fs = yield* FileSystem.FileSystem
  const spawner = yield* ChildProcessSpawner
  yield* fs.writeFileString("report.txt", "placed\n")
  return yield* spawner.string(ChildProcess.make("wc", ["-c", "report.txt"]))
})

const placed = (fs: FileSystem.FileSystem, spawner: ChildProcessSpawner["Service"]) =>
  body.pipe(
    Effect.provide(
      Sandbox.layerHost(
        DirectorySandbox.make({ fs, spawner, root: "/var/tmp/smithers" }),
        { session: "run:01J..." }
      )
    )
  )
```

The [Quickstart](/quickstart/) runs this end to end and prints the byte
count. Swapping `DirectorySandbox` for `ContainerSandbox` or
`MicrosandboxSandbox` changes nothing above the provider construction.

## The package at a glance

Every namespace is also its own import subpath, for example
`@smthrs/sandbox/Sandbox`.

| Namespace                   | What it is                                                                                                                |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `Sandbox`                   | The provisioned-machine contract, its projections (`commandProvider`, `fileSystem`, `layerHost`), and provider selection. |
| `RemoteChildProcessSpawner` | The spawn-only contract and its adapter onto Effect's `ChildProcessSpawner`.                                              |
| `SandboxHealth`             | The liveness taxonomy and the deadline-bounded probe that reports it.                                                     |
| `SandboxSupervision`        | A heartbeat that retires a dead session so its commands fail instead of waiting.                                          |
| `ProviderConformance`       | The suite a spawn-only provider must pass.                                                                                |
| `SandboxConformance`        | The suite a lifecycle provider must pass.                                                                                 |
| `DirectorySandbox`          | Machines are directories on this host. The conformance reference, and no boundary at all.                                 |
| `JustBashSandbox`           | Commands are interpreted in-process over a shared virtual filesystem, for hosts that cannot spawn.                        |
| `ContainerSandbox`          | One container per session, over a Docker-compatible CLI.                                                                  |
| `KubernetesSandbox`         | One Pod per session, over `kubectl`.                                                                                      |
| `MicrosandboxSandbox`       | One local microVM per session, optionally holding the workspace's Nix environment.                                        |
| `VercelSandbox`             | One persistent Vercel sandbox per session.                                                                                |
| `DaytonaSandbox`            | One Daytona sandbox per session.                                                                                          |
| `AwsSandbox`                | One Fargate task per session, driven through ECS Exec.                                                                    |
| `CloudflareSandbox`         | One Sandbox Durable Object per session, behind a Worker binding.                                                          |

## Where to go next

- [Installation](/installation/): requirements, import forms, and what each
  provider expects you to install.
- [Quickstart](/quickstart/): place a flow body on a real machine and read
  its result.
- Concepts: [the two seams](/concepts/seams/),
  [sessions and their keys](/concepts/sessions/),
  [what a sandbox does and does not prevent](/concepts/isolation/), and
  [how a remote command differs from a local one](/concepts/remote-commands/).
- Guides: [place a flow body on a machine](/guides/place-a-flow-body-on-a-machine/),
  [run commands through a transport](/guides/run-commands-through-a-transport/),
  [choose a provider](/guides/choose-a-provider/),
  [supervise a session](/guides/supervise-a-session/),
  [write a provider](/guides/write-a-provider/),
  [prove a provider](/guides/prove-a-provider/), and
  [test against a scripted machine](/guides/testing/).
- [Limits](/limits/): what this package bounds and what it buffers whole.
- [Troubleshooting](/troubleshooting/): the failures this package reports
  and what to change.
- [API reference](/reference/api/): every export, with signatures and behavior.
