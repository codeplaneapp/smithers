---
title: "The wire format"
description: "The key1_ representation, why StoredKey rejects unknown version prefixes instead of guessing them, and what adding a second format would take."
sidebar:
  order: 3
---

A key is 69 characters: the literal prefix `key1_`, then exactly 64 lowercase
hexadecimal characters.

```text
key1_74a286a394e4b0619c05801dd4e7315deeb83b8203cd3c3ee7cd6033ec55c683
```

The prefix is a version marker for the whole derivation, not a hint about the
algorithm. `key1_` means "produced by the version-one derivation", and version
one is the pipeline in [Key derivation](./key-derivation.md).

## Two schemas, one current representation

`KeyV1` validates that exact representation: the prefix, the length, the
lowercase hexadecimal alphabet. It is branded, so a plain string cannot be
passed where a validated key is required.

`StoredKey` is the set of representations this release can validate. It is
currently equal to `KeyV1`, and it is a separate export because its meaning is
different: `KeyV1` names one format forever, while `StoredKey` names whatever
the release you are running understands. Use `StoredKey` at your boundaries.
That way the day a second format ships, the boundary widens with the release
and your code does not.

## Unknown versions are rejected, not guessed

`key2_` is invalid text today, and so is `key0_`, `key01_`, an uppercase
digest, and any payload that is not exactly 64 hexadecimal characters. Nothing
in this package tries to parse a version it does not implement.

That is deliberate. A permissive `key\d+_[0-9a-f]+` pattern would accept a
future format whose payload length, algorithm, or encoding it knows nothing
about, and hand the caller a value it cannot compare, cannot re-derive, and
cannot safely store. Refusing is the only honest answer an old release can
give a new format.

## Only this package owns the format

Treat a key as opaque everywhere else. Never slice the prefix off by hand,
never split on `_`, and never build a key from a digest you hashed yourself.
`digest` exists so that prefix knowledge lives in one place:

```ts
import { digest, StoredKey } from "@smthrs/keys"
import * as Schema from "effect/Schema"

const payload = digest(Schema.decodeUnknownSync(StoredKey)(text))
// 74a286a394e4b0619c05801dd4e7315deeb83b8203cd3c3ee7cd6033ec55c683
```

`digest` takes an already-validated `StoredKey` and does not re-check it. It is
the accessor for a value the type system says is a key, not a parser. Validate
first.

## What happens to your keys if a second format ships

They keep working. A `key1_` value written today still validates after the
upgrade and still identifies exactly the work it always did, because `KeyV1`
stays an explicit member of `StoredKey`. A second format arrives as an
additional member beside it, with its own schema and its own derivation; it is
never a loosened `KeyV1`, because a widened pattern is not compatibility.

That is the practical reason to decode with `StoredKey` rather than `KeyV1` at
a boundary. The set of formats the boundary accepts widens with the release you
install, and your code does not change.

## Changing the format changes every identity

The derivation is frozen because its output is persisted. Alter the
canonicalization, the hash, or the framing and every key changes, which means
every cache entry misses, every replay re-executes, and every stored row
becomes unreachable under its new key. So the version-one derivation does not
change: a new one gets a new prefix instead, and every key you have already
written keeps resolving. That is also what makes a key literal a safe
assertion in your own tests. See [Testing](../testing.md).
