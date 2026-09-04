---
title: "Key material"
description: "What canonicalization does to the value you hash: the distinctions it erases, the values it refuses, the code it runs, and the bounds it does not impose."
sidebar:
  order: 2
---

Key material is whatever you pass to `deriveKey`. The key is a digest of the
canonical form of that value, not of the value itself, so some distinctions you
can see in JavaScript never reach the digest, and some values have no canonical
form at all. Both facts belong in your protocol design rather than in a later
debugging session.

## Distinctions the digest never sees

These come from [`@smthrs/canonical`](/api/canonical). Two inputs that differ
only in one of these ways derive the same key:

| In your value                                  | In the canonical document                                    |
| ---------------------------------------------- | ------------------------------------------------------------ |
| Property order                                 | Keys sorted by UTF-16 code unit, so order never contributes. |
| `-0`                                           | `0`.                                                         |
| A member whose value is `undefined`            | The member is absent.                                        |
| A member whose value is a function or a symbol | The member is absent.                                        |
| An `undefined` array element or an array hole  | `null`.                                                      |
| A boxed `String` or `Number`                   | The primitive it wraps.                                      |
| An `effect` `Redacted`                         | The literal string `"<redacted>"`.                           |

The `Redacted` row is the one that bites. Redaction is a `toJSON` method, so
canonicalization serializes the placeholder, not the secret. Two different
secrets produce one canonical document and therefore one key. Nothing fails.
A protocol that keys on a `Redacted` field silently treats two different
credentials as the same work, and a cache built on it serves one caller's
result to another. Never put a `Redacted` value in key material. If a
credential must contribute to an identity, derive a separate digest from it
deliberately and hash that.

Where any other erasure matters to your identity, encode the distinction
explicitly. A tag field or a sentinel string survives; the JavaScript-level
difference does not.

Structure itself is never erased. Moving a character across a boundary changes
the document, so `["a", "bc"]` and `["ab", "c"]` are different keys, and so are
`{ a: { b: 1 } }` and `{ "a.b": 1 }`. Type survives too: `{ value: 1 }` and
`{ value: "1" }` differ.

## Values with no canonical form

Canonicalization refuses rather than approximates, so derivation fails with the
code `canonicalization_failed` for:

- `NaN`, `Infinity`, and `-Infinity`.
- A `BigInt`.
- A lone UTF-16 surrogate, in a key or a value.
- A circular reference.
- A value nested more than 10,000 levels below the root.
- A non-plain object with no `toJSON` method: `Map`, `Set`, `RegExp`, `Error`,
  a typed array, or one of your own class instances.
- A `toJSON` method or a property getter that throws.

An object that does define `toJSON` serializes through it, which is why a
`Date` derives a key from its ISO string rather than failing.

Encode the rest yourself before deriving, and freeze the choice the way you
would a wire format: a `Map` becomes a sorted array of pairs, a `BigInt`
becomes a decimal string, a byte array becomes hexadecimal.

## Serialization is not a sandbox

Canonicalization walks a live JavaScript object, and walking it runs code:
property getters, proxy traps, and `toJSON` methods all execute. Do not hand
`deriveKey` a hostile object.

For anything that arrived from outside your process, decode it into inert data
first, then derive:

```ts
import { deriveKey } from "@smthrs/keys"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"

const Request = Schema.Struct({
  target: Schema.String,
  flags: Schema.Array(Schema.String)
})

/** Decode first, so the value that reaches derivation has no behavior. */
const keyForRequest = (body: unknown) =>
  Schema.decodeUnknownEffect(Request)(body).pipe(
    Effect.flatMap((request) =>
      deriveKey({ domain: "docs/request", version: 1, target: request.target, flags: request.flags })
    )
  )
```

## Bounds are yours to impose

Derivation is one-shot. It holds your input, the canonical document it
produces, and the digest for the length of the call and releases them with it.
Nothing is written to disk, cached, or retained anywhere in this package.

The package adds no byte-size limit and no nesting limit of its own. The only
bound in the chain is the canonicalizer's 10,000-level nesting cap. A megabyte
of untrusted JSON canonicalizes into a megabyte of document and hashes it, so
cap the size of input you do not control before derivation, the way you would
before any other parse.

## Naming your material

Include a stable domain and a material version in every structured input, so
one protocol's identities can never occupy another's namespace and a change to
the material re-keys deliberately rather than by accident:

```ts
const material = { domain: "engine/action", version: 1, target: "web" }
```

The reasoning and the failure it prevents are in
[Separate identity namespaces](../guides/separate-identity-namespaces.md).
