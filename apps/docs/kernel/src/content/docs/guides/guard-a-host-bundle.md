---
title: "Guard a host bundle"
description: "Compose HostServices.layer over a platform bundle so every consumer of the five host tags resolves the guarded implementation, and get the composition order right."
sidebar:
  order: 1
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/flows/kernel/docs/guides/guard-a-host-bundle.md"
---

`HostServices.layer` turns a raw platform bundle into the guarded surface a
flow body runs on. This guide covers the composition, the order its pieces go
in, and the two mistakes that quietly defeat it.

## What the layer needs

`HostServices.layer` both requires and provides all five host tags, and it
additionally requires:

- `Workspace`, the root that filesystem capability resources are resolved
  against.
- `GrantStore`, the service that decides.

Every member requires the tag it provides, so the guarded implementation
shadows the raw one for everything downstream.

## The composition

```ts
import { GrantStore, HostServices, Workspace } from "@smthrs/kernel"
import * as NodeHost from "@smthrs/platform-node/NodeHost"
import { Layer } from "effect"

const workspaceRoot = "/absolute/path/to/workspace"

const guarded = HostServices.layer.pipe(
  // 1. The decider, beneath the decorators that consult it.
  Layer.provide(Layer.orDie(GrantStore.layer({ attended: false, rules: policy }))),
  // 2. The raw platform, beneath the decorators that shadow it. `provideMerge`
  //    because the composition below still needs the tags this bundle carries
  //    that the kernel does not decorate.
  Layer.provideMerge(NodeHost.layerAt(workspaceRoot)),
  // 3. The workspace root, which both the store and the filesystem decorator
  //    resolve resources against. One value, provided once, so they agree.
  Layer.provide(Workspace.layer(workspaceRoot))
)
```

`GrantStore.layer` fails with `GrantStoreError` when its options are invalid,
which is a programming error rather than a runtime condition, so
`Layer.orDie` is the honest handling. Both the store and the filesystem
decorator take the workspace root from the same `Workspace` service, so
provide it once above both.

## Contain processes at the same time

Under `NodeHost.layerAt`, a spawned child is signalled when its scope closes
and then waited for, forever if it ignores `SIGTERM`, and a host that dies
without closing its scopes abandons every child it started.
`NodeHost.layerContainedAt` adds the escalation deadline, the ledger, and the
reaper:

```ts
import { ProcessLedger } from "@smthrs/kernel"

const guarded = HostServices.layer.pipe(
  Layer.provide(Layer.orDie(GrantStore.layer({ attended: false, rules: policy }))),
  Layer.provideMerge(NodeHost.layerContainedAt(workspaceRoot)),
  Layer.provideMerge(ProcessLedger.layer({ hostId: "my-host", ownerPid: process.pid })),
  Layer.provide(Workspace.layer(workspaceRoot))
)
```

`ProcessLedger.layer` needs a `Journal`. For a host that has none, or one that
should inherit nothing from a previous incarnation, use
`ProcessLedger.layerMemory` with the same options. See
[Contain spawned processes](/guides/contain-spawned-processes/).

## Two mistakes to avoid

**Keeping an unguarded alias.** The guarded layer shadows the raw tag for
everything composed above it. Code that captured the raw service before the
decorator was composed, or that resolves it from a context built without the
decorator, is not guarded. If some part of the host genuinely needs unguarded
access, give it a **separate service** rather than a stale reference to the
shared one. The engine does exactly that: its snapshot bookkeeping uses a
private `Jj` service built over the raw host, so it grants no repository
authority to the action context.

**Guarding the engine's own bookkeeping.** A database directory the engine
must create in order to exist at all cannot be something the engine asks
permission for, and a whole-tree sandbox copy is engine bookkeeping rather
than an agent reaching for a file. Build the engine's storage over the raw
host and the flow body's services over the guarded one. An action resolves its
host services from the engine's context, which is why the engine is built
**over** the kernel rather than beside it.

## The real thing

`@smthrs/flows`'s `NodeRuntime` is this composition at full size: the Node
host with containment on, the kernel over an unattended store, storage, the
step boundary, the workspace sandbox, the engine, and signal handling. Read it
when you need the whole picture rather than the shape.

## Related

- [Write a capability policy](/guides/write-a-capability-policy/): what goes in
  `rules`.
- [Decoration in place](/concepts/decoration-in-place/): why the layer is
  shaped this way.
