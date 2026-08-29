---
description: "An Effect schema for canonical flow keys."
---

# @smthrs/keys

An Effect schema for canonical flow keys.

```typescript
/** A versioned SHA-256 key derived from canonical JSON. */
export type Key = string & Brand<"@smthrs/keys/Key">

/** Converts any RFC 8785-compatible JSON value to `Key`. */
export const Key: Schema<
  Key,
  unknown,
  Crypto.Crypto
>
```

`Key` is a one-way transformation. Canonical serialization comes from `@smthrs/canonical`; hashing comes from `@smthrs/crypto`.
