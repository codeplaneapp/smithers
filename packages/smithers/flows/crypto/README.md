# `@smthrs/crypto`

**Documentation:** https://crypto.smithers.sh

Strict SHA-256 hashing for Smithers. The package accepts well-formed JavaScript
text or `Uint8Array`, hashes a byte snapshot, and returns one branded wire form:
64 lowercase hexadecimal characters.

```typescript
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import { digest, digestSync } from "@smthrs/crypto"
import { Effect } from "effect"

const injected = await Effect.runPromise(
  digest("hello").pipe(Effect.provide(NodeCrypto.layer))
)
const synchronous = digestSync("hello")

// Both are:
// 2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824
```

## Public API

- `digest(input)` is the normal operational API. It requires an Effect
  `Crypto.Crypto` service and fails with `Sha256Error`.
- `digestSync(input)` is the explicit synchronous API for pure plan and
  identity construction. It uses the package-owned FIPS 180-4 implementation.
- `Digest` validates an existing digest without hashing it.
- `Sha256` is the one-way schema adapter. `Sha256.Digest`, `Sha256.digest`, and
  `Sha256.digestSync` remain attached for compatibility.
- `syncCrypto` adapts the synchronous implementation to Effect `Crypto`. It
  accepts only `SHA-256` and deliberately refuses randomness.

## Input contract

Strings are rejected if they contain an unpaired UTF-16 surrogate, then encoded
as UTF-8 with the host's standard `TextEncoder`. Supported Node, Bun, and modern
browser targets provide that global; compatible worker and edge runtimes
generally do too. It remains an explicit runtime prerequisite rather than an
injected service.

No Unicode normalization is performed. Canonically equivalent NFC and NFD text
can therefore have different digests. Normalize before calling this package if
your protocol requires normalization.

`digest` copies a `Uint8Array` when its Effect begins, before the injected host
is called; `digestSync` copies during the call. Mutating the caller's array
during asynchronous hashing cannot change that operation. Host output is also
copied and must contain exactly 32 bytes. `Buffer` works because it is a
`Uint8Array`; `ArrayBuffer`, `DataView`, other typed arrays, iterables, and
streams are rejected.

This is intentionally a one-shot, whole-buffer API. It does not provide
incremental or streaming hashing, so callers must hold the complete input and
the snapshot in memory.

## Failure contract

`Sha256Error.code` is stable:

| Code                   | Meaning                                                     |
| ---------------------- | ----------------------------------------------------------- |
| `invalid_input`        | The direct API received an unsupported or uncopyable input. |
| `invalid_text`         | Text contains an unpaired surrogate.                        |
| `text_encoding_failed` | `TextEncoder` threw.                                        |
| `digest_failed`        | The provided host failed or threw.                          |
| `invalid_digest`       | The host result is not a copyable 32-byte array.            |

`digest` fails in the Effect error channel; `digestSync` throws the same typed
error. Invalid values passed to `Digest` and unsupported values passed through
the `Sha256` input schema are ordinary `SchemaError` validation failures.
Operational failures preserve their original `cause`, use input-safe messages,
and do not attach the value being hashed to schema diagnostics. A missing
`Crypto` service is an unsatisfied Effect requirement and therefore a
configuration defect, not a `Sha256Error`. Encoding `Sha256` in reverse fails with
`A digest cannot be converted back into its source bytes`.

Canonical value serialization belongs to
[`@smthrs/canonical`](https://smithers.sh/docs/reference/api/canonical). Domain-specific key
formats belong to [`@smthrs/keys`](https://smithers.sh/docs/reference/api/keys). Full API
documentation is at [smithers.sh/api/crypto](https://smithers.sh/docs/reference/api/crypto).
