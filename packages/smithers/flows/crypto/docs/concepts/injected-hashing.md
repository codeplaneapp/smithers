---
title: "The injected hashing boundary"
description: "Why the cryptographic operation goes through Effect's Crypto service, why one entry point deliberately does not, and what the package checks about an answer it did not compute."
sidebar:
  order: 1
---

Hashing is host access. The bytes go somewhere the program does not control:
a Node binding, a Bun binding, a browser's Web Crypto, a hardware module. So
`digest` does what every other host operation in Smithers does and takes the
implementation as a service:

```ts
import { digest } from "@smthrs/crypto"

digest("hello")
// Effect<Digest, Sha256Error, Crypto.Crypto>
```

The `Crypto.Crypto` in the requirement channel is the whole design. A test
provides a scripted service and never touches a platform binding. A browser
build provides Web Crypto. A fault-injection test provides a service that
fails, and the code under test does not change.

## Why one entry point does not inject

Some hashing is not host access in any meaningful sense: it happens inside a
pure, synchronous constructor that has no Effect to suspend in. A prompt
section's identity, a context-window segment, a cell's source digest, a plan
card's digest are all computed while a value is being built, not while an
effect is running.

`digestSync` serves exactly that case. It uses the package-owned FIPS 180-4
implementation in `src/internal/sha256.ts`, so it needs no service and cannot
suspend:

```ts
import { digestSync } from "@smthrs/crypto"

digestSync("hello")
// "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"
```

The digest is the same digest: the same bytes, the same hash, the same
encoding, reached without suspending. The package's own suite pins that
equality over arbitrary inputs precisely because the two paths compute it
differently.

That handwritten implementation is the reason this package exists as a
package. It is the only one in the repository, it lives behind a blocked
`internal/` subpath, and everything that hashes synchronously reaches it
through `digestSync` or `syncCrypto` rather than writing its own.

## The third door: syncCrypto

`syncCrypto` is the same synchronous implementation wearing the `Crypto`
interface, for code that already consumes the service and cannot suspend:

```ts
import { digest, syncCrypto } from "@smthrs/crypto"
import * as Crypto from "effect/Crypto"
import * as Effect from "effect/Effect"

Effect.runSync(Effect.provideService(digest("hello"), Crypto.Crypto, syncCrypto))
```

It is deliberately narrow. It answers `SHA-256` and rejects every other
algorithm with a `BadArgument` naming the one it received, and it refuses
randomness rather than returning weak bytes. Because `Crypto.make` derives
random numbers, UUIDs, and shuffling from `randomBytes`, every random
operation on `syncCrypto` fails with the same refusal. Supply a platform
`Crypto` layer for anything but hashing.

## What the package checks about an answer it did not compute

An injected service is a boundary, and the package treats what crosses it as
untrusted. `digest` verifies four things about the host's answer, in order:
that the operation is an Effect at all, that it succeeded, that its value is a
`Uint8Array` that can be copied, and that there are exactly 32 bytes. Each
failure is a typed `Sha256Error` with a stable code, listed in
[the contract](../contract.md#what-the-injected-host-must-supply).

It also copies. The bytes going in are a snapshot, so a host that mutates its
argument cannot reach the caller's array. The bytes coming back are copied
before encoding, so a host that reuses one output buffer across calls cannot
rewrite a digest already returned, and an iterator the host defined on its
value is not consulted while that copy is made.

What none of this checks is whether the host actually computed SHA-256. There
is no way to verify that short of computing the hash, which would defeat the
injection. A service that returns 32 bytes of anything produces a digest this
package will return as valid. That is stated plainly in
[the contract](../contract.md#what-the-package-does-not-defend-against), and
it is the reason to provide a platform layer you trust.

## The one failure that is not a Sha256Error

A missing `Crypto` service is not a runtime failure. It stays an unsatisfied
Effect context requirement and surfaces as `Service not found: effect/Crypto`,
because a composition that forgot to provide a host has a defect, not a bad
input. The distinction is deliberate: `Sha256Error` codes describe inputs and
hosts that behaved badly, and a program that branches on them should never
have to consider a wiring mistake among them.
