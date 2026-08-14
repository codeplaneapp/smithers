/**
 * Unwrap Smithers adapter Effects (or plain Promises) without a hard effect dep
 * at module-eval time — dynamic import keeps the package loadable.
 */

export async function runMaybeEffect<T>(value: unknown): Promise<T> {
  if (value == null) {
    return value as T;
  }
  // Thenable
  if (typeof (value as { then?: unknown }).then === "function") {
    return value as Promise<T>;
  }
  const { Effect } = await import("effect");
  if (Effect.isEffect(value)) {
    return Effect.runPromise(value as never) as Promise<T>;
  }
  return value as T;
}
