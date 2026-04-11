import { Effect } from "effect";
import {
  type ErrorWrapOptions,
  type SmithersError,
  toSmithersError,
} from "./errors.ts";

export function toError(
  cause: unknown,
  label?: string,
  options: ErrorWrapOptions = {},
): SmithersError {
  return toSmithersError(cause, label, options);
}

export function fromPromise<A>(
  label: string,
  evaluate: () => PromiseLike<A>,
  options: ErrorWrapOptions = {},
): Effect.Effect<A, SmithersError> {
  return Effect.tryPromise({
    try: () => evaluate(),
    catch: (cause) => toError(cause, label, options),
  });
}

export function fromSync<A>(
  label: string,
  evaluate: () => A,
  options: ErrorWrapOptions = {},
): Effect.Effect<A, SmithersError> {
  return Effect.try({
    try: () => evaluate(),
    catch: (cause) => toError(cause, label, options),
  });
}

export function ignoreSyncError(
  _label: string,
  fn: () => void,
): Effect.Effect<void> {
  return Effect.sync(() => {
    try {
      fn();
    } catch {
      // Best-effort cleanup intentionally swallows failures.
    }
  });
}
