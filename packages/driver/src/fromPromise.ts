import { Effect } from "effect";
import type { ErrorWrapOptions } from "@smithers/errors/ErrorWrapOptions";
import type { SmithersError } from "@smithers/errors/SmithersError";
import { toError } from "./toError.ts";

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
