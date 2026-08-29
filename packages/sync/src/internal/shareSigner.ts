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

const encoder = new TextEncoder()

/**
 * Length-prefixes each field so no two distinct field sequences share an
 * encoding.
 *
 * @category encoding
 * @since 0.1.0
 */
export const lengthPrefixed = (fields: ReadonlyArray<string>): string =>
  fields.map((field) => `${field.length}:${field}`).join("")

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
      new SyncError({ code: "unknown", message: "Web Crypto could not import the HMAC signing key", cause })
  })

/**
 * Signs a canonical claim encoding, returning the signature as lowercase hex.
 *
 * @category crypto
 * @since 0.1.0
 */
export const signHmac = (key: CryptoKey, canonical: string): Effect.Effect<string, SyncError> =>
  Effect.map(
    Effect.tryPromise({
      try: () => crypto.subtle.sign("HMAC", key, encoder.encode(canonical)),
      catch: (cause) => new SyncError({ code: "unknown", message: "Web Crypto could not sign the share claims", cause })
    }),
    (signature) => hex(new Uint8Array(signature))
  )
