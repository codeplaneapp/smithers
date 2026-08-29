/**
 * Error mapping from thrown ZenFS/Node errors onto `PlatformError`.
 *
 * @since 0.1.0
 */
import * as PlatformError from "effect/PlatformError"

/**
 * `true` when the thrown value carries the given Node-style `code`.
 *
 * @private
 */
const hasCode = (cause: unknown, code: string): boolean =>
  typeof cause === "object" && cause !== null && "code" in cause && cause.code === code

/**
 * Map a thrown ZenFS/Node error onto a `PlatformError`, mirroring how effect's
 * own platform implementations construct one: a normalized `_tag`, the module
 * and method that failed, and the path. `ENOENT` is the only code worth
 * special-casing — `exists` and every `catchTag` in effect's `make` branch on
 * `NotFound`.
 *
 * @private
 * @since 0.1.0
 * @slop
 */
export const platformError = (method: string, path: string) => (cause: unknown): PlatformError.PlatformError =>
  PlatformError.systemError({
    _tag: hasCode(cause, "ENOENT") ? "NotFound" : hasCode(cause, "EEXIST") ? "AlreadyExists" : "Unknown",
    module: "FileSystem",
    method,
    pathOrDescriptor: path,
    description: cause instanceof Error ? cause.message : String(cause),
    cause
  })
