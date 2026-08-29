---
description: "Effect schemas for injected cryptographic operations."
---

# @smthrs/crypto

Effect schemas for injected cryptographic operations.

```typescript
/** Hashes UTF-8 text or bytes through Effect Crypto. */
export const Sha256: Schema<
  string & Brand<"@smthrs/crypto/Sha256/Digest">,
  string | Uint8Array,
  Crypto.Crypto
> & {
  /** Validates a 64-character lowercase SHA-256 digest. */
  readonly Digest: Schema<string & Brand<"@smthrs/crypto/Sha256/Digest">>
}
```

`Sha256` is a one-way transformation. `Sha256.Digest` validates stored or transported digest values without hashing them again.
