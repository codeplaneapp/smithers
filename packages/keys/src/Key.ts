// Deep reviewed and polished by a human on 2026-08-10.

/**
 * The canonical flow key: `key1_` followed by a SHA-256 digest.
 *
 * A key is how `flows` names work — the step cache, the attempt rows, and the
 * plan all address by it — so it must be derivable from the value alone and
 * identical on every host. That is why it is a digest of the value's
 * {@link Canonical} RFC 8785 form rather than of whatever `JSON.stringify`
 * happened to produce.
 *
 * The `key1_` prefix is a version marker. A future derivation gets `key2_`,
 * and both remain decodable, so a stored key never becomes ambiguous about
 * which scheme produced it.
 *
 * @since 0.1.0
 */
import { Canonical } from "@smthrs/canonical/Canonical"
import { Sha256 } from "@smthrs/crypto"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import * as SchemaGetter from "effect/SchemaGetter"

/**
 * Validated storage representation of a key.
 *
 * The pattern accepts any version marker, not just `key1_`: the marker exists
 * so a stored key from a future derivation scheme stays readable, and a
 * pattern anchored to one version would refuse exactly the keys the marker
 * promises to keep decodable. Only decoding — deriving a fresh key from a
 * value — is pinned to the current scheme.
 *
 * @private
 * @since 0.1.0
 */
const KeyValue = Schema.String.check(Schema.isPattern(/^key[1-9][0-9]*_[0-9a-f]{64}$/)).pipe(
  Schema.brand("@smthrs/keys/Key")
)

/**
 * A versioned key: a `key<n>_` version marker followed by a lowercase
 * hexadecimal SHA-256 digest. The current derivation produces `key1_`;
 * validation accepts every version so stored keys stay readable.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export type Key = typeof Key.Type

/**
 * One-way schema transformation from any canonical JSON value to a `Key`.
 *
 * The input is serialized with RFC 8785 canonical JSON and hashed through
 * the injected Effect `Crypto` service. Decoding therefore requires `Crypto`.
 * The key cannot be encoded back into the value that produced it.
 *
 * @category transformations
 * @since 0.1.0
 * @slop
 */
export const Key = Schema.Unknown.pipe(
  Schema.decodeTo(KeyValue, {
    decode: SchemaGetter.transformOrFail((input) =>
      Effect.gen(function*() {
        const serialized = yield* Schema.decodeUnknownEffect(Canonical)(input).pipe(
          Effect.mapError((error) => error.issue)
        )
        const digest = yield* Schema.decodeUnknownEffect(Sha256)(serialized).pipe(
          Effect.mapError((error) => error.issue)
        )
        return `key1_${digest}`
      })
    ),
    encode: SchemaGetter.forbidden(() => "A key cannot be converted back into its input")
  })
)
