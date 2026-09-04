---
title: "@smthrs/canonical"
description: "RFC 8785 canonical JSON for Smithers: one document, one byte sequence, so a digest taken on one host matches the digest taken on another."
---

`@smthrs/canonical` turns a value into exactly one string. `{ a: 1, b: 2 }` and
`{ b: 2, a: 1 }` are the same document, so they serialize to the same bytes and
hash to the same digest.

Every digest in Smithers passes through this package first. A step key, a plan
digest, a cache key, and a derived flow key are all hashes of JSON, so two
structurally equal values must serialize identically or the same work would key
differently on two hosts. Property order, number formatting, and string
escaping all have to be pinned, and
[RFC 8785](https://www.rfc-editor.org/rfc/rfc8785.html) is the standard that
pins them.

## Who uses this package

Anything that content-addresses structured data. Inside Smithers that is
[`@smthrs/keys`](/api/keys), which hashes a canonical document into a `key1_`
flow key; [`@smthrs/core`](/api/core), which computes synchronous content
fingerprints; and [`@smthrs/control`](/api/control), which digests plan cards
and authenticates credential metadata against canonical bytes. Outside
Smithers, reach for it whenever a hash, a cache key, or a signature must agree
across processes, hosts, and releases.

## Install

```bash
pnpm add @smthrs/canonical
```

The package requires Node.js 22.19.0 or later and depends only on
[`effect`](https://effect.website). For the import forms, see
[Installation](./installation.md).

## The shortest real example

```ts
import { canonicalize } from "@smthrs/canonical"

canonicalize({ flowId: "build", input: { target: "//app:lib", clean: false } })
// => '{"flowId":"build","input":{"clean":false,"target":"//app:lib"}}'
```

The same value written in any other member order produces the same string,
which is the whole point: hash it and you have a key that does not depend on
who built the object.

The Effect schema is the same serialization with a type behind it:

```ts
import { Canonical } from "@smthrs/canonical"
import * as Schema from "effect/Schema"

const document = Schema.decodeUnknownSync(Canonical)({ b: 2, a: 1 })
// => '{"a":1,"b":2}', branded as Canonical

Schema.encodeUnknownSync(Canonical)(document)
// => { a: 1, b: 2 }
```

## The package at a glance

```ts
import { Canonical, CanonicalError, canonicalize } from "@smthrs/canonical"
import type { CanonicalErrorCode } from "@smthrs/canonical"
```

| Export               | What it is                                                                                                                          |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `canonicalize`       | Serializes a value into an RFC 8785 document, or throws a `CanonicalError`.                                                         |
| `Canonical` (schema) | The same serialization as an Effect codec: decoding produces a branded document, encoding parses it back.                           |
| `Canonical` (type)   | The branded string type only the schema can mint, so a string that merely looks like JSON cannot stand in for a canonical document. |
| `CanonicalError`     | A `TypeError` carrying a stable `code` and the JSON-style `path` of the value that has no canonical form.                           |
| `CanonicalErrorCode` | The nine stable failure identifiers.                                                                                                |

Full signatures are on the [API reference](./api.md).

## Where to go next

- [Installation](./installation.md): requirements, import forms, and what is
  not public.
- [Quickstart](./quickstart.md): derive a content key from a value and prove it
  does not depend on member order.
- [The serialization contract](./serialization.md): every rule that fixes the
  bytes, and the values that have no canonical form.
- Concepts: [why digests need canonical JSON](./concepts/digest-determinism.md)
  and [why the serializer refuses instead of approximating](./concepts/refusals.md).
- Guides: [convert a value the serializer refuses](./guides/prepare-a-value.md)
  and [canonicalize inside an Effect pipeline](./guides/use-the-schema.md).
- [Troubleshooting](./troubleshooting.md): each failure code, what causes it,
  and what to change.
