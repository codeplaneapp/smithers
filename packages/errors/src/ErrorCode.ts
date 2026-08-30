/**
 * The error codes Smithers integration adapters raise, and their documentation.
 *
 * The table is the runtime source of truth: {@link SmithersErrorCode} is derived
 * from its keys, so adding a code and documenting it are the same edit. Smithers
 * 0.x carried 180 codes for an engine that no longer exists; 1.0 keeps only the
 * ones the `@smthrs/integrations` trees actually raise, because every other
 * package states its failures as `Schema.TaggedError` classes of its own.
 *
 * @since 1.0.0
 */

/**
 * The documentation page every code points at.
 *
 * @category constants
 * @since 1.0.0
 */
export const ERROR_REFERENCE_URL = "https://smithers.sh/reference/errors"

/**
 * What a code means and when it is raised.
 *
 * @category models
 * @since 1.0.0
 */
export interface SmithersErrorDefinition {
  readonly category: "integrations"
  readonly when: string
  readonly details?: string
}

/**
 * Every known code, with the condition that raises it.
 *
 * @category models
 * @since 1.0.0
 */
export const smithersErrorDefinitions = {
  INVALID_INPUT: {
    category: "integrations",
    when:
      "An integration helper receives an argument it cannot use: a missing bot token, an approval option key containing a colon, callback data over Telegram's 64-byte limit, or a non-https Mini App URL."
  },
  INTEGRATION_ERROR: {
    category: "integrations",
    when:
      "An integration client, webhook source, or listener reconciliation fails. `reason` classifies the failure so a caller can map it to a transport status.",
    details: "{ reason, ...providerSafeDetails }"
  },
  TELEGRAM_API_ERROR: {
    category: "integrations",
    when:
      "The Telegram Bot API answers a call with `ok: false`, a non-JSON body, or a transport failure. The bot token is redacted from the message and details.",
    details: "{ method, errorCode, description, retryAfterSeconds }"
  },
  TELEGRAM_INIT_DATA_INVALID: {
    category: "integrations",
    when:
      "Telegram Mini App `initData` is empty, expired, missing its hash or signature, or fails HMAC or Ed25519 verification."
  },
  UNSUPPORTED: {
    category: "integrations",
    when: "The runtime lacks a primitive an integration needs, such as Web Crypto or Ed25519 verification."
  }
} as const satisfies Record<string, SmithersErrorDefinition>

/**
 * A code this package documents.
 *
 * @category models
 * @since 1.0.0
 */
export type KnownSmithersErrorCode = keyof typeof smithersErrorDefinitions

/**
 * A code carried by a {@link SmithersError}. Unknown strings are accepted so a
 * consumer can raise its own without editing this package, but only a known
 * code has a definition.
 *
 * @category models
 * @since 1.0.0
 */
export type SmithersErrorCode = KnownSmithersErrorCode | (string & {})

/**
 * Every documented code, in declaration order.
 *
 * @category models
 * @since 1.0.0
 */
export const knownSmithersErrorCodes: ReadonlyArray<KnownSmithersErrorCode> = Object.keys(
  smithersErrorDefinitions
) as Array<KnownSmithersErrorCode>

/**
 * Whether `code` is one this package documents.
 *
 * @category refinements
 * @since 1.0.0
 */
export const isKnownSmithersErrorCode = (code: unknown): code is KnownSmithersErrorCode =>
  typeof code === "string" && Object.hasOwn(smithersErrorDefinitions, code)

/**
 * The definition for `code`, or `undefined` when it is not a documented code.
 *
 * @category getters
 * @since 1.0.0
 */
export const getSmithersErrorDefinition = (code: SmithersErrorCode): SmithersErrorDefinition | undefined =>
  isKnownSmithersErrorCode(code) ? smithersErrorDefinitions[code] : undefined

/**
 * The documentation URL for `code`.
 *
 * Every code currently shares one reference page. The parameter keeps the
 * signature stable for the day a code gets its own anchor.
 *
 * @category getters
 * @since 1.0.0
 */
export const getSmithersErrorDocsUrl = (code: SmithersErrorCode): string => {
  void code
  return ERROR_REFERENCE_URL
}
