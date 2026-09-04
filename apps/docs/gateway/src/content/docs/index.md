---
title: "@smthrs/gateway"
description: "The workspace gateway: one HTTP surface carrying the control plane, the served projections, the journal read path, and a health probe, plus the wire rows every client decodes."
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/gateway/docs/README.md"
---

`@smthrs/gateway` is the HTTP surface a workspace serves to everything that is
not the process running its flows: a product UI in a browser, a second
terminal, a relay, a supervisor deciding whether this process is still the
right one.

It is two halves that ship together.

The **server** is one application layer. `GatewayServer.layer` mounts the
control plane, the served projections, the journal read path, and a health
probe on one router; `NodeGateway.layer` binds that router to a socket under a
bind policy that fails closed. Nothing about the assembly is optional: the
mounts are a fixed set, and a client that reaches one reaches all of them under
one credential.

The **read model** is the other half. A client never reads a database column.
It reads a _projection_: a row folded from the ordered control events
[`@smthrs/control`](https://control.smithers.sh/reference/api/) already publishes. `GatewayProjection` holds
the folds, `GatewaySchema` holds the wire schemas, and `Projections` serves
them as snapshots and followed deltas. The gateway never opens the engine
database, so a projection read through a relay is the same projection a local
reader computes.

## What it mounts

| Path                | Protocol           | Serves                                          |
| ------------------- | ------------------ | ----------------------------------------------- |
| `POST /rpc`         | RPC over HTTP      | `@smthrs/control` `ControlRpcs`                 |
| `/rpc/ws`           | RPC over WebSocket | `ControlRpcs`, including a kept-alive `Watch`   |
| `POST /projections` | RPC over HTTP      | `GatewayRpcs`                                   |
| `/projections/ws`   | RPC over WebSocket | `GatewayRpcs`, including `Projection.Subscribe` |
| `POST /sync`        | RPC over HTTP      | `@smthrs/sync` `SyncRpcs`                       |
| `/sync/ws`          | RPC over WebSocket | `SyncRpcs`                                      |
| `GET /health`       | JSON               | the workspace identity, unauthenticated         |

## Who uses this package

Hosts compose `NodeGateway.layer` to serve a workspace. [`smthrs serve`](https://smithers.sh/docs/reference/cli/serve/)
is the shipped host, and [`@smthrs/cli`](https://cli.smithers.sh/reference/api/) `NodeControl.layerGateway`
is the composition it uses.

Clients decode the rows. A browser, a relay, or another CLI reads
`GatewaySchema.ProjectionSnapshot` and `GatewaySchema.GatewayFrame` and submits
approvals back with the payload the projection published.

## Install

```bash
pnpm add @smthrs/gateway
```

For the services a host must also supply, see [Installation](/installation/).

## The smallest real host

```ts
import * as NodeGateway from "@smthrs/gateway/node/NodeGateway"

// The caller supplies what the mounts read through: Control, Projections,
// SyncServer, and the SyncAuth middleware.
const gateway = NodeGateway.layer(
  { workspaceHash: "8f4b2c1d90a37e56", gatewayId: "cli-4821", protocolVersion: "1", version: "1.0.0-rc.0" },
  { host: "127.0.0.1", port: 7331 }
)
```

That bind is loopback, so it needs no credential and no opt-in. Its requests
still need a loopback `Host`, and any supplied browser `Origin` must be
loopback; Origin-less CLI clients remain accepted. Anything else needs both a
bind opt-in and a bearer, and the layer fails with a typed `bind_failed`
`GatewayError` rather than binding. See
[Serve beyond loopback](/guides/serve-beyond-loopback/).

For a gateway you can probe and read within a minute, start with the
[Quickstart](/quickstart/).

## The package at a glance

The root entry point exports these namespaces, and each local one is also
importable from `@smthrs/gateway/<Module>`:

| Namespace                   | What it is                                                                                         |
| --------------------------- | -------------------------------------------------------------------------------------------------- |
| `GatewayServer`             | The whole HTTP surface as one application layer: mounts, ingress guard, and the `Watch` keepalive. |
| `node/NodeGateway`          | The Node host: bind policy, credential policy, and the socket.                                     |
| `Projections`               | The served read path, as bounded snapshots and followed deltas.                                    |
| `GatewayProjection`         | The wire rows and the pure folds that compute them from control events.                            |
| `GatewaySchema`             | The wire schemas: selectors, cursors, snapshots, and subscription frames.                          |
| `GatewayRpcs`               | The served read procedures and the one composite approval mutation.                                |
| `Diagnosis`                 | What happened to a run, folded and rendered from that run's own events.                            |
| `GatewayError`              | The nine-code failure vocabulary every gateway operation answers in.                               |
| `SuperviseRuntime`          | The host seam a supervisor would implement. Declared, not installed.                               |
| `Sync`                      | `@smthrs/sync` whole, so a host gets the journal read path from one import.                        |
| `test/TestSuperviseRuntime` | A controllable supervision runtime for tests.                                                      |

Every export of every namespace, with signatures, is on the
[API reference](/reference/api/).

## Where to go next

- [Installation](/installation/): requirements, import forms, and the four
  services a host supplies.
- [Quickstart](/quickstart/): serve a workspace, probe it, and read a
  projection off the wire.
- Concepts: [projections](/concepts/projections/),
  [subscriptions and cursors](/concepts/subscriptions/), and
  [the trust boundary](/concepts/trust-boundary/).
- Guides: [host the gateway](/guides/host-the-gateway/),
  [read a projection](/guides/read-a-projection/),
  [follow a run](/guides/follow-a-run/),
  [submit an approval](/guides/submit-an-approval/),
  [serve beyond loopback](/guides/serve-beyond-loopback/),
  [diagnose a run](/guides/diagnose-a-run/), and
  [test against a real gateway](/guides/testing/).
- [Troubleshooting](/troubleshooting/): the refusals this package answers
  with, what causes each, and what to change.
