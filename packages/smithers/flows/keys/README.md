# `@smthrs/keys`

**Documentation:** https://keys.smithers.sh

Derive canonical flow keys and validate keys read from storage without
accidentally hashing them again.

```typescript
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import { deriveKey, StoredKey } from "@smthrs/keys"
import { Effect, Schema } from "effect"

const derived = await Effect.runPromise(
  deriveKey({ domain: "example/compile", version: 1, source: "main.ts" }).pipe(
    Effect.provide(NodeCrypto.layer)
  )
)

const parsed = Schema.decodeUnknownSync(StoredKey)(derived)
// parsed === derived
```

`deriveKey` serializes input through
[`@smthrs/canonical`](https://canonical.smithers.sh/reference/api/), hashes the exact
canonical UTF-8 document through injected SHA-256 from
[`@smthrs/crypto`](https://crypto.smithers.sh/reference/api/), and produces
`key1_<64 lowercase hex>`.

`KeyV1` validates that exact stored representation. `StoredKey` validates every
format this release supports, currently only `KeyV1`. Unknown versions such as
`key2_` are rejected until their complete format and derivation are implemented.

`Key` remains the compatibility schema for one-way derivation. Decoding
key-shaped text through `Key` hashes that text into a new key; it does not parse
the stored key. Prefer `deriveKey` for typed `KeyDerivationError` failures and
`StoredKey` at persistence, RPC, journal, and external-input boundaries.

Treat keys as opaque. Include a stable domain and material-schema version in
each protocol's structured input. Derivation inherits `Canonical` semantics,
is one-shot, and imposes no size or depth limit of its own, so external callers
must bound untrusted input before canonicalization.

Full documentation is at
[keys.smithers.sh](https://keys.smithers.sh/reference/api/).
