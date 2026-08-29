/**
 * The synchronous face of the main tree's hashing chokepoint.
 *
 * `@smthrs/keys/Digest` was deleted at `f5f3dda`, which reduced `@smthrs/keys`
 * to the canonical `Key` schema and moved hashing to `@smthrs/crypto`'s
 * `Sha256` and canonicalization to `@smthrs/canonical`'s `Canonical`. Both
 * successors are Effect schemas that read the injected `Crypto` service, and
 * that is the right shape for the engine: a browser host injects WebCrypto, a
 * test host injects a recorded one.
 *
 * The agent side computes content fingerprints inside *pure, synchronous*
 * constructors — a prompt section's identity, a context-window segment, a
 * cell's source digest, a plan card's digest. Those cannot take an Effect, so
 * this module runs the successor schemas synchronously against {@link crypto},
 * a `Crypto` implementation whose only capability is a dependency-free SHA-256.
 *
 * The digest is therefore the *same digest*: same canonical bytes, same hash,
 * same hexadecimal encoding, just reached without suspending. `Digest.test.ts`
 * pins that equivalence against the platform Crypto layer.
 *
 * @since 0.1.0
 */
import { Canonical } from "@smthrs/canonical"
import { Sha256 } from "@smthrs/crypto"
import * as Crypto from "effect/Crypto"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import { sha256 } from "./internal/sha256.ts"

/**
 * A `Crypto` service that hashes and nothing else.
 *
 * Randomness is deliberately absent rather than weakly implemented: a
 * fingerprint needs a hash, and a caller that reaches for `randomBytes` here
 * wants a real platform layer, not a plausible-looking substitute. The
 * requirement is met by `@effect/platform-node`'s `NodeCrypto` or the browser
 * equivalent, which is what every non-fingerprint caller already provides.
 *
 * @category services
 * @since 0.1.0
 * @slop
 */
export const crypto: Crypto.Crypto = Crypto.make({
  randomBytes: () => {
    throw new Error("@smthrs/core/Digest provides hashing only; supply a platform Crypto layer for randomness")
  },
  digest: (_algorithm, data) => Effect.succeed(sha256(data))
})

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

const decodeSha256 = Schema.decodeUnknownEffect(Sha256)

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
export const digest = (input: Uint8Array | string): string => runSync(decodeSha256(input))

/**
 * Returns the RFC 8785 canonical JSON serialization of a value.
 *
 * Throws on a value canonical JSON cannot represent, which is the contract the
 * agent-side callers were written against.
 *
 * @category serialization
 * @since 0.1.0
 * @slop
 */
export const canonical = (value: unknown): string => runSync(decodeCanonical(value))
