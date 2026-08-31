Use `digest` for ordinary Effect code and `digestSync` only where construction
must remain synchronous. Both accept `string | Uint8Array` and produce the same
branded `Digest`.

```typescript
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import { digest, digestSync } from "@smthrs/crypto"
import { Effect } from "effect"

const injected = await Effect.runPromise(
  digest("hello").pipe(Effect.provide(NodeCrypto.layer))
)
const synchronous = digestSync("hello")

// 2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824
```

## Input and memory policy

Text must be well-formed UTF-16. Unpaired surrogates are rejected before the
standard `TextEncoder` converts text to UTF-8, avoiding replacement-character
collisions. `TextEncoder` is an explicit host prerequisite available in every
supported Smithers runtime. No normalization is performed, so NFC and NFD text
remain distinct inputs.

`digest` copies byte input when its Effect begins and before the host is called;
`digestSync` copies during the call. Host output is copied and must contain
exactly 32 bytes. `Buffer` is a `Uint8Array` and is accepted; other buffer and
view types are not. The API is one-shot and requires the complete input plus
its snapshot in memory. There is no incremental or streaming entry point.

## Failure policy

`digest` fails with `Sha256Error`. Its `code` is stable and its optional `cause`
preserves the original failure. The package does not attach the hash input.

| Code                   | Meaning                                          |
| ---------------------- | ------------------------------------------------ |
| `invalid_input`        | Unsupported or uncopyable direct input.          |
| `invalid_text`         | Unpaired UTF-16 surrogate.                       |
| `text_encoding_failed` | The host `TextEncoder` threw.                    |
| `digest_failed`        | The injected host failed or threw.               |
| `invalid_digest`       | The host result is not a copyable 32-byte array. |

`digestSync` throws the same typed error. Invalid values passed to `Digest` and
unsupported values passed through the `Sha256` input schema are ordinary
`SchemaError` validation failures. A missing `Crypto.Crypto` service is an
Effect configuration defect because the service remains in the Effect
requirement. The `Sha256` schema adapter converts operational failures to
redacted `SchemaError` issues and preserves the typed error as an issue
annotation. Reverse encoding always fails with
`A digest cannot be converted back into its source bytes`.

## API shape

`Digest` is an ordinary named schema export. The one-way `Sha256` transformation
remains for schema composition and compatibility; `Sha256.Digest`,
`Sha256.digest`, and `Sha256.digestSync` are aliases of the named exports.
`syncCrypto` is a hashing-only adapter for Effect-shaped synchronous callers.
It rejects every algorithm except `SHA-256` and refuses randomness.
