/**
 * Bounded diagnostics for failures that cross the control wire boundary.
 *
 * @since 0.1.0
 */
import { CanonicalError } from "@smthrs/canonical"
import type * as Schema from "effect/Schema"
import type * as SchemaIssue from "effect/SchemaIssue"

const maximumIssueLength = 512

/**
 * Joins a stable location and reason without allowing an RPC error to grow
 * without bound.
 *
 * @internal
 * @since 0.1.0
 */
export const cappedIssue = (path: string, reason: string): string => {
  const issue = `${path}: ${reason}`
  return issue.length <= maximumIssueLength ? issue : `${issue.slice(0, maximumIssueLength - 3)}...`
}

/**
 * Renders canonical's stable located failure without copying its rejected
 * value or a nested cause message into an RPC error.
 *
 * @internal
 * @since 0.1.0
 */
export const canonicalIssue = (cause: unknown): string =>
  cause instanceof CanonicalError
    ? cappedIssue(cause.path, cause.code)
    : cappedIssue("$", "canonicalization failed")

const renderPath = (segments: ReadonlyArray<PropertyKey>): string =>
  segments.reduce<string>(
    (path, segment) => path + (typeof segment === "number" ? `[${segment}]` : `.${String(segment)}`),
    "$"
  )

/**
 * Finds the first rejected field in an Effect schema error without rendering
 * the value stored at that field.
 *
 * @internal
 * @since 0.1.0
 */
export const schemaIssuePath = (error: Schema.SchemaError): string => {
  const segments: Array<PropertyKey> = []
  let issue: SchemaIssue.Issue = error.issue
  for (let depth = 0; depth < 64; depth++) {
    switch (issue._tag) {
      case "Pointer":
        segments.push(...issue.path)
        issue = issue.issue
        continue
      case "Filter":
      case "Encoding":
        issue = issue.issue
        continue
      case "Composite":
      case "AnyOf": {
        const first = issue.issues[0]
        if (first === undefined) return renderPath(segments)
        issue = first
        continue
      }
      default:
        return renderPath(segments)
    }
  }
  return renderPath(segments)
}
