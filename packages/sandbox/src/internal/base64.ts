/**
 * Byte-faithful base64 for transports that can only carry text.
 *
 * @since 0.1.0
 */
import * as Effect from "effect/Effect"
import { ProviderError } from "../RemoteChildProcessSpawner/ProviderError.ts"

const decoder = new TextDecoder()
const encoder = new TextEncoder()

/**
 * Encodes bytes as base64 text.
 *
 * Most vendor sandbox APIs move files as strings, and a machine that cannot
 * move bytes cannot move a tarball, an image, or a compiled binary. Rather
 * than let each provider decide what to do about that, they all route the
 * byte path through this pair, so "the session promises bytes" stays true
 * whatever the transport underneath is willing to carry.
 *
 * `btoa` needs a binary string, which is why the bytes are widened one at a
 * time instead of being handed to `TextDecoder`: decoding as UTF-8 is exactly
 * the corruption this exists to avoid.
 *
 * @category constructors
 * @since 0.1.0
 */
export const encodeBase64 = (content: Uint8Array): string => {
  let binary = ""
  for (const byte of content) binary += String.fromCharCode(byte)
  return btoa(binary)
}

/**
 * Encodes bytes as base64 and returns the text as bytes, ready to be written
 * to a guest command's standard input.
 *
 * @category constructors
 * @since 0.1.0
 */
export const encodeBase64Bytes = (content: Uint8Array): Uint8Array => encoder.encode(encodeBase64(content))

/**
 * Decodes base64 text back to bytes, failing with the provider vocabulary
 * rather than throwing.
 *
 * Whitespace is stripped first because guest tools line-wrap their base64
 * output at various widths, and `atob` refuses a wrapped payload.
 *
 * @category constructors
 * @since 0.1.0
 */
export const decodeBase64 = (
  encoded: string,
  what: string
): Effect.Effect<Uint8Array, ProviderError> =>
  Effect.try({
    try: () => {
      const binary = atob(encoded.replaceAll(/\s/g, ""))
      const bytes = new Uint8Array(binary.length)
      for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index)
      return bytes
    },
    catch: (cause) =>
      new ProviderError({
        code: "unknown",
        message: `the sandbox returned invalid base64 ${what}`,
        cause
      })
  })

/**
 * Decodes base64 that arrived as bytes rather than text.
 *
 * @category constructors
 * @since 0.1.0
 */
export const decodeBase64Bytes = (
  encoded: Uint8Array,
  what: string
): Effect.Effect<Uint8Array, ProviderError> => decodeBase64(decoder.decode(encoded), what)
