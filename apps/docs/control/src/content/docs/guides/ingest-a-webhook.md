---
title: "Accept a webhook as a control request"
description: "Turn a verified external request into one control mutation: the verify-then-decode order, the durable idempotency a redelivery replays, the headers that may enter identity, and the body ceiling."
sidebar:
  order: 11
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/control/docs/guides/ingest-a-webhook.md"
---

A channel turns an external request into a control mutation, once. It verifies
opaque bytes before it decodes them, and it acquires no execution path of its
own: everything it does, it does through `Control`.

## Build a webhook channel

```ts
import * as WebhookChannel from "@smthrs/control/WebhookChannel"
import * as Effect from "effect/Effect"
import * as Redacted from "effect/Redacted"
import * as Schema from "effect/Schema"

const Push = Schema.Struct({ ref: Schema.String })

const github = WebhookChannel.make({
  name: "github",
  schema: Push,
  credential: Redacted.make({ id: "github-webhook", name: "GitHub webhook" }),
  fingerprintHeaders: ["x-github-event"],
  verify: (raw, credential) => verifySignature(raw, credential),
  map: (payload) =>
    Effect.succeed({
      _tag: "Start" as const,
      flowId: "ops/Deploy",
      input: { build: payload.ref }
    }),
  project: (run) => ({ cursor: run.status, operation: "post", message: { text: run.runId } })
})
```

`map` returns one of two results:

| Result                              | Becomes                                  |
| ----------------------------------- | ---------------------------------------- |
| `{ _tag: "Start", flowId, input }`  | `control.plan` followed by `control.run` |
| `{ _tag: "Signal", runId, signal }` | `control.signal`                         |

`decode` and `map` must be deterministic and free of side effects. A retry may
evaluate either of them again.

The credential is a redacted `CredentialRef`, never a secret. Resolving it
belongs at the host adapter boundary, so a webhook's persisted record never
holds key material. See [Store and resolve a credential](/guides/store-credentials/).

## Register and mount it

```ts
import * as Channels from "@smthrs/control/Channels"

const program = Effect.gen(function*() {
  const channels = yield* Channels.Channels
  yield* channels.register(github)
})
```

`Channels.layer` builds the coordinator over `ControlRuntime`'s durable
mutation store, so inbound idempotency survives a coordinator restart. Only
registration and outbound projection cursors are process-local.
`Channels.layerMemory` is process-local throughout and exists for adapter unit
tests.

`WebhookChannel.handler` reads an abstract Effect HTTP request and dispatches
it, so any Effect HTTP host can mount it:

```ts
HttpRouter.post("/webhooks/github", WebhookChannel.handler("github", deliveryId))
```

Take `deliveryId` from the platform's own delivery header. That is what makes a
redelivery the same mutation instead of a second one.

## The order verification happens in

`ingest` runs one request at a time, and in this order:

1. Copy the request: the bytes, and only the enumerable own string headers,
   lower-cased, with a duplicate case-insensitive name refused.
2. Compute the body fingerprint.
3. **Verify**, with the verifier's own copy of the body. Signature verification
   is the amplification guard, so it happens before decode and before any
   `Control` access. The verifier receiving its own copy means even a verifier
   that edits bytes cannot change what the decoder sees after approval.
4. Look the durable idempotency record up. A match replays the stored receipt.
5. Decode, map, and dispatch through `Control`.
6. Record the receipt, unless it was a `Conflict`.

The receipt handed back carries the platform's own delivery id as its
`receiptId`, so a caller correlating against its own logs sees the id it sent.

## What enters durable identity

The fingerprint is the SHA-256 of the body plus only the header names the
adapter declared in `fingerprintHeaders`, matched case-insensitively and sorted.

Declare a header there only when its value changes the decoded command, as
`x-github-event` does. Signature, authorization, cookie, token, and credential
headers must not be declared: rotating an excluded credential header leaves the
delivery identical, which is what you want.

Reusing one delivery id with different declared semantics answers `Conflict`.

## The body ceiling

A webhook is the one control-plane ingress a caller reaches with an arbitrary
payload, so `handler` bounds the body twice:

- A `content-length` over the limit is refused before the body is read at all,
  so a declared flood costs nothing.
- The measured length is checked again afterwards, so a caller that lies low or
  declares nothing gains nothing.

Both refusals are `InvalidInput` naming the two byte counts and no body
content. The default is `WebhookChannel.maximumBodyBytes`, 1 MiB, and one mount
lowers it:

```ts
WebhookChannel.handler("github", deliveryId, { maximumBodyBytes: 256 * 1024 })
```

The default is deliberately smaller than the 4 MiB mutation identity budget: a
body that cannot become a durable mutation is refused at the door rather than
copied, decoded, and refused later.

## Project a run back out

`project` is side-effect free. It turns a `RunSummary` and the previous
delivery record into a `DeliveryProjection`, and the transport adapter performs
the network call after the projection is journaled:

| `operation` | Meaning                               |
| ----------- | ------------------------------------- |
| `post`      | Send a new message.                   |
| `edit`      | Update the message `messageId` names. |
| `noop`      | Nothing changed worth sending.        |

Keeping delivery out of the projection is what lets a reconnect update an
existing platform message instead of posting a second one.

## Where to go next

- [Store and resolve a credential](/guides/store-credentials/): where the verifier's
  secret comes from.
- [Receipts and idempotency](/concepts/receipts/): the store behind a
  replayed redelivery.
- [Gate work behind an approval](/guides/approvals/): an ingested `Start` still
  parks until somebody approves it.
