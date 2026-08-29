# `@smthrs/canonical`

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
