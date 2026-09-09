/** Best-effort detail for an arbitrary thrown value. */
export const describe = (cause: unknown): string => {
  try {
    return String(cause instanceof Error ? cause.message : cause).slice(0, 1024)
  } catch {
    return "Unable to describe thrown value"
  }
}
