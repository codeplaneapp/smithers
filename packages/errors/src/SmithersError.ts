/**
 * The error class the integration adapters raise.
 *
 * `SmithersError` carries a machine-readable {@link SmithersErrorCode}, a
 * human summary, provider-safe `details`, and a documentation URL appended to
 * the message. Adapters subclass it to add their own typed fields; callers
 * classify with the code rather than by matching message text.
 *
 * @since 1.0.0
 */
import { getSmithersErrorDocsUrl, type SmithersErrorCode } from "./ErrorCode.ts"

/**
 * Construction options for a {@link SmithersError}.
 *
 * @category models
 * @since 1.0.0
 */
export interface SmithersErrorOptions {
  readonly cause?: unknown
  /** Set `false` to leave the documentation URL out of the message. */
  readonly includeDocsUrl?: boolean
  /** The `name` the error reports. Defaults to `"SmithersError"`. */
  readonly name?: string
}

/**
 * A Smithers integration failure.
 *
 * @category errors
 * @since 1.0.0
 */
export class SmithersError extends Error {
  /** The machine-readable classification. */
  readonly code: SmithersErrorCode
  /** The message without the appended documentation URL. */
  readonly summary: string
  /** Where the code is documented. */
  readonly docsUrl: string
  /** Provider-safe context. Never carries credentials. */
  readonly details: Record<string, unknown> | undefined
  override readonly name: string

  constructor(
    code: SmithersErrorCode,
    summary: string,
    details?: Record<string, unknown>,
    options: SmithersErrorOptions = {}
  ) {
    const docsUrl = getSmithersErrorDocsUrl(code)
    const message = options.includeDocsUrl === false || summary.includes(docsUrl)
      ? summary
      : `${summary} See ${docsUrl}`
    super(message, { cause: options.cause })
    // Subclasses reach here through `super`, so `new.target` is what restores
    // their prototype after `Error` resets it under a transpiled target.
    Object.setPrototypeOf(this, new.target.prototype)
    this.name = options.name ?? "SmithersError"
    this.code = code
    this.summary = summary
    this.docsUrl = docsUrl
    this.details = details
  }
}

/**
 * Whether `value` is a {@link SmithersError}.
 *
 * @category refinements
 * @since 1.0.0
 */
export const isSmithersError = (value: unknown): value is SmithersError => value instanceof SmithersError
