---
title: "@smthrs/control"
description: "The Smithers control plane: the transport-independent Control service, the two ports it writes through, the projections it reads back, and the RPC boundary that puts all of it on a wire."
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/control/docs/README.md"
---

`@smthrs/control` is the control plane for durable runs: the service an
operator, a CLI, a gateway, or another agent uses to plan work, approve it,
start it, watch it, steer it, and stop it.

`Control` is authority, not execution. It never runs a flow. Every mutation it
accepts is idempotent, principal-stamped, and recorded in the journal beside
the state change it caused, so "who asked for this, and when did it take
effect?" is answered from persisted evidence rather than from a log line.

Three seams keep that promise honest, and a host chooses an implementation of
each:

- `ControlRuntime` is the persistence port: plans, approval tokens, grants,
  idempotency records, and the fenced run rows. `ControlRuntime.layerMemory`
  is the deterministic in-memory one; `SqlControlRuntime.layer` is the durable
  one over a SQL database and the fenced run store.
- `ControlExecutor` is the execution port: the plane hands a launch, a cancel,
  a signal, or a resume to a real engine and learns only what the engine did
  with it.
- `ControlServer` and `ControlClient` are the transport: the same `Control`
  vtable served as RPC and projected back on the other side of a wire. A caller
  handed either one cannot tell which it has.

## Who uses this package

Operators reach it through the [`smithers` CLI](https://smithers.sh/docs/reference/cli/ps/) and never import it.
Hosts import it: a CLI, a gateway, an MCP server, or a supervisor that needs to
plan a run, decide an approval, or watch a journal it did not write. Flow
authors reach it only where a step consults a durable decision, as an in-run
approval does.

## Install

```bash
pnpm add @smthrs/control
```

For the collaborators a working composition adds, see
[Installation](/installation/).

## The smallest real program

Plan a flow, then ask to run it. A plan starts unapproved, so the launch parks
instead of starting anything:

```ts
import { Control } from "@smthrs/control/Control"
import type * as ControlRuntime from "@smthrs/control/ControlRuntime"
import * as TestControl from "@smthrs/control/test/TestControl"
import * as Effect from "effect/Effect"

/** One flow this plane may be asked to plan. */
const Deploy: ControlRuntime.MemoryFlow = {
  flowId: "quickstart/Deploy",
  description: "Deploys one build",
  deployClass: true,
  envelope: { capabilities: ["process:spawn"], flows: [], budget: {} }
}

const program = Effect.gen(function*() {
  const control = yield* Control
  const card = yield* control.plan({ flowId: "quickstart/Deploy", input: { build: "v1.4.0" } })
  return yield* control.run({
    _tag: "Plan",
    planId: card.planId,
    digest: card.digest,
    envelope: card.envelope,
    idempotencyKey: "deploy:v1.4.0"
  })
})

// { _tag: "Parked", receiptId: "deploy:v1.4.0", planId: "plan-1", status: "waiting-approval" }
console.log(
  await Effect.runPromise(program.pipe(Effect.provide(TestControl.layer({ flows: [Deploy] }))))
)
```

The [Quickstart](/quickstart/) carries this through approval, launch,
listing, and a watch, with no database and no engine.

## The package at a glance

The root entry point exports these namespaces, and each is also importable from
`@smthrs/control/<Module>`:

| Namespace                               | What it is                                                                                                                                |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `Control`                               | The service: `plan`, `run`, `approve`, `deny`, `steer`, `signal`, `cancel`, `resume`, `list`, `watch`.                                    |
| `ControlSchema`                         | The serializable values both halves of the wire decode: `PlanCard`, `RunSummary`, `Receipt`, `SteerMessage`, and the RPC request schemas. |
| `ControlError`                          | Every stable failure the plane emits, as classes and as one membership schema.                                                            |
| `ControlLive`                           | The in-process implementation over `ControlRuntime`, the journal, the notification queue, and the registry.                               |
| `ControlRuntime`                        | The persistence port, plus `layerMemory`, its deterministic in-memory implementation.                                                     |
| `SqlControlRuntime`                     | The durable persistence adapter over a SQL database and the fenced run store.                                                             |
| `ControlExecutor`                       | The execution port: launch, cancel, signal, resume, and the park settlement a cancel needs.                                               |
| `ControlRpcs`                           | The ten remote procedures, the authentication middleware, and a bearer authenticator.                                                     |
| `ControlServer`                         | The RPC handlers and the HTTP plus WebSocket mount.                                                                                       |
| `ControlClient`                         | The RPC client projected back into the `Control` interface.                                                                               |
| `Lineage`                               | How a run came to exist: `child`, `fork`, or `continuation`, derived from run rows and journal entries.                                   |
| `Cancellation`                          | Who cancelled a run, why, and whether it was swept up in an ancestor's cascade.                                                           |
| `Steering`                              | The steer lifecycle: the enqueue the plane records and the delivery it derives from the queue.                                            |
| `Monitor`                               | Run health as a pure classification, and the beat loop that acts on it.                                                                   |
| `Channels`                              | Verified ingress: an external request becomes a control mutation, once.                                                                   |
| `WebhookChannel`                        | A schema-declared webhook channel and its bounded HTTP handler.                                                                           |
| `Credential`                            | The credential boundary: only a reference crosses it, never a secret.                                                                     |
| `CredentialStore`, `CredentialCipher`   | The persistence and encryption ports behind it.                                                                                           |
| `SqlCredentialStore`, `WebCryptoCipher` | Their durable and AES-256-GCM adapters.                                                                                                   |
| `Migrations`                            | The package's namespaced migration set and the layer that runs it.                                                                        |
| `SystemFlows`                           | The reserved CLI verb to flow-id catalog, and which of those a runtime may plan.                                                          |

Every export of every namespace, with its signature, is on the
[API reference](/reference/api/).

## Where to go next

- [Installation](/installation/): requirements, import forms, and the
  packages a runnable composition adds.
- [Quickstart](/quickstart/): plan, approve, launch, list, and watch, in one
  in-memory program.
- Concepts: [authority, not execution](/concepts/authority/),
  [receipts and idempotency](/concepts/receipts/),
  [ownership, fences, and claims](/concepts/ownership/),
  [journal projections](/concepts/projections/),
  [run lineage](/concepts/lineage/), and
  [cancellation attribution](/concepts/cancellation/).
- Guides: [gate work behind an approval](/guides/approvals/),
  [find runs](/guides/list-runs/), [watch a run](/guides/watch-a-run/),
  [steer a run](/guides/steer-a-run/),
  [signal a waiting run](/guides/signal-a-run/),
  [cancel and restart a run](/guides/cancel-and-resume/),
  [store control state in a database](/guides/durable-storage/),
  [connect an execution engine](/guides/implement-an-executor/),
  [serve the plane over RPC](/guides/serve-over-rpc/),
  [monitor and heal a run](/guides/monitor-runs/),
  [accept a webhook](/guides/ingest-a-webhook/),
  [store a credential](/guides/store-credentials/), and
  [test against the plane](/guides/testing/).
- [Troubleshooting](/troubleshooting/): the refusals this package reports,
  what causes them, and what to change.
