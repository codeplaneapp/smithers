# `@smthrs/crypto`

The package provides Effect schemas for injected cryptographic operations.

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

Text is encoded as UTF-8. The operation requires Effect `Crypto`, so applications choose the platform implementation. Invalid inputs and crypto failures are returned as `SchemaError`.
