---
title: "Serve beyond loopback"
description: "Bind a gateway on a network address: the two opt-ins the policy requires, the credential every mount then enforces, and the request limits worth setting at the same time."
sidebar:
  order: 5
---

A loopback gateway needs no credential. Its ingress still accepts only a
loopback `Host` and, when present, a loopback browser `Origin`; Origin-less CLI
requests keep working. Anything reachable from another machine needs two
opt-ins, and the policy refuses the bind rather than serving without them.

## The two rules

1. **A non-loopback host requires an explicit `listen` opt-in.**

   ```text
   Refusing non-loopback gateway bind 0.0.0.0 without an explicit --listen opt-in
   ```

2. **A non-loopback bind requires a bearer credential.**

   ```text
   Refusing non-loopback gateway bind 0.0.0.0 without a bearer credential
   ```

`NodeGateway.isLoopbackHost` accepts `127.0.0.1`, `::1`, and `localhost`.
Every other host, a LAN address and a public one alike, is treated as reachable
from elsewhere.

Both refusals are `bind_failed` `GatewayError` values, answered before anything
binds.

## Bind it

```ts
import * as NodeGateway from "@smthrs/gateway/node/NodeGateway"

const gateway = NodeGateway.layer(health, {
  host: "0.0.0.0",
  port: 7331,
  listen: true,
  credential: process.env.SMITHERS_API_KEY,
  // Optional, and worth setting behind a relay that cuts idle tunnels sooner
  // than 600 seconds.
  heartbeatMillis: 10_000,
  // Optional. One MiB by default.
  maxRequestBodyBytes: 256 * 1024
})
```

From the command line, the same bind is:

```bash
smthrs serve --host 0.0.0.0 --port 3000 --listen --credential "$SMITHERS_API_KEY"
```

`--credential` falls back to `SMITHERS_API_KEY`. See
[Serve the workspace gateway](/pkg/cli/guides/serve-the-workspace-gateway).

## What the credential then covers

One credential authenticates every mount and binds one principal,
`{ id: "gateway", kind: "bearer" }`. There are no users, no roles, no per-run
ownership, and no scopes.

The loopback Host/Origin restriction belongs to the credential-less local
mode. A bearer-protected non-loopback gateway accepts the network hostname it
was deployed under and relies on the configured credential instead.

Clients send it as a bearer token:

```bash
curl -s https://gateway.example.com/projections \
  -H "authorization: Bearer $SMITHERS_API_KEY" \
  -H 'content-type: application/json' \
  --data-binary '{"_tag":"Request","id":1,"tag":"Projection.Snapshot","payload":{"selector":{"_tag":"workspace-runs"}},"headers":[]}
'
```

A WebSocket client sends the same header on the upgrade request. Node's global
`WebSocket` cannot set headers on an upgrade, so a browser reaches a
credentialed gateway through a relay that holds the credential rather than
holding it itself.

`/health` stays unauthenticated even here. It answers identity and nothing
else: no token, no run, no path.

## Two refusals that look alike and are not

`POST /rpc` is not edge-authenticated. It authenticates in band and answers
`@smthrs/control`'s typed `Unauthorized`, so a caller sees a control error
rather than a transport error, exactly as it would against a control server
hosting the same procedures. `/rpc/ws`, `/projections`, `/sync`, and both other
sockets are checked at the edge and answer 401 with a `unauthorized`
`GatewayError` body.

Why the two differ, and why it matters to a client's error handling, is in
[the trust boundary](../concepts/trust-boundary.md#edge-authentication-and-where-it-deliberately-stops).

## Bound the requests while you are here

An HTTP RPC body is capped at `GatewayServer.defaultMaxRequestBodyBytes`, one
MiB. A declared `content-length` over the limit is refused without reading the
body; a body that declares no length, or declares less than it sends, is
measured as it is read. Over the limit is 413 `request_too_large`; a body the
server could not read for any other reason is 400 `malformed_request`, because
that request cannot be retried smaller.

`maxRequestBodyBytes` and `heartbeatMillis` are checked the same way and must
both be positive safe integers. A body limit of zero would refuse every request
and a cadence of zero would spin, so a composition that asks for either is
refused with `bind_failed` before it binds rather than after it is serving.

## Check the policy without composing anything

```ts
const refusal = NodeGateway.bindRefusal(options)
if (refusal !== undefined) {
  // refusal.code === "bind_failed", refusal.message names the rule that refused
}
```

`bindRefusal` is the same value `listenOptions` fails with and `layer` fails
through. Operating system listen failures, such as an address already in use,
are mapped to the same sanitized `bind_failed` shape, so a host has one failure
contract to handle rather than two.
