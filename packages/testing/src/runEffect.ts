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
  // Effect-like: has pipe
  if (typeof (value as { pipe?: unknown }).pipe === "function") {
    const effectMod = await import("effect");
    const Effect = effectMod.Effect as {
      runPromise: (effect: unknown) => Promise<T>;
    };
    return Effect.runPromise(value);
  }
  return value as T;
}
