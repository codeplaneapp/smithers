---
title: "@smthrs/keys"
description: "Derive one stable identity for a structured value, and validate an identity read back from storage without hashing it a second time."
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/flows/keys/docs/README.md"
---

`@smthrs/keys` turns a structured value into one stable identity string:

```text
key1_74a286a394e4b0619c05801dd4e7315deeb83b8203cd3c3ee7cd6033ec55c683
```

Two values that mean the same thing derive the same key on every host and in
every release, so a cache lookup, a replay, and a database row all agree about
what "the same work" is. The engine keys every durable step this way, and
[`@smthrs/flow`](https://flow.smithers.sh/reference/api/) mints an execution id this way.

## These keys are not secrets

The name is about identity, not authentication. A key here is an unkeyed
SHA-256 digest of a canonical JSON document, so anyone who can guess or
enumerate the input can recompute the key. Treat a key as a public identifier,
never as a bearer token, a password, or proof that its holder knows the input.
This package stores nothing: it reads no files, no environment variables, and
no global state, and it holds your input only for the length of one derivation.

## The two operations

Deriving a key and validating one are separate calls, and the split is the
point. `deriveKey` hashes structured input; `StoredKey` checks that text you
already hold is a key this release understands and hands it back unchanged.
Decoding a key through the derivation would hash the key itself and quietly
produce a different one, so the package refuses to blur the two.

```ts
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import { deriveKey, StoredKey } from "@smthrs/keys"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"

// Derive: structured input in, one key out. Needs a Crypto service.
const key = await Effect.runPromise(
  deriveKey({ domain: "example/compile", version: 1, source: "main.ts" }).pipe(
    Effect.provide(NodeCrypto.layer)
  )
)
// key1_74a286a394e4b0619c05801dd4e7315deeb83b8203cd3c3ee7cd6033ec55c683

// Validate: text in, the same text out. Needs no Crypto service.
const parsed = Schema.decodeUnknownSync(StoredKey)(key)
// parsed === key
```

## The package at a glance

The root entry point exports one module, and each export is also reachable at
`@smthrs/keys/Key`:

| Export                                         | What it is                                                                                                              |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `deriveKey`                                    | Derives a key from a structured value. Requires an Effect `Crypto` service and fails with a typed `KeyDerivationError`. |
| `DerivedKey`                                   | The same derivation as a schema, for composing inside a larger decode. Never reports the input in a schema issue.       |
| `StoredKey`                                    | Validates a key read back from storage. Returns the text unchanged and requires no `Crypto` service.                    |
| `KeyV1`                                        | The one stored representation this release understands. `StoredKey` is currently equal to it.                           |
| `digest`                                       | Returns the 64-character SHA-256 payload of a validated key, without the `key1_` prefix.                                |
| `KeyDerivationError`, `KeyDerivationErrorCode` | The two ways derivation fails, each with a stable code and a preserved cause.                                           |

Every signature is on the [API reference](/reference/api/).

## Where to go next

- [Installation](/installation/): the package, and the one service it needs
  you to provide.
- [Quickstart](/quickstart/): derive a key, store it, and read it back.
- [The contract](/contract/): what this package guarantees, what it refuses
  to guarantee, and what stays yours.
- Concepts: [key derivation](/concepts/key-derivation/),
  [key material](/concepts/key-material/), and
  [the wire format](/concepts/wire-format/).
- Guides: [validate a stored key](/guides/validate-a-stored-key/),
  [derive a key inside a schema](/guides/derive-a-key-inside-a-schema/),
  [separate identity namespaces](/guides/separate-identity-namespaces/), and
  [handle a derivation failure](/guides/handle-a-derivation-failure/).
- [Testing](/testing/): supply a `Crypto` service to a test, and freeze the
  wire vectors that matter.
- [Troubleshooting](/troubleshooting/): the failures you will actually hit.
