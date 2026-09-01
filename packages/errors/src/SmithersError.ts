/**
 * The error class the integration adapters raise.
 *
 * `SmithersError` carries a machine-readable {@link KnownSmithersErrorCode}, a
 * human summary, caller-supplied `details`, and a documentation URL appended
 * to the message. It stores context verbatim and does not redact it.
 * Integration adapters must remove credentials before constructing it.
 * Adapters subclass it to add their own typed fields; callers classify with
 * the code rather than by matching message text.
 *
 * @since 1.0.0
 */
import { getSmithersErrorDocsUrl, isKnownSmithersErrorCode, type KnownSmithersErrorCode } from "./ErrorCode.ts"

/**
 * Construction options for a {@link SmithersError}.
 *
 * @category models
 * @since 1.0.0
 */
export interface SmithersErrorOptions {
  /**
   * Stored verbatim and not redacted. A cause of `undefined` is treated as no
   * cause, so the instance has no own `cause` property and a log or
   * `util.inspect` output has no `[cause]` line. A subclass may therefore
   * always include the key. Redact provider text such as a bot token in a URL
   * or an API key in a message before attaching it.
   */
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
  readonly code: KnownSmithersErrorCode
  /** The message without the appended documentation URL. */
  readonly summary: string
  /** Where the code is documented. */
  readonly docsUrl: string
  /**
   * Caller-supplied context. The top-level record is copied and frozen at
   * construction, so adding, removing, or replacing a top-level key on the
   * caller's object afterwards cannot change it. Nested values are shared by
   * reference and are not deep-frozen, so a caller must not mutate an attached
   * nested record. Callers must redact credentials.
   */
  readonly details: Readonly<Record<string, unknown>> | undefined
  override readonly name: string

  constructor(
    code: KnownSmithersErrorCode,
    summary: string,
    details?: Record<string, unknown>,
    options: SmithersErrorOptions = {}
  ) {
    const docsUrl = getSmithersErrorDocsUrl()
    const suffix = ` See ${docsUrl}`
    let summaryWithoutDocsUrl = summary
    for (;;) {
      const candidate = summaryWithoutDocsUrl.trimEnd()
      if (!candidate.endsWith(suffix)) break
      summaryWithoutDocsUrl = candidate.slice(0, -suffix.length).trimEnd()
    }
    const message = options.includeDocsUrl === false || summaryWithoutDocsUrl.trim() === ""
      ? summaryWithoutDocsUrl
      : `${summaryWithoutDocsUrl}${suffix}`
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined)
    // Subclasses reach here through `super`, so `new.target` is what restores
    // their prototype after `Error` resets it under a transpiled target.
    Object.setPrototypeOf(this, new.target.prototype)
    this.name = options.name ?? "SmithersError"
    this.code = code
    this.summary = summaryWithoutDocsUrl
    this.docsUrl = docsUrl
    this.details = details === undefined ? undefined : Object.freeze({ ...details })
  }
}

/**
 * Whether `value` is a {@link SmithersError}.
 *
 * This refinement uses `instanceof` only. It does not detect an instance
 * produced by a duplicate copy of this package.
 *
 * @category refinements
 * @since 1.0.0
 */
export const isSmithersError = (value: unknown): value is SmithersError => value instanceof SmithersError

/**
 * Whether `value` has the structural fields of a {@link SmithersError}.
 *
 * Use this refinement when a consumer must accept an instance produced by
 * another module instance and needs more assurance than a forgeable `name`
 * check. The value must still be an `Error` with a code from the documented
 * closed vocabulary and string summary and documentation URL fields.
 *
 * @category refinements
 * @since 1.0.0
 */
export const hasSmithersErrorShape = (value: unknown): value is SmithersError =>
  value instanceof Error &&
  isKnownSmithersErrorCode((value as SmithersError).code) &&
  typeof (value as SmithersError).summary === "string" &&
  typeof (value as SmithersError).docsUrl === "string"
