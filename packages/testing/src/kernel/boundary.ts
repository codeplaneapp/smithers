import { Cause, Effect, Exit, Fiber, Option, Result } from "effect";
export type HarnessError = Readonly<{
  readonly name: string;
  readonly code: string;
  readonly message: string;
  readonly fidelity?: "simulation" | "native";
  readonly tag?: string;
  readonly summary?: string;
  readonly docsUrl?: string;
  readonly serialized?: unknown;
  readonly details?: unknown;
  readonly cause?: unknown;
}>;
export const toHarnessError = (error: unknown): HarnessError => {
  if (error && typeof error === "object") {
    const value = error as Record<string, unknown>;
    return {
      name: String(value.name ?? error.constructor?.name ?? "Error"),
      code: String(value.code ?? "HARNESS_ERROR"),
      message: String(value.message ?? error),
      ...(value.fidelity === "simulation" || value.fidelity === "native" ? { fidelity: value.fidelity } : {}),
      ...(typeof value.tag === "string" ? { tag: value.tag } : {}),
      ...(typeof value.summary === "string" ? { summary: value.summary } : {}),
      ...(typeof value.docsUrl === "string" ? { docsUrl: value.docsUrl } : {}),
      ...(value.serialized === undefined ? {} : { serialized: value.serialized }),
      ...(value.details === undefined ? {} : { details: value.details }),
      ...(value.cause === undefined ? {} : { cause: toHarnessError(value.cause) }),
    };
  }
  return { name: "Error", code: "HARNESS_ERROR", message: String(error) };
};
const squashCause = <E>(cause: Cause.Cause<E>): unknown => {
  const failure = Cause.findErrorOption(cause);
  if (Option.isSome(failure)) return failure.value;
  const defect = Cause.findDefect(cause);
  return Result.isSuccess(defect) ? defect.success : new Error("kernel program failed");
};
export const runAtBoundary = async <A, E = unknown>(
  program: Effect.Effect<A, E>,
): Promise<{ readonly ok: true; readonly value: A } | { readonly ok: false; readonly error: HarnessError }> => {
  const exit = await Effect.runPromise(Effect.exit(program));
  if (Exit.isSuccess(exit)) return { ok: true, value: exit.value };
  return { ok: false, error: toHarnessError(squashCause(exit.cause)) };
};
/** Internal runner used by the bounded public boundary so a timeout can cancel the live Effect fiber. */
export const runAtBoundaryFork = <A, E = unknown>(program: Effect.Effect<A, E>) => {
  const fiber = Effect.runFork(Effect.exit(program));
  const promise = Effect.runPromise(Fiber.join(fiber)).then((exit) => {
    if (Exit.isSuccess(exit)) return { ok: true as const, value: exit.value };
    return { ok: false as const, error: toHarnessError(squashCause(exit.cause)) };
  });
  return { promise, interrupt: () => Effect.runPromise(Fiber.interrupt(fiber)) };
};
export const runKernelAtBoundary = async <A>(
  run: () => A | Promise<A>,
): Promise<{ readonly ok: true; readonly value: A } | { readonly ok: false; readonly error: HarnessError }> => {
  const exit = await Effect.runPromise(
    Effect.exit(Effect.tryPromise({ try: async () => await run(), catch: (error) => error })),
  );
  return Exit.isSuccess(exit)
    ? { ok: true, value: exit.value }
    : {
        ok: false,
        error: toHarnessError(squashCause(exit.cause)),
      };
};
