---
title: "Authority-free channels"
description: "Why an inbound channel can only ask for a start or a signal, how verification runs before any decoding, and what the private snapshot of a request protects."
sidebar:
  order: 4
---

A webhook is a door into a system, and a door that carries its own authority is
a door somebody else can walk through. `Channel` is the shape of that door in
this package, and the whole design is about what it cannot do.

## A channel asks for one of two things

`Channel.Inbound` is a union of exactly two shapes:

```ts
type Inbound =
  | { readonly start: { readonly flowId: string; readonly input: unknown } }
  | {
    readonly signal: {
      readonly runId: string
      readonly stepId: string
      readonly value: unknown
    }
  }
```

Start a flow, or resolve a step that is waiting. There is no third shape, and
neither of the two carries capabilities, grants, or an execution envelope, which
is the authority a run executes under. A verified payload names a flow; it does
not get to say what that flow is allowed to do. The target flow's envelope, its
approvals, and the host's permission checks apply exactly as they would if a
person had started it.

That is what "authority-free" means here, and it is why a channel declaration is
safe to accept from an integration author: the worst a mistaken declaration can
do is start the wrong flow with the wrong input, which is a bug rather than a
privilege escalation.

## Verification runs on bytes, before decoding

`Channel.Verify` receives the raw request and a redacted credential reference:

```ts
type Verify = (
  raw: RawInbound,
  credential: Redacted.Redacted<CredentialRef>
) => Effect.Effect<void, TriggerError>
```

Two details in that signature carry weight.

**The verifier sees `RawInbound`, not a decoded payload.** A signature covers
the bytes that arrived, so verification has to happen before any JSON parse or
schema decode. It does: verification runs inside the Control channel
coordinator's ingest, ahead of the adapter's decoder and ahead of every Control
operation. A request with a bad signature never reaches the mapping function.

**The credential arrives per request, as a reference.** It is a
`Redacted<CredentialRef>`, which is a name for a stored secret rather than the
secret. The verifier resolves it through the host's resolver when it needs the
bytes. Handing it over per request is what lets a verifier hold no secret of its
own: the alternative is capturing one in plain memory at declaration time, which
is the shape the reference exists to prevent.

`Webhook.Config.credential` is required for a related reason. A door has to name
the credential it verifies against, because two declarations that differ only in
credential are two different doors. There is no default, and nothing is inferred
from the channel's name.

## The request is snapshotted before anything reads it

`Webhook.ingest` copies `body`, `headers`, and `idempotencyKey` at the moment
the caller hands the request over, not when the returned Effect eventually runs.
The signature verifier then gets its own copy of the body on top of that.

The property this buys: verification, delivery fingerprinting, and decoding all
read one private snapshot. A verifier that edits the bytes it was handed, and a
caller that reuses its own buffer between building the Effect and running it,
cannot authenticate one payload and have a different one decoded. The same copy
lifts a `SharedArrayBuffer`-backed view out of shared memory.

## Registration is separate from ingestion

`Webhook.make` returns a door with three members: `name`, `register`, and
`ingest`. There is no `run` and no `start`.

`ingest` does not register. A channel is registered once, deliberately, through
`register`, so traffic arriving at a door nobody opened is reported as
unavailable rather than silently self-registering. Call `register` at host
startup, before you accept traffic.

## Outbound projection

A channel may also project run state back out. `Channel.outbound` maps the run
type the channel was declared over, which is a Control `RunSummary` for a
webhook, to whatever the transport posts. When a declaration omits it, the
projection is a `noop` operation carrying the run's cursor, so a channel that
only ingests does not have to pretend to publish.

## Next

Build one: [Ingest a verified webhook](../guides/ingest-a-webhook.md).
