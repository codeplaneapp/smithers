/**
 * HMAC-SHA-256 signing primitives shared by the branch and workspace share
 * authorities.
 *
 * Both authorities sign a length-prefixed encoding of their claims: without
 * length prefixes a field ending in the separator could be re-cut into a
 * different, still-validly-signed claim set. Web Crypto is used directly so
 * the same module runs in the browser and on node, and signature comparison
 * is length-independent so a check leaks no prefix length.
 *
 * @since 0.1.0
 */
import * as Effect from "effect/Effect"
import { SyncError } from "../SyncError.ts"
import { causeText } from "./causeText.ts"

const encoder = new TextEncoder()

/**
 * Length-prefixes each field so no two distinct field sequences share an
 * encoding.
 *
 * The prefix counts UTF-8 BYTES, not UTF-16 code units, because the bytes are
 * what {@link signHmac} covers. Counting code units let a two-byte field claim
 * length one, so the prefix no longer separated the fields the signature was
 * taken over.
 *
 * @category encoding
 * @since 0.1.0
 */
export const lengthPrefixed = (fields: ReadonlyArray<string>): string =>
  fields.map((field) => `${encoder.encode(field).length}:${field}`).join("")

const decoder = new TextDecoder()

/**
 * Whether a string is exactly what its own UTF-8 bytes decode back to.
 *
 * `TextEncoder` replaces every unpaired surrogate with U+FFFD, so two claim
 * sets differing only in a lone surrogate sign to identical bytes: a
 * capability minted for a lone-surrogate branch id verifies after its
 * `branchId` is rewritten to U+FFFD, which names a different branch. A length
 * prefix cannot separate them either, because both encode to the same three
 * bytes. The only correct answer is to refuse such a claim set before it is
 * signed, and the round trip is the exact question — does this string survive
 * the encoding the signature is taken over — rather than a proxy for it.
 *
 * @category encoding
 * @since 1.0.0-rc.0
 */
export const utf8RoundTrips = (value: string, bytes: Uint8Array): boolean => decoder.decode(bytes) === value

/**
 * Renders signature bytes as lowercase hex.
 *
 * @category encoding
 * @since 0.1.0
 */
export const hex = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")

/**
 * Length-independent comparison, so a signature check leaks no prefix length.
 *
 * @category comparison
 * @since 0.1.0
 */
export const constantTimeEquals = (left: string, right: string): boolean => {
  let difference = left.length ^ right.length
  // `charCodeAt` past the end is NaN, and `NaN | 0` is 0, so the loop reads
  // both strings to the longer length without an early return.
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    difference |= (left.charCodeAt(index) | 0) ^ (right.charCodeAt(index) | 0)
  }
  return difference === 0
}

/**
 * Imports a raw secret as a non-extractable Web Crypto HMAC-SHA-256 signing
 * key. Fails with a `SyncError` carrying the rejection as `cause` when Web
 * Crypto refuses the import.
 *
 * @category crypto
 * @since 0.1.0
 */
export const importHmacKey = (secret: string): Effect.Effect<CryptoKey, SyncError> =>
  Effect.tryPromise({
    try: () =>
      crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
        "sign"
      ]),
    catch: (cause) =>
      new SyncError({
        code: "unknown",
        message: "Web Crypto could not import the HMAC signing key",
        cause: causeText(cause)
      })
  })

/**
 * Signs a canonical claim encoding, returning the signature as lowercase hex.
 *
 * @category crypto
 * @since 0.1.0
 */
export const signHmac = (key: CryptoKey, canonical: string): Effect.Effect<string, SyncError> => {
  const bytes = encoder.encode(canonical)
  if (!utf8RoundTrips(canonical, bytes)) {
    return Effect.fail(
      new SyncError({
        code: "invalid_request",
        message: "Share claims carry an unpaired surrogate and cannot be signed"
      })
    )
  }
  return Effect.map(
    Effect.tryPromise({
      try: () => crypto.subtle.sign("HMAC", key, bytes),
      catch: (cause) =>
        new SyncError({
          code: "unknown",
          message: "Web Crypto could not sign the share claims",
          cause: causeText(cause)
        })
    }),
    (signature) => hex(new Uint8Array(signature))
  )
}
