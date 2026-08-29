<!-- Deep reviewed and polished by a human. -->

# `@smthrs/canonical`

Two objects with the same entries in different key order — `{ a: 1, b: 2 }` and `{ b: 2, a: 1 }` — serialize to the same string, so their digests and keys match.

This package wraps [`canonicalize`](https://www.npmjs.com/package/canonicalize) in Effect, following the [RFC 8785 JSON Canonicalization Scheme](https://www.rfc-editor.org/rfc/rfc8785.html).

```typescript
import { Canonical } from "@smthrs/canonical"
import { Schema } from "effect"

const document = Schema.decodeUnknownSync(Canonical)({ b: 2, a: 1 })
// '{"a":1,"b":2}'
```
