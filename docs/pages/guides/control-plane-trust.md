---
description: "The trust boundary of the control server: what it accepts, from whom, and where authorization stops."
---

# Control-plane trust posture

The alpha control server has a deliberately small trust boundary: it accepts
one shared HTTP bearer token and maps every valid request to one configured
principal. This authenticates access to the deployment; it does not provide
users, roles, per-flow permissions, or per-run ownership. Any holder of the
token can perform every control operation the server exposes.

## Safe default

`NodeControl.layerServer` and `layerServerBearerAuth` bind to `127.0.0.1` when
no host is supplied. A non-loopback host is rejected unless the host adapter
passes the explicit `listen: true` opt-in corresponding to `--listen`:
the [`@smthrs/cli` API reference](/api/cli) lists the complete composition
surface.

```ts
import { NodeControl } from "@smthrs/cli"

const server = NodeControl.layerServerBearerAuth(
  {
    token: process.env.FLOWS_CONTROL_TOKEN ?? "",
    principal: { id: "alpha-operator", kind: "bearer" }
  },
  { host: "0.0.0.0", port: 3000, listen: true }
)
```

An empty configured token fails closed: no request authenticates. The
permissive `layerServerNoopAuth` helper is confined to literal loopback hosts
even when `listen: true` is passed; it exists only for tests and explicitly
trusted local processes.

`--listen` removes only the network-bind guard. It does not add encryption,
rotate the token, or change authorization. Put any non-loopback deployment
behind TLS, source its token from a secret manager, and restrict ingress at the
network boundary. A bearer token sent over plaintext HTTP can be replayed by
anyone who observes it.

## Authenticated CLI requests

Remote CLI commands attach the credential to HTTP RPC requests and WebSocket
upgrades as `Authorization: Bearer <credential>`:

```sh
smithers --remote https://control.example.test --credential "$FLOWS_CONTROL_TOKEN" plan system/test
smithers --remote https://control.example.test --credential "$FLOWS_CONTROL_TOKEN" ps
```

Missing, malformed, empty, and incorrect credentials all return the same typed
`Unauthorized` control error. The client does not put the credential into an
RPC payload. The `--credential` value can still be visible to local process
inspection and shell history, so this flag is suitable for the private alpha,
not a final secret-input interface.

## Authorization limit

There is no separate run-owner policy in the alpha. The unused `NotOwner`
error was removed rather than advertising enforcement that never occurred.
Engine claim and fence failures remain represented by `ClaimLost`; those
protect durable execution from stale workers and are not user authorization.
Use a separate control deployment and token for each trust domain until a
multi-principal policy is implemented.
