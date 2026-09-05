---
title: "Canonicalize inside an Effect pipeline"
description: "Decode with the Canonical schema instead of calling canonicalize: typed failures in the error channel, the branded document type, composing a derived schema, and keeping the rejected value out of diagnostics."
sidebar:
  order: 2
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/flows/canonical/docs/guides/use-the-schema.md"
---

`canonicalize` throws. The `Canonical` schema does the same serialization and
puts the failure in an Effect error channel instead, as a `SchemaError` whose
message carries the same code and path. Use the schema when the surrounding
code is Effect, and the function when it is not.

Every example here is Effect 4. The package declares `effect@4.0.0-rc.112` as a
peer dependency, and modules such as `effect/SchemaGetter` and
`effect/SchemaIssue` exist only in that line. See
[Installation](/installation/).

## Decode a value

```ts
import { Canonical } from "@smthrs/canonical"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"

const decode = Schema.decodeUnknownEffect(Canonical)

const document: Effect.Effect<Canonical, Schema.SchemaError> = decode({ b: 2, a: 1 })
```

The success value is branded. Only decoding through `Canonical` produces the
brand, so a function that takes a `Canonical` cannot be handed a string that
merely looks like JSON:

```ts
const hash = (document: Canonical): Effect.Effect<string> => sha256(document)

hash("{\"a\":1,\"b\":2}")
// Type error: string is not assignable to Canonical.
```

## Encode a document back

The encode direction parses the document into a plain JSON value:

```ts
Schema.encodeUnknownSync(Canonical)(document)
// => { a: 1, b: 2 }
```

The round trip is lossy in exactly the way JSON is lossy: what went in as a
`Date` comes back as a string, and a dropped `undefined` member does not
return.

## Handle both branches

For a caller that wants the failure as a value rather than as a short circuit:

```ts
import * as Result from "effect/Result"

const attempt = (value: unknown): Result.Result<Canonical, Schema.SchemaError> =>
  Effect.runSync(Effect.result(decode(value)))
```

Outside Effect entirely, `Schema.decodeUnknownSync(Canonical)(value)` throws
the `SchemaError` directly.

## Map to a typed failure

A `SchemaError` says the value was not canonicalizable. It does not say what
your caller should do about it. Map it to a failure your domain names, the way
[`@smthrs/keys`](https://keys.smithers.sh/reference/api/) does when key derivation fails:

```ts
class FingerprintError extends Schema.TaggedError<FingerprintError>()(
  "app/FingerprintError",
  { path: Schema.String, code: Schema.String }
) {}

const fingerprint = (value: unknown): Effect.Effect<Canonical, FingerprintError> =>
  decode(value, { reportInput: false }).pipe(
    Effect.mapError(() => new FingerprintError({ path: "$", code: "canonicalization_failed" }))
  )
```

## Keep failures free of the value

Anything you canonicalize is key material, and key material is often a secret
or a large payload. Two habits keep it out of your diagnostics.

**Pass `reportInput: false` when you decode.** Effect otherwise renders the
rejected input into the schema issue, and that issue travels into logs and
error responses:

```ts
decode(value, { reportInput: false })
```

Set it once for good on a schema you own with
`.annotate({ parseOptions: { reportInput: false } })`, so no caller can turn it
back on.

**Report the code and the path, not the value.** A thrown `CanonicalError`
carries both, and neither contains the rejected value. This is the shape
[`@smthrs/control`](https://control.smithers.sh/reference/api/) sends across its wire boundary:

```ts
import { CanonicalError } from "@smthrs/canonical"

const issueOf = (cause: unknown): string =>
  cause instanceof CanonicalError ? `${cause.path}: ${cause.code}` : "$: canonicalization failed"
```

Cap the result if it crosses an RPC boundary. A path grows with the depth of
the value, and an unbounded diagnostic is a way to inflate an error response.

## Compose a derived schema

Because `Canonical` is an ordinary codec, a derived identity is a schema
transformation rather than a function callers must remember to apply. Map the
canonicalization failure into a schema issue, and annotate the result so it
never reports its input:

```ts
import * as SchemaGetter from "effect/SchemaGetter"
import * as SchemaIssue from "effect/SchemaIssue"

const Fingerprint = Schema.Unknown.pipe(
  Schema.decodeTo(Schema.String, {
    decode: SchemaGetter.transformOrFail((value) =>
      fingerprint(value).pipe(
        Effect.mapError((error) => new SchemaIssue.InvalidValue({ message: `[${error.code}] ${error.path}` }))
      )
    ),
    encode: SchemaGetter.forbidden(() => "A fingerprint cannot be converted back into its input")
  })
).annotate({
  identifier: "app/Fingerprint",
  parseOptions: { reportInput: false }
})
```

`Schema.decodeTo` with a forbidden encode is the right shape whenever the
derivation is one way. [`@smthrs/keys`](https://keys.smithers.sh/reference/api/) builds its `DerivedKey`
schema exactly this way: a key can be derived from its input, and never
recovered from it.

## What the schema adds, and what it does not

The schema decodes through the same serializer, so every rule in
[The serialization contract](/serialization/) applies unchanged. It adds
three things: the branded type, the failure in the error channel, and
composability with other schemas. It changes no bytes.
