---
title: "The trust boundary"
description: "What one gateway credential authorizes, why a network bind needs two opt-ins, which paths are checked at the edge and which authenticate in band, and what a refusal is allowed to say."
sidebar:
  order: 3
---

A gateway is a control plane on a socket. It can launch runs, cancel them,
steer them, and approve capability grants. Every rule here exists because the
failure it prevents is silent: an unauthenticated control plane on a laptop's
network address is a remote execution service that looks like a dev server.

## One credential, one principal

There are no users, no roles, no per-run ownership, and no scopes. One shared
bearer credential authenticates every mount, and the server stamps one
principal on whatever it authorizes.

That principal is server-owned, never client-supplied. A configured credential
stamps `{ id: "gateway", kind: "bearer" }`; a loopback bind with no credential
runs as `{ id: "local", kind: "operator" }`. A decision journaled under the
composition's default operator when a bearer holder made it would name the
wrong one, so `Approval.Submit` reads the authenticated principal and passes it
through to Control rather than letting the runtime default apply.

`GatewaySchema.TokenScope` and `TokenRecord` describe a scoped-token model this
release has no route for. See
[Declared but not served](../api.md#declared-but-not-served).

## Two rules gate a bind, and both fail closed

1. **A non-loopback host requires an explicit `listen` opt-in.** Binding
   `0.0.0.0` because a port was free is how a workspace gateway ends up on a
   shared network by accident.
2. **A non-loopback bind requires a bearer credential.** Reachable from another
   machine, an unauthenticated control plane is a remote execution service.

A loopback bind with no credential is allowed, and is the local default. The
trust boundary there is the machine account, and requiring a token to talk to
your own workspace would only teach people to write it down.
`NodeGateway.isLoopbackHost` accepts `127.0.0.1`, `::1`, and `localhost`, and
nothing else.

`NodeGateway.bindRefusal` answers the policy as a value, so a host can inspect
it before composing anything. `listenOptions` returns the same refusal in its
typed effect channel, and `layer` fails through its layer channel. Operating
system listen failures, an address already in use among them, are mapped to the
same sanitized `bind_failed` contract, so a caller has one shape to handle.

## Edge authentication, and where it deliberately stops

`GatewayServer.protectedPaths` is checked before a body is read or an upgrade
is answered: `/projections`, `/sync`, `/rpc/ws`, `/projections/ws`, and
`/sync/ws`.

`POST /rpc` is deliberately not on that list. The control mount authenticates
in band through `ControlRpcs.ControlAuth`, whose declared error is
`ControlError.Unauthorized`, and that typed control error is the refusal
[the control plane publishes](/docs/guides/control-plane/): missing, malformed,
empty, and incorrect credentials all return the same typed error. An edge 401
answered ahead of the mount, and `ControlClient` filters a non-2xx status, so
every refusal reached a caller as a `TransportError`: the one class
`@smthrs/control` reserves for a request that failed _before_ a declared
control response reached it. It also made the gateway refuse a call differently
from `NodeControl.layerServer` hosting the very same `ControlRpcs`.

The body limit still applies to `/rpc`, so an unauthenticated caller buys one
bounded body read and nothing else.

`/rpc/ws` stays edge-authenticated for a different reason. A socket is a
resource the server holds open, the RPC middleware can only refuse frames on a
socket that already exists, and a refused handshake has no RPC channel to
answer a typed error on. Its refusal is a transport fact either way.

## A path is classified the way the router will resolve it

The guard runs before the router, so it has to reach the router's verdict. An
alias it did not recognize would walk past the credential check and the body
limit and be answered by the mount anyway.

Measured against `HttpRouter` on this tree, all of `/%72pc`,
`/rpc;transport-parameter`, `/rpc/`, `//rpc`, `///rpc`, `/rpc//`, `/RPC`,
`/./rpc`, and `/foo/../rpc` reach the `/rpc` handler, while `/rpc%2f`,
`/rpc%3Bp`, `/%2frpc`, and `/rpc%20` do not.

`GatewayServer.routedPath` reproduces that. It resolves dot segments with
`URL`, takes each segment without its `;` parameter, drops empty segments,
decodes the rest with `decodeURI`, and compares without regard to case.
`decodeURI` rather than `decodeURIComponent` is what leaves a reserved
character encoded, which is what keeps `/rpc%2f` a different path here exactly
as it is to the router. An invalid escape is left as written, because it names
no mount either way.

This is not only about crafted aliases. `ControlClient`'s HTTP protocol posts
every call to `/rpc/`, so a literal comparison skipped the body limit on the
path the product's own client uses.

The normalization errs toward matching: a spelling it resolves to a mount that
the router then refuses is answered 401 rather than 404, which costs an
unauthenticated caller nothing it was entitled to.

## Ingress runs before the transport parses anything

`GatewayServer.layerIngress` is one global middleware, and it does three things
in order for a `POST` to an RPC mount:

1. Refuses an unauthenticated request to a protected path with 401
   `unauthorized`.
2. Refuses a body over the limit with 413 `request_too_large`. A declared
   `content-length` over the limit is refused without reading the body; a body
   that declares no length, or declares less than it sends, is measured as it
   is read.
3. Refuses a body carrying no RPC request message with 400
   `malformed_request`.

The third check exists because `effect/unstable/rpc` hands every decoded
message to the server loop, and a body that decodes to something else, `{}`,
`[]`, prose, or nothing at all, reached it as a message with no tag and died
there. The gateway answered `500 Internal Server Error` with an empty body,
which is the wrong half of the contract twice over: it tells an operator the
gateway broke, and it tells a client to retry a request that can never succeed.

The transport's own parser answers that question, not a second reading of the
wire format, so whatever `RpcSerialization` the host composed is the one
authority. A body naming a procedure that does not exist is a _yes_: that is an
RPC-level defect the protocol itself reports. A binary framing is always a yes,
because its body is not text and the mount owns it.

## Health carries identity and nothing else

`GET /health` is unauthenticated on purpose. A supervisor decides whether to
keep or replace a gateway process by asking which workspace it belongs to, and
a probe that needed a credential could not answer that about a gateway it did
not start.

The response carries the workspace hash, the gateway id, the protocol version,
and the package version. It never carries a token, a run, or a path. The
workspace hash is a digest of the resolved project root rather than the root
itself, because the path names directories on the operator's machine.

`/health` also answers while the rest of the process is degraded. A gateway
whose read path cannot read still comes up and still answers the identity
question, because startup must never be blocked by a subsystem that failed to
recover.

## A refusal says the least it can

`GatewayError.cause` carries a redacted summary of an internal failure: its tag
and its stable code, never its message, its nested cause, or the SQL and file
paths a `PersistenceError` carries. The whole cause is logged server-side
instead.

The reason is the error's reach. `GatewayError` is the RPC error schema, so
anything left on it is serialized to every bearer holder and forwarded to the
browser by the product relay, and a cause JSON cannot encode would make the
error frame itself fail to encode.
