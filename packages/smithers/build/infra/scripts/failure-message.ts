/**
 * Failure rendering shared by the operator scripts.
 *
 * @since 0.1.0
 */

/**
 * Renders a failure for the operator without letting the failure run code.
 *
 * Only an `Error` whose `message` is a plain data property is rendered. An
 * accessor could execute on the way to the terminal, and a value that throws
 * when inspected, such as a revoked proxy, would replace the report with a
 * second failure, so both fall back to a fixed message instead.
 *
 * @category utilities
 * @since 0.1.0
 */
export const failureMessage = (value: unknown): string => {
  try {
    if (value instanceof Error) {
      const descriptor = Object.getOwnPropertyDescriptor(value, "message")
      if (descriptor !== undefined && "value" in descriptor && typeof descriptor.value === "string") {
        return descriptor.value
      }
    }
  } catch {
    // Fall through to the deliberately generic message.
  }
  return "unrenderable failure"
}
