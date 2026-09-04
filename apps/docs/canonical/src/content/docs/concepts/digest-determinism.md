---
title: "Why digests need canonical JSON"
description: "What breaks when one value has more than one serialization, which Smithers identities are hashes of canonical bytes, and why the serialization is treated as a wire format."
sidebar:
  order: 1
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/flows/canonical/docs/concepts/digest-determinism.md"
---

## One value, one byte sequence

A digest names bytes, not values. `JSON.stringify` gives one value many byte
sequences, because it emits members in the object's own insertion order:

```ts
JSON.stringify({ a: 1, b: 2 })
// => '{"a":1,"b":2}'
JSON.stringify({ b: 2, a: 1 })
// => '{"b":2,"a":1}'
```

Those two objects are the same document. Hash them and you get two different
digests, so the same work keys differently depending on the order a caller
happened to build the object in. Insertion order is the loudest source of that
drift, but not the only one: number formatting and string escaping vary too, in
principle across implementations and in practice across languages.

Canonical JSON removes the choice. RFC 8785 fixes member order, number form,
and string escaping, so a value has exactly one serialization and therefore
exactly one digest. Any two hosts that both implement the standard agree,
whether they are two processes on one machine, a laptop and a CI runner, or a
Node.js host and a browser tab.

## What Smithers identifies this way

Every content-addressed identity in the repository is a hash of a canonical
document:

- **Flow keys.** [`@smthrs/keys`](https://keys.smithers.sh/reference/api/) canonicalizes key material and
  hashes it into `key1_` followed by a SHA-256 digest. Two callers submitting
  the same work derive the same key without coordinating.
- **Content fingerprints.** [`@smthrs/core`](https://core.smithers.sh/reference/api/) exposes
  `Digest.canonical` for the synchronous fingerprints computed inside pure
  constructors: a prompt section's identity, a context-window segment, a cell's
  source digest.
- **Plan digests and envelope equality.**
  [`@smthrs/control`](https://control.smithers.sh/reference/api/) digests plan cards so an approval binds to
  a plan, and compares capability envelopes by canonical bytes rather than by
  reference or member order.
- **Authenticated metadata.** The control plane's credential cipher encodes
  credential metadata as a canonical document and uses it as associated data.
  Canonical JSON names and escapes each field, so two different metadata tuples
  cannot authenticate as the same bytes by hiding a delimiter inside a value.

Because those identities are persisted, the serialization is not an
implementation detail. It is the format they were written in.

## Idempotence is what makes a document portable

A digest is often taken over a document that has already crossed a boundary:
stored, sent over a wire, parsed by another service, and re-serialized. That
only works if canonicalizing a canonical document returns it unchanged:

```ts
canonicalize(JSON.parse(canonicalize(value))) === canonicalize(value)
```

The package proves this over generated values, including values built from
hostile strings. It is the property that lets a consumer hash the document it
received rather than the value it decoded.

## Output changes are digest changes

Treat the serialization the way you treat a wire format. Changing the bytes
does not produce a compile error or a failing decode. It produces a run whose
cache misses, an approval that no longer validates against its plan, and a key
that no longer finds the work it named. The damage shows up as silently
repeated work, or as an identity mismatch far from the change.

Two habits follow:

- **Audit every consumer before changing the serializer.** Anything that
  persisted a digest is affected, including data already on disk.
- **Pin the bytes in your own tests.** A golden document for one representative
  value, plus an assertion that a reordered copy produces the same document,
  turns a serialization change into a failing test instead of a production
  mismatch.

## When canonical JSON is not enough

This package mirrors `JSON.stringify`, which means it silently coerces some
values on the way in: an `undefined` member disappears, a `Date` becomes a
string, an object with a `toJSON` becomes something else entirely. That is
correct for a digest over JSON data, and wrong for a digest that must describe
the exact value a caller passed.

Where the difference matters, the caller adds its own pre-check rather than
changing this serializer. [`@smthrs/model`](https://model.smithers.sh/reference/api/) does exactly that for
sealed model steps: its request encoder rejects everything `JSON.stringify`
would drop or reshape, because a key computed from a coerced body would
describe a different request than the one sent on the wire. Everything both
encoders accept, they encode identically.
