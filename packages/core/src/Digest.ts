/**
 * Compatibility helpers for synchronous identity construction.
 *
 * `@smthrs/keys/Digest` was deleted at `f5f3dda`, which reduced `@smthrs/keys`
 * to the canonical `Key` schema and moved hashing to `@smthrs/crypto`'s
 * `Sha256` and canonicalization to `@smthrs/canonical`'s `Canonical`.
 *
 * The agent side computes content fingerprints inside *pure, synchronous*
 * constructors: a prompt section's identity, a context-window segment, a
 * cell's source digest, a plan card's digest. `@smthrs/crypto` now owns that
 * policy and its only handwritten implementation. This module delegates to
 * `digestSync` and retains its old `crypto`, `layer`, and `runSync` names for
 * existing Core consumers.
 *
 * The digest is therefore the *same digest*: same canonical bytes, same hash,
 * same hexadecimal encoding, just reached without suspending. `Digest.test.ts`
 * pins that equivalence against the platform Crypto layer.
 *
 * @since 0.1.0
 */
import { Canonical } from "@smthrs/canonical"
import { digestSync, syncCrypto } from "@smthrs/crypto"
import * as Crypto from "effect/Crypto"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"

/**
 * The package-owned synchronous, SHA-256-only `Crypto` service.
 *
 * Randomness is deliberately absent rather than weakly implemented: a
 * fingerprint needs a hash, and a caller that reaches for `randomBytes` here
 * wants a real platform layer, not a plausible-looking substitute.
 * Non-SHA-256 algorithms fail with `BadArgument`. The requirement for ordinary
 * application code is met by `@effect/platform-node`'s `NodeCrypto` or the
 * browser equivalent.
 *
 * @category services
 * @since 0.1.0
 * @slop
 */
export const crypto: Crypto.Crypto = syncCrypto

/**
 * Provides {@link crypto} as a layer, for Effect-shaped callers that only hash.
 *
 * @category layers
 * @since 0.1.0
 * @slop
 */
export const layer: Layer.Layer<Crypto.Crypto> = Layer.succeed(Crypto.Crypto)(crypto)

/**
 * Runs a hashing effect synchronously against {@link crypto}.
 *
 * This is the bridge the synchronous call sites use, and the only place the
 * bridging happens: everything else in this module is written in terms of it,
 * so there is one answer to "which `Crypto` did this digest come from".
 *
 * @category execution
 * @since 0.1.0
 * @slop
 */
export const runSync = <A, E>(effect: Effect.Effect<A, E, Crypto.Crypto>): A =>
  Effect.runSync(Effect.provideService(effect, Crypto.Crypto, crypto))

const decodeCanonical = Schema.decodeUnknownEffect(Canonical)

/**
 * Returns the full lowercase SHA-256 digest of UTF-8 string or byte input.
 *
 * This is the signature `@smthrs/keys/Digest.digest` carried, preserved so the
 * agent-side call sites keep producing the digests already recorded in goldens
 * and journals.
 *
 * @category hashing
 * @since 0.1.0
 * @slop
 */
export const digest = digestSync

/**
 * Returns the RFC 8785 canonical JSON serialization of a value.
 *
 * A function, symbol, `bigint`, cyclic object, non-finite number, or top-level
 * `undefined` has no canonical JSON representation. For those values this
 * throws the `SchemaError` from `effect/Schema` raised through
 * `Effect.runSync`; the canonical package's failure is not wrapped.
 *
 * @category serialization
 * @since 0.1.0
 * @slop
 */
export const canonical = (value: unknown): string => runSync(decodeCanonical(value))
