---
title: "Derive a key inside a schema"
description: "Use DerivedKey to make derivation one step of a decode pipeline, and read the typed KeyDerivationError back out of the schema issue it produces."
sidebar:
  order: 2
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/flows/keys/docs/guides/derive-a-key-inside-a-schema.md"
---

`DerivedKey` is `deriveKey` with a schema face. Reach for it when the
derivation belongs in the middle of a decode you are already running, and for
`deriveKey` when you want the typed failure directly. Both perform the same
three steps and produce the same key.

This is the form the rest of Smithers uses. [`@smthrs/flow`](https://flow.smithers.sh/reference/api/) decodes
an encoded payload through it to mint an execution id, and
[`@smthrs/engine`](https://engine.smithers.sh/reference/api/) decodes an action's key material through it to
derive the key the dispatch is recorded under.

## Decode a value into its key

```ts
import { DerivedKey } from "@smthrs/keys"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"

const keyOf = (material: unknown) => Schema.decodeUnknownEffect(DerivedKey)(material)

const program = keyOf({ domain: "docs/schema", version: 1, target: "web" }).pipe(
  Effect.map((key) => `recorded under ${key}`)
)
```

The result is a `KeyV1`, and the effect requires `Crypto.Crypto` exactly as
`deriveKey` does.

## Chain it after another decode

Deriving from something you just validated is one pipeline. Decode first so the
value that reaches the hash has a known shape and no behavior:

```ts
import { DerivedKey } from "@smthrs/keys"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"

const Material = Schema.Struct({
  domain: Schema.Literal("docs/schema"),
  version: Schema.Literal(1),
  target: Schema.String
})

const keyForBody = (body: unknown) =>
  Schema.decodeUnknownEffect(Material)(body).pipe(
    Effect.flatMap((material) => Schema.decodeUnknownEffect(DerivedKey)(material))
  )
```

## Encoding is refused

`DerivedKey` decodes only. Encoding a key back toward its input fails with
`A key cannot be converted back into its input`, because a digest cannot
reconstruct what produced it. Use the schema where you decode, and store the
key as ordinary text.

## The input never reaches a schema issue

`DerivedKey` pins `parseOptions: { reportInput: false }` on itself. A failure
becomes a schema issue whose message names only the code and a fixed sentence:

```text
[canonicalization_failed] Key input could not be canonicalized
```

That holds even when an enclosing caller asks for input reporting, which is the
behavior you want when the value being hashed is a request body, a user-supplied value,
or a multi-megabyte document. The annotation is on the schema, so nothing
composed above it can turn it back on.

## Read the typed error back out

The typed `KeyDerivationError` is not discarded by the schema. It is retained
on the failing issue's annotations as `cause`, next to the stable `code`, so
composition does not cost you the failure's identity. For a direct decode the
issue chain is one `Encoding` wrapper around one `InvalidValue`:

```ts
import { KeyDerivationError } from "@smthrs/keys"

const annotatedCause = (issue: { readonly annotations?: { readonly cause?: unknown } }) =>
  issue.annotations?.cause instanceof KeyDerivationError ? issue.annotations.cause : undefined
```

Nested inside a larger schema the issue sits deeper, so treat this as a
diagnostic reach rather than a control-flow path. Where you want to branch on
the code, call `deriveKey` and match on it directly. See
[Handle a derivation failure](/guides/handle-a-derivation-failure/).
