---
title: "Serve the control plane over RPC"
description: "Mount the same Control service as HTTP and WebSocket RPC, project it back into the Control interface on a client, authenticate with a bearer token, and read the transport failures a client can retry."
sidebar:
  order: 9
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/control/docs/guides/serve-over-rpc.md"
---

Everything the in-process control plane does is reachable remotely, and nothing
about the vtable changes to make that true. `ControlServer.layerHttp` mounts
the same `Control` service as RPC; `ControlClient.layer` projects the RPC
client back into the identical `Control` interface. A caller handed either one
cannot tell which it has.

## Mount the server

```ts
import { NodeHttpServer } from "@effect/platform-node"
import * as ControlRpcs from "@smthrs/control/ControlRpcs"
import * as ControlServer from "@smthrs/control/ControlServer"
import * as Layer from "effect/Layer"
import { HttpRouter } from "effect/unstable/http"
import { RpcSerialization } from "effect/unstable/rpc"
import { createServer } from "node:http"

const served = HttpRouter.serve(
  ControlServer.layerHttp.pipe(
    Layer.provide(ControlRpcs.layerBearerAuth({
      token: process.env["SMITHERS_CONTROL_TOKEN"] ?? "",
      principal: { id: "operator", kind: "bearer" }
    })),
    Layer.provide(RpcSerialization.layerNdjson)
  )
).pipe(
  Layer.provideMerge(NodeHttpServer.layer(createServer, { host: "127.0.0.1", port: 0 }))
)
```

`layerHttp` mounts both protocols together: unary procedures over
`POST /rpc`, and the `watch` stream over `WebSocket /rpc/ws`. The operations
divide cleanly. Plan, approve, run, and list are requests with answers; `watch`
is a projection that keeps arriving, so it rides a socket.

`ControlServer.layer` is the handler layer alone, for a host that mounts its
own protocols.

## Connect a client

```ts
import { NodeHttpClient, NodeSocket } from "@effect/platform-node"
import * as ControlClient from "@smthrs/control/ControlClient"

const client = ControlClient.layer({
  url: "http://127.0.0.1:4000/rpc",
  credential: process.env["SMITHERS_CONTROL_TOKEN"]
}).pipe(
  Layer.provide([
    NodeHttpClient.layerUndici,
    NodeSocket.layerWebSocket("ws://127.0.0.1:4000/rpc/ws"),
    RpcSerialization.layerNdjson
  ])
)
```

`credential` is attached as a bearer token on every HTTP RPC request. Provide
the client layer and every program written against `Control` works unchanged.

## Authenticate

`ControlRpcs.ControlAuth` is the middleware boundary, and it provides
`ControlPrincipal` to every handler.

| Layer                                   | Use                                                                      |
| --------------------------------------- | ------------------------------------------------------------------------ |
| `layerBearerAuth({ token, principal })` | One shared token. Every request carrying it receives the same principal. |
| `layerAuth(authenticator)`              | Your own header authenticator, returning a principal or `Unauthorized`.  |
| `layerNoopAuth(principal?)`             | Trusted in-process use and tests. Authenticates nothing.                 |

The bearer comparison is constant time, and a missing, malformed, empty, or
incorrect credential all fail closed with the same `Unauthorized` response.
This is an intentionally small trust boundary, not a per-user authorization
system.

A custom authenticator is an object with one method:

```ts
import { Unauthorized } from "@smthrs/control/ControlError"
import type * as ControlRpcs from "@smthrs/control/ControlRpcs"
import * as Effect from "effect/Effect"

const authenticator: ControlRpcs.Authenticator = {
  authenticate: (headers) =>
    lookupSession(headers["x-session"]).pipe(
      Effect.map((session) => ({ id: session.userId, kind: "user", stampedAt: Date.now() })),
      Effect.mapError(() => new Unauthorized({ message: "A valid session is required" }))
    )
}
```

## The server stamps identity, always

Every mutation that records who asked reads `ControlPrincipal` and stamps it,
rather than forwarding whatever the client sent. The identity the middleware
authenticated is the only one the server can stand behind, and it is what
reaches the journal, `RunSummary.cancellation`, and a steer's notification
provenance.

`Steer` is the one payload that carries a principal on the wire, because an
in-process caller names one that is not an operator. Over RPC the
authenticated identity replaces whatever arrived. See
[attribution over a wire](/guides/steer-a-run/).

## Failures a client sees

`ControlClient` normalizes everything into `ControlError`. A declared control
failure crosses the wire as itself; anything else becomes `TransportError`,
whose `retryable` flag classifies only the transport phase:

| Cause                                                  | `retryable` |
| ------------------------------------------------------ | ----------- |
| Connection, socket open, read, write, or close failure | `true`      |
| HTTP 5xx                                               | `true`      |
| HTTP 4xx                                               | `false`     |
| Request encode failure                                 | `false`     |
| Response decode failure                                | `false`     |
| Invalid client URL                                     | `false`     |

Resend a retryable mutation only when its idempotency key makes replay safe. A
keyless request can have reached the server even when its response was lost.

`ControlClient.isControlError` is `Schema.is` of the same union the errors are
declared in, so an error class added to the package reaches the refinement
without anyone updating a second list.

An operator's own interruption is re-raised exactly as it arrived rather than
described as a transport failure. Cancelling a request is not the server
failing.

## Where to go next

- [The complete loopback example](https://github.com/smithersai/smithers/blob/main/examples/src/24-control-plane-and-gateway.ts):
  a discovered flow planned, approved, launched, and watched over the wire.
- [Watch a run's events](/guides/watch-a-run/): the operation the WebSocket exists
  for.
- [`smthrs serve`](https://smithers.sh/docs/reference/cli/serve/): the shipped server over this layer.
