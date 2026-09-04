---
title: "@smthrs/kernel"
description: "The capability kernel: the closed list of platform ports every side effect enters through, and the middleware layers that check a capability before any of them acts."
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/flows/kernel/docs/README.md"
---

`@smthrs/kernel` is the boundary between a Smithers flow and the machine it
runs on.

Everything that touches the outside world enters through one of five service
tags: `FileSystem`, `Path`, `ChildProcessSpawner`, `Jj`, and `HttpClient`. The
kernel decorates each of those tags **in place**, with a middleware `Layer`
over the very tag a platform adapter provides. Composed over a host bundle,
the guarded implementation shadows the raw one, so code that never heard of
the kernel is guarded anyway. There is no second, protected tag to import,
and therefore no way to hold the unguarded service by accident.

Before each operation the decorator names it as a capability, an action and a
resource, and asks a `GrantStore` whether it may proceed. The store consults
the fiber's authority ceiling, evaluates the policy rules, and answers allow,
deny, or ask. Ask is the default for anything no rule matched: nothing here
silently allows.

## Install

```bash
pnpm add @smthrs/kernel
```

For the runtime requirements, the import forms, and the packages a real
composition adds, see [Installation](/installation/).

## The smallest real example

One policy, one guarded host, one refused command:

```ts
import { Capability, GrantStore, HostServices, Permission, Workspace } from "@smthrs/kernel"
import * as TestHost from "@smthrs/kernel/test/TestHost"
import { Effect, FileSystem, Layer, Option, type PlatformError } from "effect"
import * as ChildProcess from "effect/unstable/process/ChildProcess"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"

const policy = [
  new Permission.Rule({
    effect: "allow",
    pattern: new Capability.CapabilityPattern({ action: "fs:read", resource: "/workspace/**" })
  })
]

const guarded: Layer.Layer<HostServices.HostService> = HostServices.layer.pipe(
  Layer.provide(Layer.orDie(GrantStore.layer({ attended: false, rules: policy }))),
  Layer.provideMerge(TestHost.layer({ files: { "/workspace/README.md": "# hello" } })),
  Layer.provide(Workspace.layer("/workspace")),
  Layer.orDie
)

const program = Effect.gen(function*() {
  const fs = yield* FileSystem.FileSystem
  // Allowed by the rule above.
  yield* fs.readFileString("/workspace/README.md")

  // No rule matches `proc:spawn`, and an unattended store has nobody to ask.
  const spawner = yield* ChildProcessSpawner
  const failure = yield* Effect.flip(spawner.string(ChildProcess.make("ls")))
  const denial = Option.getOrThrow(
    Permission.fromPlatformError(failure as PlatformError.PlatformError)
  )
  return denial.code // "permission_required"
}).pipe(Effect.provide(guarded))
```

The `fs.readFileString` call is Effect's own filesystem method. Nothing in the
program mentions permission, and the refusal still arrives, as a
`PlatformError` whose cause carries the structured kernel failure.
[Quickstart](/quickstart/) builds this up step by step and shows the
attended half, where a person answers the request instead.

## Who uses this package

Host authors compose `HostServices.layer` over a platform bundle to build the
surface a flow body runs on. Platform packages implement the five ports and
attach the filesystem confinement extension the kernel requires. Control
planes drive the attended `GrantStore`: they read pending requests, show them
to an operator, and reply. Flow and action authors normally use none of this
directly; they call the ordinary Effect services and the checks happen
underneath.

## The package at a glance

The root entry point exports these namespaces, and each module is also
importable from `@smthrs/kernel/<Module>`:

| Namespace                  | What it is                                                                                                                                                 |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Capability`, `Permission` | Re-exports of [`@smthrs/capability`](https://capability.smithers.sh/reference/api/): the capability vocabulary, patterns, effect tiers, policy rules, and the typed permission failures. |
| `CapabilitySet`            | The fiber's monotone authority ceiling. Its public operations preserve or narrow authority and can never widen it.                                         |
| `GrantStore`               | The decision service: `check` asks, `reply` answers, `list` shows what is parked, `grantEnvelope` approves a plan's whole set at once.                     |
| `GrantEvent`               | The five durable wire shapes a decision is persisted as.                                                                                                   |
| `JournalGrantStore`        | A `GrantStore` that writes each decision to the journal before activating it, and replays the history on the next process.                                 |
| `HostServices`             | The closed port list (`HostService`, `HostServiceTags`, `HostServiceIds`) and the aggregate decorator `layer`.                                             |
| `FileSystem`               | The `fs:read` and `fs:write` decorator, canonical resource resolution, and the two host confinement extensions.                                            |
| `ChildProcessSpawner`      | The `proc:spawn` decorator over Effect's spawner tag.                                                                                                      |
| `ContainedSpawner`         | Kill-escalation and ledger recording over the same tag, so cancelling a run leaves no process behind.                                                      |
| `ProcessLedger`            | The host's durable record of the processes it started, and the orphans a dead incarnation left.                                                            |
| `CommandLine`              | The one renderer shared by the `proc:spawn` resource and the adapters that execute the line.                                                               |
| `HttpClient`               | The `net:get`, `net:post`, and `model:call` decorator over Effect's HTTP client tag.                                                                       |
| `Jj`                       | The Jujutsu decorator over [`@smthrs/jj`](https://jj.smithers.sh/reference/api/)'s own tag.                                                                                              |
| `Path`                     | Effect's path service, passed through explicitly: pure string manipulation carries no authority to guard.                                                  |
| `Workspace`                | The workspace root that makes filesystem capability resources stable.                                                                                      |

Every export of every namespace, with signatures, limits, and error codes, is
on the [API reference](/reference/api/).

## Where to go next

- [Installation](/installation/): requirements, subpaths, and the platform
  package a real host adds.
- [Quickstart](/quickstart/): guard a host, refuse a call, and answer a
  permission request.
- Concepts: [decoration in place](/concepts/decoration-in-place/),
  [how a grant decision is made](/concepts/grant-decisions/),
  [filesystem confinement](/concepts/filesystem-confinement/), and
  [process containment](/concepts/process-containment/).
- Guides: [guard a host bundle](/guides/guard-a-host-bundle/),
  [write a capability policy](/guides/write-a-capability-policy/),
  [answer permission requests](/guides/answer-permission-requests/),
  [persist grants across restarts](/guides/persist-grants-across-restarts/),
  [authorize network and model calls](/guides/authorize-network-and-model-calls/),
  [contain spawned processes](/guides/contain-spawned-processes/), and
  [adapt a new host platform](/guides/adapt-a-new-host-platform/).
- [Testing](/testing/): the grant-store doubles, the deterministic host
  bundle, and the shared host contract suite.
- [Troubleshooting](/troubleshooting/): the refusals this package produces
  and what each one asks you to change.

## What the kernel does not do

The kernel checks capabilities at adapter call sites. It does not sandbox the
operating system, and it cannot observe host access that bypasses the
decorated services: a dependency that reaches for `node:fs` directly is
outside its view. Hermetic execution additionally requires a `StepBoundary`
from [`@smthrs/engine`](https://engine.smithers.sh/reference/api/).
