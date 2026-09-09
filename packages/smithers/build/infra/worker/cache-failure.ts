/**
 * Fixed diagnostics for internal cache refusals.
 *
 * @since 0.1.0
 */

/**
 * An internally authored refusal with stable, payload-free diagnostic fields.
 *
 * Codes and operations are fixed at call sites. Messages remain useful to
 * direct adapter callers but are never included in Worker request logs.
 *
 * @category errors
 * @since 0.1.0
 */
export class CacheFailure extends Error {
  readonly code: string
  readonly operation:
    | "actionCache.get"
    | "actionCache.put"
    | "actionCache.delete"
    | "contentStore.get"
    | "contentStore.has"
    | "contentStore.put"
    | "contentStore.presentDigests"
    | "credentialBudget.charge"
    | "health"
    | "wait"
    | "r2.validate"
    | "retention"

  constructor(code: string, operation: CacheFailure["operation"], message: string, options?: ErrorOptions) {
    super(message, options)
    this.code = code
    this.operation = operation
  }
}
