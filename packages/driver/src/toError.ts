import type { ErrorWrapOptions } from "@smithers/errors/ErrorWrapOptions";
import type { SmithersError } from "@smithers/errors/SmithersError";
import { toSmithersError } from "@smithers/errors/toSmithersError";

export function toError(
  cause: unknown,
  label?: string,
  options: ErrorWrapOptions = {},
): SmithersError {
  return toSmithersError(cause, label, options);
}
