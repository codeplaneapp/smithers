// Deep reviewed and polished by a human on 2026-08-31.

/**
 * Canonical flow-key derivation and stored-key validation.
 *
 * Deriving a key and parsing one from storage are deliberately separate
 * operations. {@link deriveKey} canonicalizes structured input and hashes it;
 * {@link StoredKey} validates an already-derived wire value without changing
 * it. {@link DerivedKey} provides the derivation as a schema transformation.
 *
 * @since 0.1.0
 */
import { Canonical } from "@smthrs/canonical"
import { type Digest as Sha256Digest, digest as sha256 } from "@smthrs/crypto"
import type * as Crypto from "effect/Crypto"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import * as SchemaGetter from "effect/SchemaGetter"
import * as SchemaIssue from "effect/SchemaIssue"

const keyV1Pattern = /^key1_[0-9a-f]{64}$/

/**
 * The exact persisted representation produced by the version-one derivation.
 *
 * Decoding validates and returns the input unchanged. It performs no hashing
 * and requires no `Crypto` service.
 *
 * @category schemas
 * @since 1.0.0
 */
export const KeyV1 = Schema.String.check(
  Schema.isPattern(keyV1Pattern, {
    expected: "key1_ followed by a 64-character lowercase hexadecimal SHA-256 digest"
  })
).pipe(Schema.brand("@smthrs/keys/Key"))

/**
 * A validated version-one stored key.
 *
 * @category models
 * @since 1.0.0
 */
export type KeyV1 = typeof KeyV1.Type

/**
 * Every stored-key representation this release understands.
 *
 * This is intentionally equal to {@link KeyV1}. A future format joins this
 * schema only when its complete representation and derivation are supported;
 * unknown `key<n>_` prefixes are rejected instead of guessed.
 *
 * @category schemas
 * @since 1.0.0
 */
export const StoredKey = KeyV1

/**
 * A stored key supported by this release.
 *
 * @category models
 * @since 1.0.0
 */
export type StoredKey = typeof StoredKey.Type

/**
 * Returns the validated SHA-256 payload of a stored key.
 *
 * Keeping prefix knowledge here prevents consumers from guessing at the wire
 * format with `slice` or delimiter searches.
 *
 * @category accessors
 * @since 1.0.0
 */
export const digest = (key: StoredKey): Sha256Digest => key.slice("key1_".length) as Sha256Digest

/**
 * Stable failure codes returned by {@link deriveKey}.
 *
 * @category schemas
 * @since 1.0.0
 */
export const KeyDerivationErrorCode = Schema.Literals([
  "canonicalization_failed",
  "digest_failed"
])

/**
 * Stable failure codes returned by {@link deriveKey}.
 *
 * @category models
 * @since 1.0.0
 */
export type KeyDerivationErrorCode = typeof KeyDerivationErrorCode.Type

/**
 * A safe, typed failure from canonicalization or injected hashing.
 *
 * `message` never contains the input. `cause` retains the original schema or
 * crypto failure for diagnostics.
 *
 * @category errors
 * @since 1.0.0
 */
export class KeyDerivationError extends Schema.TaggedError<KeyDerivationError>()(
  "@smthrs/keys/KeyDerivationError",
  {
    code: KeyDerivationErrorCode,
    message: Schema.String,
    cause: Schema.Unknown
  }
) {}

const derivationFailure = (
  code: KeyDerivationErrorCode,
  message: string,
  cause: unknown
): KeyDerivationError => new KeyDerivationError({ code, message, cause })

/**
 * Derives the current flow-key format from structured input.
 *
 * The input is serialized with {@link Canonical}, hashed as UTF-8 SHA-256
 * through the injected Effect `Crypto` service, and prefixed with `key1_`.
 * Callers should include a stable domain and version in structured key
 * material when identities from different protocols must not overlap.
 *
 * @category derivation
 * @since 1.0.0
 */
export const deriveKey = (
  input: unknown
): Effect.Effect<KeyV1, KeyDerivationError, Crypto.Crypto> =>
  Effect.gen(function*() {
    const serialized = yield* Schema.decodeUnknownEffect(Canonical)(input, {
      reportInput: false
    }).pipe(
      Effect.mapError((cause) =>
        derivationFailure(
          "canonicalization_failed",
          "Key input could not be canonicalized",
          cause
        )
      )
    )
    const hash = yield* sha256(serialized).pipe(
      Effect.mapError((cause) =>
        derivationFailure(
          "digest_failed",
          "Canonical key material could not be hashed",
          cause
        )
      )
    )

    return `key1_${hash}` as KeyV1
  })

const schemaIssue = (error: KeyDerivationError): SchemaIssue.InvalidValue =>
  new SchemaIssue.InvalidValue({
    message: `[${error.code}] ${error.message}`,
    code: error.code,
    cause: error
  })

/**
 * Schema that derives a fresh key from its decoded input.
 *
 * This does not parse stored keys: decoding the text `key1_…` derives a new
 * key from that text. Use {@link StoredKey} to validate persisted or received
 * key values. Prefer {@link deriveKey} when typed operational failures are
 * useful; this schema maps them to redacted schema issues for composition.
 *
 * @category transformations
 * @since 1.0.0
 */
export const DerivedKey = Schema.Unknown.pipe(
  Schema.decodeTo(KeyV1, {
    decode: SchemaGetter.transformOrFail((input) => deriveKey(input).pipe(Effect.mapError(schemaIssue))),
    encode: SchemaGetter.forbidden(
      () => "A key cannot be converted back into its input"
    )
  })
).annotate({
  identifier: "@smthrs/keys/Key",
  // Key material may contain secrets or large payloads. Never retain it in a
  // schema issue, even when an enclosing caller requests input reporting.
  parseOptions: { reportInput: false }
})
