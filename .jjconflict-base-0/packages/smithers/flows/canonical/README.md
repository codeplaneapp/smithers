**Documentation:** https://canonical.smithers.sh

<!-- Deep reviewed and polished by a human. -->

# `@smthrs/canonical`

Two objects with the same entries in different key order — `{ a: 1, b: 2 }` and `{ b: 2, a: 1 }` — serialize to the same string, so their digests and keys match.

This package provides a direct `canonicalize` serializer and an Effect `Canonical` schema, following the [RFC 8785 JSON Canonicalization Scheme](https://www.rfc-editor.org/rfc/rfc8785.html).

```typescript
import { Canonical, canonicalize } from "@smthrs/canonical"
import { Schema } from "effect"

const document = Schema.decodeUnknownSync(Canonical)({ b: 2, a: 1 })
// '{"a":1,"b":2}'

canonicalize({ b: 2, a: 1 })
// '{"a":1,"b":2}'
```

`canonicalize` follows `JSON.stringify` for JSON data, `toJSON(key)`, boxed primitives, and sparse arrays, then sorts keys by UTF-16 code units. It rejects non-finite numbers, BigInt, lone surrogates, cycles, digest-unsafe non-plain built-ins, and nesting beyond 10,000 levels. Failures are `CanonicalError` values with stable `code` and `path` fields.

Canonical output is digest-critical: changing its bytes changes every downstream digest.
