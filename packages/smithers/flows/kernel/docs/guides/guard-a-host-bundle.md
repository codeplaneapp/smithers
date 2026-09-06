---
title: "Guard a host bundle"
description: "Compose HostServices.layer over a platform bundle so every consumer of the five host tags resolves the guarded implementation, and get the composition order right."
sidebar:
  order: 1
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

Under `NodeHost.layerAt`, the raw spawner signals its target at scope close.
That target can ignore the signal or exit while descendants keep running, and
a crashed host runs no finalizers. `NodeHost.layerContainedAt` adds a live
supervisor, a cleanup deadline, a ledger, and restart reconciliation. Keep
the permission decorator above it so the caller's complete command is
authorized before platform preparation:

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
[Contain spawned processes](./contain-spawned-processes.md).

## Two mistakes to avoid

**Keeping an unguarded alias.** The guarded layer shadows the raw tag for
everything composed above it. Code that captured the raw service before the
decorator was composed, or that resolves it from a context built without the
decorator, is not guarded. If some part of the host genuinely needs unguarded
access, give it a **separate service** rather than a stale reference to the
shared one. [`@smthrs/engine`](/api/engine) does exactly that: its snapshot
bookkeeping holds a private `Jj` service built over the raw host, so the flow
bodies it runs get no repository authority from it.

**Guarding your own bookkeeping.** The guarded surface exists to check the
code you did not write. The machinery your host needs in order to run at all,
the directory its database lives in, the working copy it lays down before it
hands anything to a subject, has to exist before there is anyone to ask, so it
cannot be behind a permission check. Build that machinery over the raw bundle,
build the services you hand to the guarded code over the decorated one, and
give the guarded code no way to reach the first set.

## The real thing

[`@smthrs/flows`](/api/flows) composes this at full size in its `NodeRuntime`:
the Node host with containment on, the kernel over an unattended store,
storage, the step boundary, the workspace sandbox, the engine, and signal
handling. [Stand up a Node runtime](/pkg/flows/guides/stand-up-a-node-runtime)
walks it when you need the whole picture rather than the shape.

## Related

- [Write a capability policy](./write-a-capability-policy.md): what goes in
  `rules`.
- [Decoration in place](../concepts/decoration-in-place.md): why the layer is
  shaped this way.
