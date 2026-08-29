# @smthrs/crypto

`@smthrs/crypto` defines the cryptographic operations shared by the
planning and key packages without choosing a host implementation. Its `Sha256`
schema accepts bytes or text and yields a validated, lowercase 64-character
hex digest. The operation is supplied through an Effect `Crypto` service, so
Node, browsers, tests, and restricted runtimes can provide their own
implementation without ambient globals or an accidental platform dependency.

The package owns validation and dependency injection only. Canonical value
encoding belongs to [`@smthrs/canonical`](../canonical/README.md), while
domain-specific key formats belong to [`@smthrs/keys`](../keys/README.md).
Keeping those concerns separate makes the bytes being hashed explicit and
keeps the same digest reproducible on every supported host.

```typescript
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import { Sha256 } from "@smthrs/crypto"
import { Effect, Schema } from "effect"

const digest = Effect.runSync(
  Schema.decodeUnknownEffect(Sha256)("hello")
    .pipe(Effect.provide(NodeCrypto.layer))
)

Schema.decodeUnknownSync(Sha256.Digest)(digest)
```
