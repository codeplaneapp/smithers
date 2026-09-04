---
title: "Validate a digest read from storage"
description: "Use the Digest schema to check a digest that came back from a database column, a URL segment, or a request body, without hashing anything."
sidebar:
  order: 2
---

A digest you computed is trustworthy. A digest that came back out of a
database column, a URL segment, a request body, or another process is an
ordinary string that claims to be a digest. `Digest` is the schema that
settles the claim, and it hashes nothing, so it needs no `Crypto` service.

## Decode the value

```ts
import { Digest } from "@smthrs/crypto"
import * as Schema from "effect/Schema"

const parse = Schema.decodeUnknownSync(Digest)

parse("2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824")
// The same string, typed as Digest.
```

`Digest` accepts exactly `^[0-9a-f]{64}$` and rejects everything else:
uppercase hexadecimal, 63 or 65 characters, a non-hexadecimal letter, a
leading or trailing space, and any value that is not a string. Use
`Schema.decodeUnknownEffect` where you want the failure in an Effect error
channel rather than as a throw.

## Take the brand as a parameter

The point of decoding is to do it once at the edge. Give the functions
underneath it the branded type, so the type system stops them from being
called with a raw string that nobody checked:

```ts
import type { Digest } from "@smthrs/crypto"

const load = (address: Digest): Promise<Uint8Array> => readObject(address)
```

`Digest` is both a schema value and a type, so one import serves both
positions. A plain `string` will not satisfy the parameter, which is the whole
value of the brand.

## Re-hash before you trust the bytes

A validated address proves the string is well formed. It proves nothing about
the bytes stored under it. If the bytes matter, hash them again and compare:

```ts
import { Digest, digest } from "@smthrs/crypto"
import * as Effect from "effect/Effect"

const verified = (address: Digest, bytes: Uint8Array) =>
  Effect.map(digest(bytes), (recomputed) => recomputed === address)
```

Comparing with `===` is correct here and is not a constant-time comparison.
Content addresses are public values, so that is usually fine; if you are
comparing a digest against a secret, this package is the wrong tool. See
[the contract](../contract.md#what-the-package-does-not-defend-against).

## Do not slice a digest out of a longer format

A stored key like `key1_<digest>` has a prefix that means something. Reach for
the package that owns the format rather than slicing the string yourself:
[`@smthrs/keys`](/api/keys) exposes the payload of a stored key through an
accessor for exactly this reason.

## Related

- [Quickstart](../quickstart.md): validation in the middle of a
  content-addressed read.
- [What a digest covers](../concepts/what-a-digest-covers.md): what the
  validated digest is a statement about.
