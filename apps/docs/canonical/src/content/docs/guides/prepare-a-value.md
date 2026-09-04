---
title: "Convert a value the serializer refuses"
description: "Turn a Map, Set, typed array, bigint, class instance, or other refused value into JSON data that canonicalizes, without introducing a digest collision."
sidebar:
  order: 1
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/flows/canonical/docs/guides/prepare-a-value.md"
---

When `canonicalize` reports `canonical_unsupported_value` or
`canonical_bigint`, the value it named has no canonical form. Convert it to
JSON data before hashing. This guide is the conversion for each refused kind,
and the collision to avoid in each case.

The path in the failure names the member to fix:

```text
canonical_unsupported_value: Set at $.input.tags
```

## Decide once: convert, or add a `toJSON`

There are two places to put the conversion, and the choice is about who owns
the type.

- **Convert at the call site** when the type is not yours, or when only this
  one digest needs it. The value stays what it was everywhere else.
- **Add a `toJSON` method** when the type is yours and every serialization of
  it should look the same. The method runs before every other check, so the
  serializer never sees the class at all.

```ts
class Money {
  readonly cents: number
  constructor(cents: number) {
    this.cents = cents
  }
  toJSON(): { kind: string; cents: number } {
    return { kind: "money", cents: this.cents }
  }
}

canonicalize({ price: new Money(500) })
// => '{"price":{"cents":500,"kind":"money"}}'
```

Whichever you pick, tag the result when the original type carried meaning. A
`Money` that serializes to `{ cents: 500 }` digests identically to a plain
`{ cents: 500 }`, which is a collision you created. The `kind` field is what
keeps them apart.

## Set

A `Set` has no order, so give it one. Sorting makes the digest independent of
insertion order, which is usually what you wanted from a set in the first
place:

```ts
canonicalize({ tags: [...new Set(["release", "beta"])].sort() })
// => '{"tags":["beta","release"]}'
```

Sorting is not optional if two callers can build the same set differently. An
unsorted spread preserves insertion order, and then `["beta", "release"]` and
`["release", "beta"]` are different documents with different digests.

## Map

A `Map` with string keys becomes a plain object, and the serializer sorts the
members for you:

```ts
canonicalize({ limits: Object.fromEntries(new Map([["cpu", 4], ["memory", 8]])) })
// => '{"limits":{"cpu":4,"memory":8}}'
```

A `Map` with non-string keys becomes a sorted array of entries. Do not reach
for `Object.fromEntries` here: it coerces every key with `String`, so the keys
`1` and `"1"` become one member and the map silently loses an entry.
Canonicalize each key instead, which keeps them distinct and gives the sort a
stable comparison:

```ts
const entries = [...map]
  .map(([key, value]) => [canonicalize(key), value] as const)
  .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))

canonicalize({ limits: entries })
```

## Typed array, ArrayBuffer, and DataView

Binary data becomes text. Base64 is compact and round trips:

```ts
canonicalize({ payload: Buffer.from(bytes).toString("base64") })
```

In a browser or any host without `Buffer`, encode the bytes yourself. An array
of numbers also works and is easier to read, at roughly four times the size:

```ts
canonicalize({ payload: [...bytes] })
```

Whichever encoding you choose, use one encoding everywhere. Two producers that
disagree about base64 versus a number array produce different digests for the
same bytes.

## bigint

A `bigint` has no JSON form, boxed or not, so it becomes a string. A number
loses precision above `Number.MAX_SAFE_INTEGER`, which is the reason the value
was a `bigint`:

```ts
canonicalize({ blockHeight: 21_000_000_000_000_000_001n.toString() })
// => '{"blockHeight":"21000000000000000001"}'
```

## Date

A `Date` needs no conversion. `Date.prototype.toJSON` runs first, so a `Date`
reaches the document as an ISO 8601 string:

```ts
canonicalize({ at: new Date(0) })
// => '{"at":"1970-01-01T00:00:00.000Z"}'
```

That means a `Date` and the equivalent string digest identically. If the
distinction matters to you, tag the value:
`{ at: { kind: "instant", iso: date.toISOString() } }`.

## RegExp and Error

Both are refused, and both need a decision about what you are actually
identifying:

```ts
canonicalize({ pattern: { source: /ab+c/i.source, flags: /ab+c/i.flags } })
// => '{"pattern":{"flags":"i","source":"ab+c"}}'

canonicalize({ failure: { name: error.name, message: error.message } })
```

Leave the stack out of anything you digest. It carries absolute paths and line
numbers, so it changes between machines and between builds, and a digest that
includes it is a digest that never matches twice.

## Non-finite numbers

`NaN`, `Infinity`, and `-Infinity` are refused as `canonical_nan` and
`canonical_non_finite`. Decide what the value means before encoding it: `null`
for "no measurement", a sentinel string for "unbounded", or an object that says
which:

```ts
const encodeLimit = (value: number): unknown => (Number.isFinite(value) ? value : { kind: "unbounded" })
```

Do not reach for a large finite number. It compares as a number downstream, and
some later value will exceed it.

## undefined

An `undefined` member is dropped rather than refused, which is `JSON.stringify`
parity and usually what you want. It does mean `{ a: 1 }` and
`{ a: 1, b: undefined }` digest identically. When the difference matters,
encode absence explicitly as `null`.

A top-level `undefined` is refused, because the serializer must return a
string:

```text
canonical_unsupported_value: undefined at $
```

## Check the conversion

Assert the whole document once, rather than asserting that the call did not
throw:

```ts
import { expect, it } from "vitest"

interface Request {
  readonly tags: ReadonlySet<string>
  readonly at: Date
}

const encodeRequest = (request: Request): unknown => ({
  tags: [...request.tags].sort(),
  at: request.at.toISOString()
})

it("digests a request independently of member and set order", () => {
  const left: Request = { tags: new Set(["release", "beta"]), at: new Date(0) }
  const right: Request = { at: new Date(0), tags: new Set(["beta", "release"]) }
  expect(canonicalize(encodeRequest(left))).toBe(canonicalize(encodeRequest(right)))
  expect(canonicalize(encodeRequest(left))).toBe(
    "{\"at\":\"1970-01-01T00:00:00.000Z\",\"tags\":[\"beta\",\"release\"]}"
  )
})
```

The refusals this guide works around are described in
[why the serializer refuses](/concepts/refusals/), and each failure code is
listed with its cause in [Troubleshooting](/troubleshooting/).
