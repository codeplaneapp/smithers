---
description: "RFC 8785 canonical JSON as an Effect Schema."
---

# @smthrs/canonical

RFC 8785 canonical JSON as an Effect Schema, backed by the well-tested [`canonicalize`](https://www.npmjs.com/package/canonicalize) package.

```typescript
import { Canonical } from "@smthrs/canonical"
import { Schema } from "effect"

const document = Schema.decodeUnknownSync(Canonical)({ b: 2, a: 1 })
// '{"a":1,"b":2}'
```

## Public API

```typescript
/** An RFC 8785 canonical JSON document. */
type Canonical = string & Brand<"@smthrs/canonical/Canonical">

/** Converts a JSON value into an RFC 8785 canonical JSON document. */
const Canonical: Schema.Codec<unknown, Canonical>
```

The schema rejects values that JSON cannot represent and strings containing lone Unicode surrogates. Encoding a `Canonical` value parses it back to JSON data.

[RFC 8785](https://www.rfc-editor.org/rfc/rfc8785.html) is the normative format specification.

## API reference

Wraps [`canonicalize`](https://www.npmjs.com/package/canonicalize) as an Effect Schema following [RFC 8785](https://www.rfc-editor.org/rfc/rfc8785.html).

```typescript
import { Canonical } from "@smthrs/canonical"
import { Schema } from "effect"

const document = Schema.decodeUnknownSync(Canonical)({ b: 2, a: 1 })
// '{"a":1,"b":2}'
```

| Export | Kind | Purpose |
| --- | --- | --- |
| `Canonical` | schema + branded type | transform JSON-compatible data to and from its RFC 8785 document |
